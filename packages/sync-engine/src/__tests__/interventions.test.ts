/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { buildIntervention } from "@prehospital-ems/fhir-contracts";
import { db } from "../db.js";
import { enqueue, initSyncWorker, flush } from "../syncWorker.js";

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const fetchCalls: Array<{ url: string; body: string }> = [];

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

describe("interventions — enqueue/flush against one encounter", () => {
  it("flushes Patient + Encounter first, then resolves refs on the intervention resources", async () => {
    const mockFetch = vi.fn(async (url: string, opts: { body: string }) => {
      fetchCalls.push({ url, body: opts.body });
      const id = url.endsWith("/Patient") ? "srv-patient-uuid"
        : url.endsWith("/Encounter") ? "srv-encounter-uuid"
        : `srv-${fetchCalls.length}`;
      return { ok: true, status: 200, json: async () => ({ id, meta: { lastUpdated: new Date(Date.now() - 1000).toISOString() } }) };
    });
    define("fetch", mockFetch);

    const mrn = "PROV-ccc33333";
    const encId = "ENC-ddd44444";

    await enqueue({
      id: crypto.randomUUID(), resourceType: "Patient", resourceId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
    });
    await enqueue({
      id: crypto.randomUUID(), resourceType: "Encounter", resourceId: encId, patientId: mrn,
      body: JSON.stringify({ resourceType: "Encounter", id: encId, subject: { reference: `Patient/${mrn}` } }),
    });

    // A medication and a procedure, both referencing the still-provisional ids.
    const med = buildIntervention(
      { key: "aspirin" },
      { patientServerUUID: mrn, encounterServerUUID: encId },
    );
    const proc = buildIntervention(
      { key: "oxygen" },
      { patientServerUUID: mrn, encounterServerUUID: encId },
    );
    for (const resource of [med, proc]) {
      await enqueue({
        id: crypto.randomUUID(), resourceType: resource.resourceType, resourceId: crypto.randomUUID(),
        body: JSON.stringify(resource), patientId: mrn, encounterId: encId,
      });
    }

    initSyncWorker({ fhirBaseUrl: "https://fhir.test/R4", authHeader: "Basic test" });
    await flush();

    // Queue drained, nothing dead-lettered.
    expect(await db.writeQueue.count()).toBe(0);
    expect(await db.deadLetter.count()).toBe(0);

    // Ordering: Patient + Encounter POST before either intervention resource.
    const order = fetchCalls.map((c) => c.url.split("/R4/")[1]);
    const lastBootstrap = Math.max(order.indexOf("Patient"), order.indexOf("Encounter"));
    const firstDependent = Math.min(
      order.indexOf("MedicationAdministration"),
      order.indexOf("Procedure"),
    );
    expect(lastBootstrap).toBeLessThan(firstDependent);

    // The MedicationAdministration links the encounter via `context`, with refs resolved.
    const medBody = fetchCalls.find((c) => c.url.endsWith("/MedicationAdministration"))!.body;
    expect(medBody).toContain("Patient/srv-patient-uuid");
    expect(medBody).toContain("Encounter/srv-encounter-uuid");
    expect(medBody).not.toContain(mrn);
    expect(medBody).not.toContain(encId);

    // The Procedure links the encounter via `encounter`, with refs resolved.
    const procBody = fetchCalls.find((c) => c.url.endsWith("/Procedure"))!.body;
    expect(procBody).toContain("Patient/srv-patient-uuid");
    expect(procBody).toContain("Encounter/srv-encounter-uuid");
    expect(procBody).not.toContain(encId);
  });
});
