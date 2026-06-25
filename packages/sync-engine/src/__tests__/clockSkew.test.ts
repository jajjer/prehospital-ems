/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { db } from "../db.js";
import { enqueue, initSyncWorker, flush } from "../syncWorker.js";

// Isolated in its own file: clock-skew detection fires at most once per session
// (module-level `clockChecked`), so it needs a fresh module instance to observe.

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

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
  await Promise.all([db.writeQueue.clear(), db.deadLetter.clear(), db.identityMap.clear()]);
  dispatched.length = 0;
});

async function enqueuePatient(id: string, mrn: string): Promise<void> {
  await enqueue({
    id, resourceType: "Patient", resourceId: mrn,
    body: JSON.stringify({ resourceType: "Patient", identifier: [{ value: mrn }] }),
  });
}

describe("flush — clock-skew detection", () => {
  it("dispatches ems:clock-skew when the server timestamp is more than 5 minutes off", async () => {
    await enqueuePatient("p-skew", "PROV-skew0001");

    // Server reports a lastUpdated 30 minutes in the past — a badly-set device clock.
    const serverTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    define("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ id: "srv-uuid", meta: { lastUpdated: serverTime } }),
    })));

    initSyncWorker({ fhirBaseUrl: "https://fhir.test/R4", authHeader: "Basic test" });
    await flush();

    const skew = dispatched.find((e) => e.type === "ems:clock-skew");
    expect(skew).toBeDefined();
    expect((skew!.detail as { skewMinutes: number }).skewMinutes).toBe(30);
  });

  it("does not fire again on subsequent successful responses (once per session)", async () => {
    await enqueuePatient("p-again", "PROV-again001");
    const serverTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    define("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ id: "srv-uuid-2", meta: { lastUpdated: serverTime } }),
    })));

    initSyncWorker({ fhirBaseUrl: "https://fhir.test/R4", authHeader: "Basic test" });
    await flush();

    // The first test already consumed the one-shot check; this flush must not re-fire.
    expect(dispatched.filter((e) => e.type === "ems:clock-skew")).toHaveLength(0);
  });
});
