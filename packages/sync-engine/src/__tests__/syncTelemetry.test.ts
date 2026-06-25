/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db.js";
import {
  evaluateSyncHealth,
  collectSyncHealth,
  reportSyncHealth,
  recordSyncSuccess,
  getLastSyncAt,
  resetSyncTelemetryForTest,
  DEFAULT_SYNC_THRESHOLDS,
  type SyncHealthSnapshot,
} from "../syncTelemetry.js";

const NOW = 1_700_000_000_000;

function snapshot(over: Partial<SyncHealthSnapshot> = {}): SyncHealthSnapshot {
  return {
    deviceId: "dev-1",
    queueDepth: 0,
    deadLetterCount: 0,
    unresolvedConflictCount: 0,
    oldestQueuedAt: null,
    oldestDeadLetterAt: null,
    lastSyncAt: NOW,
    reportedAt: NOW,
    ...over,
  };
}

describe("evaluateSyncHealth", () => {
  it("is ok for an empty, recently-synced device", () => {
    expect(evaluateSyncHealth(snapshot(), NOW).severity).toBe("ok");
  });

  it("is ok with a small, fresh queue (normal operation)", () => {
    const s = snapshot({ queueDepth: 3, oldestQueuedAt: NOW - 60_000 });
    expect(evaluateSyncHealth(s, NOW).severity).toBe("ok");
  });

  it("flags a dead-lettered record as critical", () => {
    const r = evaluateSyncHealth(snapshot({ deadLetterCount: 2 }), NOW);
    expect(r.severity).toBe("critical");
    expect(r.reasons.join(" ")).toContain("2 records failed");
  });

  it("warns on an aging queue, escalates to critical when older", () => {
    const warnAge = snapshot({
      queueDepth: 1,
      oldestQueuedAt: NOW - DEFAULT_SYNC_THRESHOLDS.warnQueueAgeMs - 1,
    });
    expect(evaluateSyncHealth(warnAge, NOW).severity).toBe("warning");

    const critAge = snapshot({
      queueDepth: 1,
      oldestQueuedAt: NOW - DEFAULT_SYNC_THRESHOLDS.criticalQueueAgeMs - 1,
    });
    expect(evaluateSyncHealth(critAge, NOW).severity).toBe("critical");
  });

  it("warns on unresolved conflicts", () => {
    const r = evaluateSyncHealth(snapshot({ unresolvedConflictCount: 1 }), NOW);
    expect(r.severity).toBe("warning");
    expect(r.reasons.join(" ")).toContain("1 conflict to review");
  });

  it("takes the maximum severity across signals", () => {
    const s = snapshot({
      deadLetterCount: 1,
      unresolvedConflictCount: 2,
      queueDepth: 1,
      oldestQueuedAt: NOW - DEFAULT_SYNC_THRESHOLDS.warnQueueAgeMs - 1,
    });
    expect(evaluateSyncHealth(s, NOW).severity).toBe("critical");
  });

  it("respects custom thresholds", () => {
    const s = snapshot({ queueDepth: 1, oldestQueuedAt: NOW - 5_000 });
    const r = evaluateSyncHealth(s, NOW, { warnQueueAgeMs: 1_000, criticalQueueAgeMs: 10_000 });
    expect(r.severity).toBe("warning");
  });
});

describe("recordSyncSuccess / getLastSyncAt", () => {
  beforeEach(() => resetSyncTelemetryForTest());

  it("starts null and records the last success time", () => {
    expect(getLastSyncAt()).toBeNull();
    recordSyncSuccess(NOW);
    expect(getLastSyncAt()).toBe(NOW);
  });
});

