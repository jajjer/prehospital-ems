/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { db } from "../db.js";
import { enqueue, initSyncWorker, flush } from "../syncWorker.js";
import { getConflictsForMrn } from "../conflictLog.js";
import { isEnvelope } from "../crypto.js";

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

interface FetchCall {
  url: string;
  method: string;
  body: string | undefined;
}

const fetchCalls: FetchCall[] = [];

/** Events dispatched on the window via dispatchEvent — captured for assertions. */
const dispatched: Array<{ type: string; detail: unknown }> = [];

beforeAll(() => {
  define("window", {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: (e: { type: string; detail: unknown }) => { dispatched.push(e); return true; },
  });
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
    db.conflictLog.clear(),
  ]);
  fetchCalls.length = 0;
  dispatched.length = 0;
});

/** Install a fetch mock. `handler` receives the request and returns a Response-like object. */
function installFetch(
  handler: (req: { url: string; method: string; body: string | undefined }) => {
    ok?: boolean;
    status?: number;
    json?: () => Promise<unknown>;
    throws?: boolean;
  }
): void {
  define("fetch", vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
    const req = { url, method: opts?.method ?? "GET", body: opts?.body };
    fetchCalls.push(req);
    const res = handler(req);
    if (res.throws) throw new Error("network down");
    return {
      ok: res.ok ?? true,
      status: res.status ?? 200,
      json: res.json ?? (async () => ({ id: "srv", meta: { lastUpdated: new Date(Date.now() - 1000).toISOString() } })),
    };
  }));
}

const init = () => initSyncWorker({ fhirBaseUrl: "https://fhir.test/R4", authHeader: "Basic test" });

describe("flush — dependency-ordered (Patient → Encounter → dependents)", () => {
  it("POSTs Patient first, Encounter second, dependents last regardless of enqueue order", async () => {
    const mrn = "PROV-aaa11111";
    const encId = "ENC-bbb22222";

    // Enqueue in *reverse* dependency order to prove flush reorders, not insertion order.
    await enqueue({
      id: crypto.randomUUID(), resourceType: "Observation", resourceId: crypto.randomUUID(),
      patientId: mrn, encounterId: encId,
      body: JSON.stringify({ resourceType: "Observation", subject: { reference: `Patient/${mrn}` }, encounter: { reference: `Encounter/${encId}` } }),
    });
    await enqueue({
      id: crypto.randomUUID(), resourceType: "Condition", resourceId: crypto.randomUUID(),
      patientId: mrn, encounterId: encId,
      body: JSON.stringify({ resourceType: "Condition", subject: { reference: `Patient/${mrn}` }, encounter: { reference: `Encounter/${encId}` } }),
    });
    await enqueue({
      id: crypto.randomUUID(), resourceType: "Encounter", resourceId: encId, patientId: mrn,
      body: JSON.stringify({ resourceType: "Encounter", id: encId, subject: { reference: `Patient/${mrn}` } }),
    });
    await enqueue({
      id: crypto.randomUUID(), resourceType: "Patient", resourceId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
    });

    installFetch((req) => ({
      json: async () => ({
        id: req.url.endsWith("/Patient") ? "srv-patient" : req.url.endsWith("/Encounter") ? "srv-encounter" : "srv-dep",
        meta: { lastUpdated: new Date(Date.now() - 1000).toISOString() },
      }),
    }));

    init();
    await flush();

    const posted = fetchCalls.filter((c) => c.method === "POST").map((c) => c.url.split("/R4/")[1]);
    expect(posted[0]).toBe("Patient");
    expect(posted[1]).toBe("Encounter");
    // Remaining two are the dependents (order between them not significant).
    expect(posted.slice(2).sort()).toEqual(["Condition", "Observation"]);

    // Dependents had their provisional references resolved to server UUIDs.
    const obs = fetchCalls.find((c) => c.url.endsWith("/Observation"))!;
    expect(obs.body).toContain("Patient/srv-patient");
    expect(obs.body).toContain("Encounter/srv-encounter");
    expect(await db.writeQueue.count()).toBe(0);
  });
});

