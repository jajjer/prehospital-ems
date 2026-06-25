/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { db } from "../db.js";
import { initSyncWorker, finalizeEncounter } from "../syncWorker.js";
import { logCapture } from "../captureLog.js";

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

interface FetchCall { url: string; method: string; body: string | undefined }
const fetchCalls: FetchCall[] = [];

beforeAll(() => {
  define("window", { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true });
  define("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" });
  define("navigator", { onLine: true });
  define("CustomEvent", class { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } });
});

beforeEach(async () => {
  await db.open();
  await Promise.all([db.identityMap.clear(), db.captureLog.clear()]);
  fetchCalls.length = 0;
});

function installFetch(res: { ok: boolean; throws?: boolean }): void {
  define("fetch", vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
    fetchCalls.push({ url, method: opts?.method ?? "GET", body: opts?.body });
    if (res.throws) throw new Error("offline");
    return { ok: res.ok, status: res.ok ? 200 : 500, json: async () => ({}) };
  }));
}

const init = () => initSyncWorker({ fhirBaseUrl: "https://fhir.test/R4", authHeader: "Basic test" });

describe("finalizeEncounter", () => {
  it("joined call: PATCHes the server encounter UUID directly (no identity-map lookup)", async () => {
    const mrn = "PROV-join0001";
    await logCapture({
      mrn, capturedAt: Date.now(), sex: "male", approximateAge: 50, complaint: "MVC",
      vitalsJson: "{}", submissionStatus: "complete",
      encounterId: "server-enc-uuid", joined: true, patientRef: "server-patient-uuid",
    });

    installFetch({ ok: true });
    init();
    const result = await finalizeEncounter(mrn);

    expect(result).toBe("ok");
    const patch = fetchCalls[0]!;
    expect(patch.method).toBe("PATCH");
    expect(patch.url).toBe("https://fhir.test/R4/Encounter/server-enc-uuid");
    expect(patch.body).toContain('"value":"finished"');
    // Handoff timestamp recorded locally.
    expect((await db.captureLog.get(mrn))?.handoffAt).toBeTypeOf("number");
  });

  it("own capture: resolves the provisional encounter id through the identity map", async () => {
    const mrn = "PROV-own00001";
    const provEnc = "ENC-own00001";
    await db.identityMap.put({ provisionalId: provEnc, serverUUID: "resolved-enc-uuid", resourceType: "Encounter", resolvedAt: Date.now() });
    await logCapture({
      mrn, capturedAt: Date.now(), sex: "female", approximateAge: 33, complaint: "fall",
      vitalsJson: "{}", submissionStatus: "complete", encounterId: provEnc,
    });

    installFetch({ ok: true });
    init();
    const result = await finalizeEncounter(mrn);

    expect(result).toBe("ok");
    expect(fetchCalls[0]!.url).toBe("https://fhir.test/R4/Encounter/resolved-enc-uuid");
  });

  it("returns not-synced when the encounter has not been uploaded yet", async () => {
    const mrn = "PROV-pending1";
    await logCapture({
      mrn, capturedAt: Date.now(), sex: "unknown", approximateAge: undefined, complaint: "",
      vitalsJson: "{}", submissionStatus: "complete", encounterId: "ENC-not-resolved",
    });

    installFetch({ ok: true });
    init();
    expect(await finalizeEncounter(mrn)).toBe("not-synced");
    // No network call — there's nothing to PATCH.
    expect(fetchCalls).toHaveLength(0);
  });

  it("returns not-synced when there is no capture record at all", async () => {
    installFetch({ ok: true });
    init();
    expect(await finalizeEncounter("PROV-missing")).toBe("not-synced");
    expect(fetchCalls).toHaveLength(0);
  });

  it("returns network-error when the PATCH throws", async () => {
    const mrn = "PROV-neterr01";
    await logCapture({
      mrn, capturedAt: Date.now(), sex: "male", approximateAge: 20, complaint: "x",
      vitalsJson: "{}", submissionStatus: "complete", encounterId: "srv-enc", joined: true,
    });
    installFetch({ ok: false, throws: true });
    init();
    expect(await finalizeEncounter(mrn)).toBe("network-error");
    // Handoff not recorded on failure.
    expect((await db.captureLog.get(mrn))?.handoffAt).toBeUndefined();
  });

  it("returns server-error on a non-ok response", async () => {
    const mrn = "PROV-srverr01";
    await logCapture({
      mrn, capturedAt: Date.now(), sex: "male", approximateAge: 20, complaint: "x",
      vitalsJson: "{}", submissionStatus: "complete", encounterId: "srv-enc", joined: true,
    });
    installFetch({ ok: false });
    init();
    expect(await finalizeEncounter(mrn)).toBe("server-error");
    expect((await db.captureLog.get(mrn))?.handoffAt).toBeUndefined();
  });
});
