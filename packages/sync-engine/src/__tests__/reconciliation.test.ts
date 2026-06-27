/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { db } from "../db.js";
import { logCapture } from "../captureLog.js";
import { enqueue } from "../syncWorker.js";
import {
  searchPatientsByMpi, reconcilePatient, getReconciliation,
  type MpiCandidate,
} from "../reconciliation.js";

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const FHIR = "https://fhir.test/R4";
const AUTH = "Basic test";

interface FetchCall { url: string; method: string; body: string | undefined }
const fetchCalls: FetchCall[] = [];

/** Installs a fetch that routes by method+url; PATCH/GET succeed, with optional overrides. */
function installFetch(opts: {
  /** Bundle returned for a `${type}?encounter=` dependent search, keyed by type. */
  dependents?: Partial<Record<string, string[]>>;
  /** Force PATCH on the Encounter to throw (network) or fail (server). */
  encounterPatch?: "throw" | "fail";
} = {}): void {
  define("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    fetchCalls.push({ url, method, body: init?.body });

    // Encounter subject PATCH
    if (method === "PATCH" && /\/Encounter\//.test(url)) {
      if (opts.encounterPatch === "throw") throw new Error("offline");
      return { ok: opts.encounterPatch !== "fail", status: 200, json: async () => ({}) };
    }
    // Dependent searches: Observation?encounter=… etc.
    if (method === "GET") {
      const type = url.slice(FHIR.length + 1).split("?")[0]!;
      const ids = opts.dependents?.[type] ?? [];
      return { ok: true, status: 200, json: async () => ({ entry: ids.map((id) => ({ resource: { id } })) }) };
    }
    // Dependent subject PATCHes
    return { ok: true, status: 200, json: async () => ({}) };
  }));
}

beforeAll(() => {
  define("navigator", { onLine: true });
  define("window", { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true });
  define("document", { addEventListener() {}, visibilityState: "visible" });
});

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.identityMap.clear(), db.captureLog.clear(),
    db.writeQueue.clear(), db.reconciliationLog.clear(),
  ]);
  fetchCalls.length = 0;
  define("navigator", { onLine: true });
});

const CONFIRMED: MpiCandidate = {
  uuid: "confirmed-uuid", name: "Jane Doe", gender: "female",
  birthDate: "1990-05-01", identifier: "MRN-100",
};

describe("searchPatientsByMpi", () => {
  function bundle() {
    return {
      entry: [
        { resource: { resourceType: "Patient", id: "p1", gender: "female",
          name: [{ given: ["Jane"], family: "Doe", use: "official" }],
          identifier: [{ use: "official", value: "MRN-100" }] } },
        // Provisional-only — must be filtered out
        { resource: { resourceType: "Patient", id: "p2", gender: "unknown",
          name: [{ given: ["Unknown"], family: "Patient" }],
          identifier: [{ value: "PROV-abcd1234" }] } },
      ],
    };
  }

  it("returns confirmed candidates and filters out provisional-only records", async () => {
    define("fetch", vi.fn(async () => ({ ok: true, json: async () => bundle() })));
    const results = await searchPatientsByMpi("Doe", FHIR, AUTH);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ uuid: "p1", name: "Jane Doe", identifier: "MRN-100" });
  });

  it("returns [] when offline, on empty query, and on a non-ok response", async () => {
    define("navigator", { onLine: false });
    define("fetch", vi.fn(async () => ({ ok: true, json: async () => bundle() })));
    expect(await searchPatientsByMpi("Doe", FHIR, AUTH)).toEqual([]);

    define("navigator", { onLine: true });
    expect(await searchPatientsByMpi("   ", FHIR, AUTH)).toEqual([]);

    define("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await searchPatientsByMpi("Doe", FHIR, AUTH)).toEqual([]);
  });
});