describe("flush — search-before-create idempotency on retry", () => {
  it("force-close mid-flush: a retried Patient that already exists server-side is NOT re-created", async () => {
    const mrn = "PROV-dup00001";
    await enqueue({
      id: "patient-1", resourceType: "Patient", resourceId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
    });
    // Simulate a prior failed attempt (the POST that the server actually processed
    // before we lost the connection / the tab was force-closed).
    await db.writeQueue.update("patient-1", { retryCount: 1 });

    installFetch((req) => {
      // Search hit — the patient is already on the server from the lost attempt.
      if (req.method === "GET" && req.url.includes("/Patient?identifier=")) {
        return { json: async () => ({ total: 1, entry: [{ resource: { id: "existing-server-uuid" } }] }) };
      }
      return { json: async () => ({ id: "should-not-happen" }) };
    });

    init();
    await flush();

    // No second Patient was POSTed — the search short-circuited creation.
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
    // Identity map points the provisional id at the *existing* server UUID.
    expect((await db.identityMap.get(mrn))?.serverUUID).toBe("existing-server-uuid");
    // Item removed from the queue — no duplicate left pending.
    expect(await db.writeQueue.count()).toBe(0);
  });

  it("retry with a search miss falls through to create the Patient", async () => {
    const mrn = "PROV-miss0001";
    await enqueue({
      id: "patient-2", resourceType: "Patient", resourceId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
    });
    await db.writeQueue.update("patient-2", { retryCount: 1 });

    installFetch((req) => {
      if (req.method === "GET" && req.url.includes("/Patient?identifier=")) {
        return { json: async () => ({ total: 0, entry: [] }) };
      }
      return { json: async () => ({ id: "newly-created-uuid", meta: { lastUpdated: new Date(Date.now() - 1000).toISOString() } }) };
    });

    init();
    await flush();

    expect(fetchCalls.some((c) => c.method === "POST" && c.url.endsWith("/Patient"))).toBe(true);
    expect((await db.identityMap.get(mrn))?.serverUUID).toBe("newly-created-uuid");
    expect(await db.writeQueue.count()).toBe(0);
  });
});

describe("flush — conflict detection (concurrent server edit between enqueue and flush)", () => {
  it("first-attempt Patient already on the server: reconciles, records a conflict, no duplicate POST", async () => {
    const mrn = "PROV-conf0001";
    const encId = "ENC-conf0001";
    // A first-attempt capture (retryCount 0). Between enqueue and flush, another
    // responder created/edited this same patient on the server.
    await enqueue({
      id: "patient-c", resourceType: "Patient", resourceId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }], note: "secret-phi-conflict" }),
    });
    await enqueue({
      id: "enc-c", resourceType: "Encounter", resourceId: encId, patientId: mrn,
      body: JSON.stringify({ resourceType: "Encounter", id: encId, subject: { reference: `Patient/${mrn}` } }),
    });

    const serverLastUpdated = new Date(Date.now() - 1000).toISOString();
    installFetch((req) => {
      // Search finds the concurrently-created server patient.
      if (req.method === "GET" && req.url.includes("/Patient?identifier=")) {
        return { json: async () => ({ total: 1, entry: [{ resource: { id: "concurrent-server-uuid", meta: { lastUpdated: serverLastUpdated } } }] }) };
      }
      // Encounter still POSTs — its dependents attach to the existing patient.
      return { json: async () => ({ id: "srv-encounter", meta: { lastUpdated: serverLastUpdated } }) };
    });

    init();
    await flush();

    // No Patient was POSTed — the concurrent server copy was reused, not duplicated.
    expect(fetchCalls.some((c) => c.method === "POST" && c.url.endsWith("/Patient"))).toBe(false);
    // Provisional id reconciled to the existing server UUID so dependents resolve.
    expect((await db.identityMap.get(mrn))?.serverUUID).toBe("concurrent-server-uuid");
    // The Encounter (a dependent) resolved its subject to the server patient.
    const encPost = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/Encounter"));
    expect(encPost?.body).toContain("Patient/concurrent-server-uuid");
    // Patient queue item is gone; nothing dead-lettered.
    expect(await db.writeQueue.get("patient-c")).toBeUndefined();
    expect(await db.deadLetter.count()).toBe(0);

    // A conflict was recorded and surfaced for human resolution.
    const conflicts = await getConflictsForMrn(mrn);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.resolution).toBe("unresolved");
    expect(conflicts[0]?.serverUUID).toBe("concurrent-server-uuid");
    expect(conflicts[0]?.resourceType).toBe("Patient");
    // The un-applied local body is preserved (decrypted) for manual merge…
    expect(conflicts[0]?.localBody).toContain("secret-phi-conflict");
    // …but encrypted at rest — no plaintext PHI in the stored row.
    const stored = await db.conflictLog.get("patient-c");
    expect(isEnvelope(stored?.localBody)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("secret-phi-conflict");
  });

  it("first-attempt search miss: creates the Patient and records no conflict", async () => {
    const mrn = "PROV-noconf01";
    await enqueue({
      id: "patient-n", resourceType: "Patient", resourceId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
    });

    installFetch((req) => {
      if (req.method === "GET" && req.url.includes("/Patient?identifier=")) {
        return { json: async () => ({ total: 0, entry: [] }) };
      }
      return { json: async () => ({ id: "fresh-server-uuid", meta: { lastUpdated: new Date(Date.now() - 1000).toISOString() } }) };
    });

    init();
    await flush();

    expect(fetchCalls.some((c) => c.method === "POST" && c.url.endsWith("/Patient"))).toBe(true);
    expect((await db.identityMap.get(mrn))?.serverUUID).toBe("fresh-server-uuid");
    expect(await getConflictsForMrn(mrn)).toHaveLength(0);
    expect(await db.conflictLog.count()).toBe(0);
  });

  it("retry hit (force-close recovery) reconciles silently and records no conflict", async () => {
    const mrn = "PROV-retry001";
    await enqueue({
      id: "patient-r", resourceType: "Patient", resourceId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
    });
    // retryCount > 0 means our own prior POST may have landed — a match is recovery, not a conflict.
    await db.writeQueue.update("patient-r", { retryCount: 1 });

    installFetch((req) => {
      if (req.method === "GET" && req.url.includes("/Patient?identifier=")) {
        return { json: async () => ({ total: 1, entry: [{ resource: { id: "our-prior-uuid" } }] }) };
      }
      return { json: async () => ({ id: "should-not-happen" }) };
    });

    init();
    await flush();

    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
    expect((await db.identityMap.get(mrn))?.serverUUID).toBe("our-prior-uuid");
    // Force-close recovery is not a conflict — nothing is surfaced.
    expect(await db.conflictLog.count()).toBe(0);
  });
});

