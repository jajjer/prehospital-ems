/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { buildVitalObservations, type VitalsInput } from "@prehospital-ems/fhir-contracts";
import { db } from "../db.js";
import { enqueue, initSyncWorker, flush } from "../syncWorker.js";
import { logCapture, getRecentCaptures, addVitalsSet, vitalsSeries } from "../captureLog.js";
import { isEnvelope } from "../crypto.js";

const VITALS: VitalsInput = { hr: 100, rr: 18, bpSystolic: 120, bpDiastolic: 80, temp: 0, spo2: 97, gcs: 15 };

/** Read a record straight from IndexedDB, bypassing Dexie — what lands on disk. */
function rawGet(store: string, key: IDBValidKey): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("prehospital-ems-sync");
    open.onsuccess = () => {
      const idb = open.result;
      const req = idb.transaction(store, "readonly").objectStore(store).get(key);
      req.onsuccess = () => { resolve(req.result as Record<string, unknown>); idb.close(); };
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
}

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const fetchCalls: Array<{ url: string; body: string }> = [];

beforeAll(() => {
  // Minimal DOM-ish globals so initSyncWorker/flush run under the node test env.
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

describe("serial vitals — local model", () => {
  it("appends timestamped sets and returns the full series oldest-first", async () => {
    await logCapture({
      mrn: "MRN-S", capturedAt: 1000, sex: "male", approximateAge: 40,
      complaint: "chest pain", vitalsJson: JSON.stringify({ ...VITALS, hr: 100 }),
      submissionStatus: "complete", encounterId: "ENC-S",
    });

    // Add out of order — vitalsSeries must sort by time.
    await addVitalsSet("MRN-S", JSON.stringify({ ...VITALS, hr: 88 }), 3000);
    await addVitalsSet("MRN-S", JSON.stringify({ ...VITALS, hr: 94 }), 2000);

    const entry = (await getRecentCaptures())[0]!;
    const series = vitalsSeries(entry);
    expect(series.map((s) => s.capturedAt)).toEqual([1000, 2000, 3000]);
    expect((JSON.parse(series[0]!.vitalsJson) as VitalsInput).hr).toBe(100);
    expect((JSON.parse(series[1]!.vitalsJson) as VitalsInput).hr).toBe(94);
    expect((JSON.parse(series[2]!.vitalsJson) as VitalsInput).hr).toBe(88);
  });

  it("encrypts repeat vitals at rest", async () => {
    await logCapture({
      mrn: "MRN-E", capturedAt: 1000, sex: "female", approximateAge: undefined,
      complaint: "trauma", vitalsJson: "{}", submissionStatus: "complete", encounterId: "ENC-E",
    });
    await addVitalsSet("MRN-E", JSON.stringify({ ...VITALS, hr: 222 }), 2000);

    const raw = await rawGet("captureLog", "MRN-E");
    expect(isEnvelope(raw.repeatVitalsJson)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("222");

    // Round-trips back to plaintext on read.
    const entry = (await getRecentCaptures())[0]!;
    expect((JSON.parse(vitalsSeries(entry)[1]!.vitalsJson) as VitalsInput).hr).toBe(222);
  });

  it("vitalsSeries returns just the initial set when there are no repeats", async () => {
    await logCapture({
      mrn: "MRN-1", capturedAt: 5000, sex: "unknown", approximateAge: undefined,
      complaint: "", vitalsJson: JSON.stringify(VITALS), submissionStatus: "complete",
    });
    const entry = (await getRecentCaptures())[0]!;
    expect(vitalsSeries(entry).map((s) => s.capturedAt)).toEqual([5000]);
  });

  it("throws when the capture no longer exists", async () => {
    await expect(addVitalsSet("missing", "{}", 1)).rejects.toThrow();
  });
});

describe("serial vitals — multi-batch enqueue/flush against one encounter", () => {
  it("resolves references and syncs every batch with distinct timestamps", async () => {
    const mockFetch = vi.fn(async (url: string, opts: { body: string }) => {
      fetchCalls.push({ url, body: opts.body });
      const id = url.endsWith("/Patient") ? "srv-patient-uuid"
        : url.endsWith("/Encounter") ? "srv-encounter-uuid"
        : `srv-obs-${fetchCalls.length}`;
      // lastUpdated just before enqueue time: small skew (no clock-skew event) and
      // not "after" the local write (no spurious conflict warning).
      return { ok: true, status: 200, json: async () => ({ id, meta: { lastUpdated: new Date(Date.now() - 1000).toISOString() } }) };
    });
    define("fetch", mockFetch);

    const mrn = "PROV-aaa11111";
    const encId = "ENC-bbb22222";

    // Initial capture: Patient + Encounter + first vitals batch.
    await enqueue({
      id: crypto.randomUUID(), resourceType: "Patient", resourceId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
    });
    await enqueue({
      id: crypto.randomUUID(), resourceType: "Encounter", resourceId: encId, patientId: mrn,
      body: JSON.stringify({ resourceType: "Encounter", id: encId, subject: { reference: `Patient/${mrn}` } }),
    });

    const t1 = "2026-06-24T08:00:00.000Z";
    const t2 = "2026-06-24T08:20:00.000Z";
    for (const effectiveTime of [t1, t2]) {
      const observations = buildVitalObservations(VITALS, {
        patientServerUUID: mrn, encounterServerUUID: encId, effectiveTime,
      });
      for (const obs of observations) {
        await enqueue({
          id: crypto.randomUUID(), resourceType: "Observation", resourceId: crypto.randomUUID(),
          body: JSON.stringify(obs), patientId: mrn, encounterId: encId,
        });
      }
    }

    initSyncWorker({ fhirBaseUrl: "https://fhir.test/R4", authHeader: "Basic test" });
    await flush();

    // Identity map resolved for the shared Patient + Encounter.
    expect((await db.identityMap.get(mrn))?.serverUUID).toBe("srv-patient-uuid");
    expect((await db.identityMap.get(encId))?.serverUUID).toBe("srv-encounter-uuid");
    // Queue fully drained — every batch synced.
    expect(await db.writeQueue.count()).toBe(0);
    expect(await db.deadLetter.count()).toBe(0);

    const obsBodies = fetchCalls.filter((c) => c.url.endsWith("/Observation")).map((c) => c.body);
    // 6 observations per batch (temp = 0 is skipped) × 2 batches.
    expect(obsBodies.length).toBe(12);
    for (const body of obsBodies) {
      // Provisional ids rewritten to server UUIDs in every Observation.
      expect(body).toContain("Patient/srv-patient-uuid");
      expect(body).toContain("Encounter/srv-encounter-uuid");
      expect(body).not.toContain(mrn);
      expect(body).not.toContain(encId);
    }
    // Both readings kept their distinct effective time.
    expect(obsBodies.filter((b) => b.includes(t1)).length).toBe(6);
    expect(obsBodies.filter((b) => b.includes(t2)).length).toBe(6);
  });
});