describe("reconcilePatient — pre-sync (provisional Patient still queued)", () => {
  it("drops the queued Patient POST and maps the provisional id to the confirmed patient", async () => {
    const mrn = "PROV-presync1";
    await logCapture({
      mrn, capturedAt: Date.now(), sex: "unknown", approximateAge: undefined,
      complaint: "collapse", vitalsJson: "{}", submissionStatus: "complete", encounterId: "ENC-presync1",
    });
    await enqueue({ id: "wq-pat", resourceType: "Patient", resourceId: mrn, body: JSON.stringify({ resourceType: "Patient" }) });

    installFetch();
    const result = await reconcilePatient({ mrn, target: CONFIRMED, fhirBaseUrl: FHIR, authHeader: AUTH });

    expect(result).toBe("ok");
    // No server PATCH/GET — nothing is on the server yet.
    expect(fetchCalls).toHaveLength(0);
    // Provisional Patient POST removed; identity map now points at the confirmed patient.
    expect(await db.writeQueue.get("wq-pat")).toBeUndefined();
    expect((await db.identityMap.get(mrn))?.serverUUID).toBe("confirmed-uuid");
    // Audit has no provisional server UUID (never synced).
    const audit = await getReconciliation(mrn);
    expect(audit?.provisionalPatientUUID).toBeUndefined();
    expect(audit?.targetName).toBe("Jane Doe");
  });
});

describe("reconcilePatient — post-sync (provisional Patient already on the server)", () => {
  async function seedSynced(mrn: string) {
    await logCapture({
      mrn, capturedAt: Date.now(), sex: "male", approximateAge: 40,
      complaint: "MVC", vitalsJson: "{}", submissionStatus: "complete", encounterId: "ENC-syn1",
    });
    // Provisional Patient + Encounter already resolved server-side.
    await db.identityMap.put({ provisionalId: mrn, serverUUID: "prov-pat-uuid", resourceType: "Patient", resolvedAt: Date.now() });
    await db.identityMap.put({ provisionalId: "ENC-syn1", serverUUID: "server-enc-uuid", resourceType: "Encounter", resolvedAt: Date.now() });
  }

  it("re-points the Encounter and its dependent resources to the confirmed patient", async () => {
    const mrn = "PROV-postsyn1";
    await seedSynced(mrn);

    installFetch({ dependents: { Observation: ["obs-1", "obs-2"], Procedure: ["proc-1"] } });
    const result = await reconcilePatient({ mrn, target: CONFIRMED, fhirBaseUrl: FHIR, authHeader: AUTH });

    expect(result).toBe("ok");

    // Encounter subject re-pointed.
    const encPatch = fetchCalls.find((c) => c.method === "PATCH" && c.url.endsWith("/Encounter/server-enc-uuid"));
    expect(encPatch).toBeDefined();
    expect(encPatch!.body).toContain("Patient/confirmed-uuid");

    // Each dependent re-pointed.
    const patched = fetchCalls.filter((c) => c.method === "PATCH" && /\/(Observation|Procedure)\//.test(c.url)).map((c) => c.url);
    expect(patched).toEqual([
      `${FHIR}/Observation/obs-1`,
      `${FHIR}/Observation/obs-2`,
      `${FHIR}/Procedure/proc-1`,
    ]);

    // Identity map and capture updated to the confirmed patient.
    expect((await db.identityMap.get(mrn))?.serverUUID).toBe("confirmed-uuid");
    const cap = await db.captureLog.get(mrn);
    expect(cap?.reconciledPatientUUID).toBe("confirmed-uuid");
    expect(cap?.patientRef).toBe("confirmed-uuid");

    // Audit records the orphaned provisional UUID and the re-pointed count (3 dependents).
    const audit = await getReconciliation(mrn);
    expect(audit?.provisionalPatientUUID).toBe("prov-pat-uuid");
    expect(audit?.encounterId).toBe("server-enc-uuid");
    expect(audit?.repointedCount).toBe(3);
  });

  it("returns network-error and leaves local state untouched when the Encounter PATCH throws", async () => {
    const mrn = "PROV-neterr1";
    await seedSynced(mrn);

    installFetch({ encounterPatch: "throw" });
    const result = await reconcilePatient({ mrn, target: CONFIRMED, fhirBaseUrl: FHIR, authHeader: AUTH });

    expect(result).toBe("network-error");
    // Identity map still points at the provisional patient; no audit/capture mutation.
    expect((await db.identityMap.get(mrn))?.serverUUID).toBe("prov-pat-uuid");
    expect((await db.captureLog.get(mrn))?.reconciledPatientUUID).toBeUndefined();
    expect(await getReconciliation(mrn)).toBeUndefined();
  });
});

describe("reconcilePatient — guards", () => {
  it("returns not-synced when there is no capture for the mrn", async () => {
    installFetch();
    expect(await reconcilePatient({ mrn: "PROV-missing", target: CONFIRMED, fhirBaseUrl: FHIR, authHeader: AUTH })).toBe("not-synced");
    expect(fetchCalls).toHaveLength(0);
  });
});