describe("flush — 401 aborts the flush and prompts re-auth", () => {
  it("dispatches ems:auth-expired and leaves remaining items untouched", async () => {
    const mrn = "PROV-401aaaa";
    const encId = "ENC-401bbbb";
    await enqueue({
      id: "p", resourceType: "Patient", resourceId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
    });
    await enqueue({
      id: "e", resourceType: "Encounter", resourceId: encId, patientId: mrn,
      body: JSON.stringify({ resourceType: "Encounter", id: encId, subject: { reference: `Patient/${mrn}` } }),
    });

    // The token expired — the very first POST comes back 401.
    installFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));

    init();
    await flush();

    expect(dispatched.map((e) => e.type)).toContain("ems:auth-expired");
    // Only the Patient POST was attempted; the flush aborted before the Encounter.
    expect(fetchCalls.filter((c) => c.method === "POST")).toHaveLength(1);
    // Nothing dead-lettered, nothing deleted — both items remain for the next attempt.
    expect(await db.writeQueue.count()).toBe(2);
    expect(await db.deadLetter.count()).toBe(0);
  });
});

describe("flush — dead-letter on 4xx vs retry/backoff on 5xx", () => {
  it("moves a 4xx (permanent) failure to the dead-letter store, re-encrypted at rest", async () => {
    const mrn = "PROV-422aaaa";
    await enqueue({
      id: "bad", resourceType: "Patient", resourceId: mrn, patientId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }], note: "secret-phi-422" }),
    });

    installFetch(() => ({ ok: false, status: 422, json: async () => ({}) }));

    init();
    await flush();

    expect(await db.writeQueue.count()).toBe(0);
    const dead = await db.deadLetter.get("bad");
    expect(dead?.statusCode).toBe(422);
    // Body is re-encrypted in the dead-letter store — no plaintext PHI at rest.
    expect(isEnvelope(dead?.body)).toBe(true);
    expect(JSON.stringify(dead)).not.toContain("secret-phi-422");
  });

  it("keeps a 5xx (transient) failure queued with an incremented retry count", async () => {
    // Pin jitter to 0 so backoffDelay resolves immediately and the test is fast.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const mrn = "PROV-503aaaa";
    await enqueue({
      id: "transient", resourceType: "Patient", resourceId: mrn, patientId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
    });

    installFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));

    init();
    await flush();

    expect(await db.deadLetter.count()).toBe(0);
    const item = await db.writeQueue.get("transient");
    expect(item?.retryCount).toBe(1);
    vi.restoreAllMocks();
  });

  it("dead-letters a transient failure once retries are exhausted", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const mrn = "PROV-exhaust1";
    await enqueue({
      id: "spent", resourceType: "Patient", resourceId: mrn, patientId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
    });
    // maxRetries = 8; an item already at 8 should dead-letter on the next 5xx.
    await db.writeQueue.update("spent", { retryCount: 8 });

    installFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));

    init();
    await flush();

    expect(await db.writeQueue.count()).toBe(0);
    expect((await db.deadLetter.get("spent"))?.statusCode).toBe(503);
    vi.restoreAllMocks();
  });
});

describe("flush — network error keeps the item queued for retry", () => {
  it("increments retryCount and does not dead-letter when fetch throws", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const mrn = "PROV-neterr01";
    await enqueue({
      id: "net", resourceType: "Patient", resourceId: mrn, patientId: mrn,
      body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
    });

    installFetch(() => ({ throws: true }));

    init();
    await flush();

    expect(await db.deadLetter.count()).toBe(0);
    expect((await db.writeQueue.get("net"))?.retryCount).toBe(1);
    vi.restoreAllMocks();
  });
});