describe("reportSyncHealth", () => {
  it("POSTs the snapshot as JSON and returns true on success", async () => {
    let seen: { url: string; method: string | undefined; body: string | undefined; auth: string | undefined } =
      { url: "", method: undefined, body: undefined, auth: undefined };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = {
        url,
        method: init?.method,
        body: init?.body as string,
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      };
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    const snap = snapshot({ queueDepth: 4 });
    const ok = await reportSyncHealth({ url: "https://t.example/health", snapshot: snap, authHeader: "Bearer x", fetchImpl });
    expect(ok).toBe(true);
    expect(seen.method).toBe("POST");
    expect(seen.auth).toBe("Bearer x");
    expect(JSON.parse(seen.body!)).toMatchObject({ deviceId: "dev-1", queueDepth: 4 });
  });

  it("returns false on a non-OK response", async () => {
    const fetchImpl = (async () => ({ ok: false }) as Response) as unknown as typeof fetch;
    expect(await reportSyncHealth({ url: "https://t.example", snapshot: snapshot(), fetchImpl })).toBe(false);
  });

  it("returns false (never throws) on a network error", async () => {
    const fetchImpl = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await reportSyncHealth({ url: "https://t.example", snapshot: snapshot(), fetchImpl })).toBe(false);
  });
});

describe("collectSyncHealth", () => {
  beforeEach(async () => {
    await db.open();
    await Promise.all([db.writeQueue.clear(), db.deadLetter.clear(), db.conflictLog.clear()]);
  });

  it("reports zero counts and null timestamps for an empty queue", async () => {
    const s = await collectSyncHealth({ deviceId: "dev-1", now: NOW, lastSyncAt: null });
    expect(s).toMatchObject({
      deviceId: "dev-1",
      queueDepth: 0,
      deadLetterCount: 0,
      unresolvedConflictCount: 0,
      oldestQueuedAt: null,
      oldestDeadLetterAt: null,
      lastSyncAt: null,
      reportedAt: NOW,
    });
  });

  it("derives counts and oldest-item timestamps from the queue tables (no PHI)", async () => {
    await db.writeQueue.bulkPut([
      { id: "w1", resourceType: "Patient", resourceId: "P1", body: "x", enqueuedAt: NOW - 5_000, retryCount: 0 },
      { id: "w2", resourceType: "Encounter", resourceId: "E1", body: "x", enqueuedAt: NOW - 9_000, retryCount: 0 },
    ]);
    await db.deadLetter.bulkPut([
      { id: "d1", resourceType: "Observation", resourceId: "O1", patientId: undefined, encounterId: undefined, statusCode: 422, body: "x", failedAt: NOW - 3_000 },
    ]);
    await db.conflictLog.put({
      id: "c1", resourceType: "Patient", resourceId: "P1", mrn: "MRN1", serverUUID: "srv-1",
      localEnqueuedAt: NOW - 8_000, serverLastUpdated: undefined, detectedAt: NOW - 8_000,
      resolution: "unresolved", resolvedAt: undefined, localBody: "x",
    });

    const s = await collectSyncHealth({ deviceId: "dev-1", now: NOW, lastSyncAt: NOW - 1_000 });
    expect(s.queueDepth).toBe(2);
    expect(s.deadLetterCount).toBe(1);
    expect(s.unresolvedConflictCount).toBe(1);
    expect(s.oldestQueuedAt).toBe(NOW - 9_000);
    expect(s.oldestDeadLetterAt).toBe(NOW - 3_000);
    expect(s.lastSyncAt).toBe(NOW - 1_000);
    // PHI boundary: no body / mrn fields leak into the snapshot.
    expect(JSON.stringify(s)).not.toContain("MRN1");
  });

  it("excludes resolved conflicts from the unresolved count", async () => {
    await db.conflictLog.put({
      id: "c1", resourceType: "Patient", resourceId: "P1", mrn: "MRN1", serverUUID: "srv-1",
      localEnqueuedAt: NOW, serverLastUpdated: undefined, detectedAt: NOW,
      resolution: "kept-server", resolvedAt: NOW, localBody: "x",
    });
    const s = await collectSyncHealth({ deviceId: "dev-1", now: NOW, lastSyncAt: null });
    expect(s.unresolvedConflictCount).toBe(0);
  });
});
