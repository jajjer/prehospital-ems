/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { db } from "../db.js";
import { enqueue, initSyncWorker, flush } from "../syncWorker.js";

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** Capture every POSTed body keyed by target resource type. */
const fetchCalls: Array<{ url: string; body: string }> = [];

/** Mock fetch that returns a deterministic server UUID per resource type. */
function installMockFetch(idForUrl: (url: string) => string): void {
  define("fetch", vi.fn(async (url: string, opts: { body: string }) => {
    fetchCalls.push({ url, body: opts.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: idForUrl(url), meta: { lastUpdated: new Date(Date.now() - 1000).toISOString() } }),
    };
  }));
}

beforeAll(() => {
  define("window", { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true });
  define("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" });
  define("navigator", { onLine: true });
  define("CustomEvent", class { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } });
});

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.writeQueue.clear(),
    db.deadLetter.clear(),
    db.identityMap.clear(),
    db.captureLog.clear(),
  ]);
  fetchCalls.length = 0;
});

describe("resolveReferences — keyed, targeted FHIR reference rewriting", () => {
  it("rewrites subject + encounter references on a dependent Observation", async () => {
    const mrn = "PROV-aaa11111";
    const encId = "ENC-bbb22222";

    await enqueue({
      id: crypto.randomUUID(), resourceType: "Patient", resourceId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
    });
    await enqueue({
      id: crypto.randomUUID(), resourceType: "Encounter", resourceId: encId, patientId: mrn,
      body: JSON.stringify({ resourceType: "Encounter", id: encId, subject: { reference: `Patient/${mrn}` } }),
    });
    await enqueue({
      id: crypto.randomUUID(), resourceType: "Observation", resourceId: crypto.randomUUID(),
      patientId: mrn, encounterId: encId,
      body: JSON.stringify({
        resourceType: "Observation",
        subject: { reference: `Patient/${mrn}`, type: "Patient" },
        encounter: { reference: `Encounter/${encId}`, type: "Encounter" },
      }),
    });

    installMockFetch((url) =>
      url.endsWith("/Patient") ? "srv-patient" : url.endsWith("/Encounter") ? "srv-encounter" : "srv-obs");

    initSyncWorker({ fhirBaseUrl: "https://fhir.test/R4", authHeader: "Basic test" });
    await flush();

    const obs = fetchCalls.find((c) => c.url.endsWith("/Observation"))!;
    expect(obs.body).toContain("Patient/srv-patient");
    expect(obs.body).toContain("Encounter/srv-encounter");
    expect(obs.body).not.toContain(mrn);
    expect(obs.body).not.toContain(encId);
    // The Encounter's own subject was resolved too.
    const enc = fetchCalls.find((c) => c.url.endsWith("/Encounter"))!;
    expect(enc.body).toContain("Patient/srv-patient");
  });

  it("does NOT corrupt a value containing a provisional id as a substring", async () => {
    // Adversarial: the patient's provisional id is a substring of the encounter's.
    // A blind replaceAll over the JSON string would mangle the encounter id and the
    // free-text note. Keyed, segment-targeted rewriting must leave both intact.
    const shortMrn = "P1";
    const encId = "P10"; // contains "P1" as a prefix substring

    await db.identityMap.bulkPut([
      { provisionalId: shortMrn, serverUUID: "srv-patient-uuid", resourceType: "Patient", resolvedAt: Date.now() },
      { provisionalId: encId, serverUUID: "srv-encounter-uuid", resourceType: "Encounter", resolvedAt: Date.now() },
    ]);

    await enqueue({
      id: crypto.randomUUID(), resourceType: "Condition", resourceId: crypto.randomUUID(),
      patientId: shortMrn, encounterId: encId,
      body: JSON.stringify({
        resourceType: "Condition",
        subject: { reference: `Patient/${shortMrn}`, type: "Patient" },
        encounter: { reference: `Encounter/${encId}`, type: "Encounter" },
        // Free text that embeds the provisional id as a substring of a word.
        note: [{ text: "Pain on bed P1A, no relief" }],
      }),
    });

    installMockFetch(() => "srv-condition");
    initSyncWorker({ fhirBaseUrl: "https://fhir.test/R4", authHeader: "Basic test" });
    await flush();

    const cond = JSON.parse(fetchCalls.find((c) => c.url.endsWith("/Condition"))!.body) as {
      subject: { reference: string };
      encounter: { reference: string };
      note: Array<{ text: string }>;
    };
    expect(cond.subject.reference).toBe("Patient/srv-patient-uuid");
    // Encounter id "P10" must NOT become "srv-patient-uuid0".
    expect(cond.encounter.reference).toBe("Encounter/srv-encounter-uuid");
    // Free text must be left exactly as written.
    expect(cond.note[0]!.text).toBe("Pain on bed P1A, no relief");
  });

  it("only rewrites the id segment, never the resource-type segment", async () => {
    // A provisional id that is identical to a resource-type name must not cause
    // the "Patient/" type prefix to be rewritten.
    const mrn = "Patient";
    await db.identityMap.put({ provisionalId: mrn, serverUUID: "srv-uuid", resourceType: "Patient", resolvedAt: Date.now() });

    await enqueue({
      id: crypto.randomUUID(), resourceType: "Observation", resourceId: crypto.randomUUID(),
      patientId: mrn,
      body: JSON.stringify({ resourceType: "Observation", subject: { reference: `Patient/${mrn}` } }),
    });

    installMockFetch(() => "srv-obs");
    initSyncWorker({ fhirBaseUrl: "https://fhir.test/R4", authHeader: "Basic test" });
    await flush();

    const obs = JSON.parse(fetchCalls.find((c) => c.url.endsWith("/Observation"))!.body) as {
      subject: { reference: string };
    };
    expect(obs.subject.reference).toBe("Patient/srv-uuid");
  });

  it("leaves references with no identity-map entry unchanged", async () => {
    // Location references point at real server UUIDs and are never provisional.
    await enqueue({
      id: crypto.randomUUID(), resourceType: "Observation", resourceId: crypto.randomUUID(),
      body: JSON.stringify({
        resourceType: "Observation",
        subject: { reference: "Patient/unknown-prov" },
        performer: [{ reference: "Location/real-location-uuid" }],
      }),
    });

    installMockFetch(() => "srv-obs");
    initSyncWorker({ fhirBaseUrl: "https://fhir.test/R4", authHeader: "Basic test" });
    await flush();

    const obs = JSON.parse(fetchCalls.find((c) => c.url.endsWith("/Observation"))!.body) as {
      subject: { reference: string };
      performer: Array<{ reference: string }>;
    };
    expect(obs.subject.reference).toBe("Patient/unknown-prov");
    expect(obs.performer[0]!.reference).toBe("Location/real-location-uuid");
  });
});
