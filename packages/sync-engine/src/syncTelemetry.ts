/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */

/**
 * Fleet sync-health telemetry (issue #10).
 *
 * When an item dead-letters on a 4xx it dies silently — only visible on one
 * paramedic's phone. A device sitting on un-synced records for days is invisible
 * to operations. This module lets each device publish a small, PHI-free health
 * snapshot (queue depth, last-sync time, dead-letter count, oldest pending age)
 * so a dispatch-side dashboard can surface stuck devices and raise alerts.
 *
 * PHI boundary: a snapshot carries only the opaque device id, counts, and
 * timestamps — never an MRN, a resource body, or any patient content. The same
 * minimal-contract philosophy as remote wipe: any backend can collect it.
 */
import { db } from "./db.js";

/**
 * A per-device sync-health snapshot. Counts and timestamps only — no PHI. Absent
 * timestamps are `null` (not optional) so the wire shape is stable for collectors
 * and tsconfig's exactOptionalPropertyTypes never bites.
 */
export interface SyncHealthSnapshot {
  /** Opaque per-device id (see appLock.getDeviceId) — addresses the device with no PHI. */
  deviceId: string;
  /** Items still waiting in the write queue. */
  queueDepth: number;
  /** Items that exhausted retries / hit a 4xx and were parked in the dead-letter table. */
  deadLetterCount: number;
  /** Conflicts surfaced for human resolution and still unresolved. */
  unresolvedConflictCount: number;
  /** enqueuedAt of the oldest queued item (Unix ms), or null if the queue is empty. */
  oldestQueuedAt: number | null;
  /** failedAt of the oldest dead-lettered item (Unix ms), or null if none. */
  oldestDeadLetterAt: number | null;
  /** Last time this device successfully synced anything (Unix ms), or null if never. */
  lastSyncAt: number | null;
  /** When this snapshot was taken (Unix ms) — the dashboard's "last seen" signal. */
  reportedAt: number;
}

export type SyncSeverity = "ok" | "warning" | "critical";

/** Age/staleness thresholds that turn a snapshot into a warning or an alert. */
export interface SyncHealthThresholds {
  /** Oldest queued item older than this → warning. */
  warnQueueAgeMs: number;
  /** Oldest queued item older than this → critical alert. */
  criticalQueueAgeMs: number;
}

/** Defaults tuned for a field shift: a record stuck >15 min is worth a look,
 *  >1 h means something is wrong and ops should intervene. */
export const DEFAULT_SYNC_THRESHOLDS: SyncHealthThresholds = {
  warnQueueAgeMs: 15 * 60_000,
  criticalQueueAgeMs: 60 * 60_000,
};

export interface SyncHealthEvaluation {
  severity: SyncSeverity;
  /** Human-readable reasons behind the severity, for the dashboard row detail. */
  reasons: string[];
}

const RANK: Record<SyncSeverity, number> = { ok: 0, warning: 1, critical: 2 };

function describeAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Classify a snapshot. Pure — no I/O — so it is the single source of truth shared
 * by the on-device check and the dispatch dashboard.
 *
 * - A dead-lettered record is always critical: it failed permanently and dies
 *   silently otherwise (the exact problem this feature exists to fix).
 * - An aging un-synced record escalates warning → critical as it gets older.
 * - An unresolved conflict is a warning — it already surfaces in the field app,
 *   but ops should see it too.
 */
export function evaluateSyncHealth(
  snapshot: SyncHealthSnapshot,
  now: number,
  thresholds: SyncHealthThresholds = DEFAULT_SYNC_THRESHOLDS,
): SyncHealthEvaluation {
  const reasons: string[] = [];
  let severity: SyncSeverity = "ok";
  const escalate = (level: SyncSeverity) => {
    if (RANK[level] > RANK[severity]) severity = level;
  };

  if (snapshot.deadLetterCount > 0) {
    escalate("critical");
    reasons.push(
      `${snapshot.deadLetterCount} record${snapshot.deadLetterCount === 1 ? "" : "s"} failed to sync`,
    );
  }

  if (snapshot.oldestQueuedAt !== null) {
    const age = Math.max(0, now - snapshot.oldestQueuedAt);
    if (age >= thresholds.criticalQueueAgeMs) {
      escalate("critical");
      reasons.push(`oldest unsynced record is ${describeAge(age)} old`);
    } else if (age >= thresholds.warnQueueAgeMs) {
      escalate("warning");
      reasons.push(`oldest unsynced record is ${describeAge(age)} old`);
    }
  }

  if (snapshot.unresolvedConflictCount > 0) {
    escalate("warning");
    reasons.push(
      `${snapshot.unresolvedConflictCount} conflict${snapshot.unresolvedConflictCount === 1 ? "" : "s"} to review`,
    );
  }

  return { severity, reasons };
}

// --- last-sync bookkeeping --------------------------------------------------
//
// "Last sync" is non-PHI metadata, so it lives in localStorage (survives reloads,
// no key-gate dependency). Falls back to an in-memory value where localStorage is
// unavailable (service worker, Node test runner) so callers never have to branch.

const LAST_SYNC_KEY = "ems:lastSyncAt";
let memoryLastSync: number | null = null;

function readStore(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_SYNC_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStore(value: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_SYNC_KEY, value);
  } catch {
    /* storage unavailable — memory fallback already set by the caller */
  }
}

/** Record that a sync interaction with the server just succeeded. */
export function recordSyncSuccess(now: number = Date.now()): void {
  memoryLastSync = now;
  writeStore(String(now));
}

/** The last successful sync time (Unix ms), or null if this device never synced. */
export function getLastSyncAt(): number | null {
  const stored = readStore();
  if (stored !== null) {
    const n = Number(stored);
    return Number.isFinite(n) ? n : null;
  }
  return memoryLastSync;
}

/** Test-only: clear the in-memory last-sync value (localStorage is cleared by the test env). */
export function resetSyncTelemetryForTest(): void {
  memoryLastSync = null;
}

/**
 * Read a PHI-free health snapshot from the local queue tables. Cheap enough to
 * call at the end of every flush.
 */
export async function collectSyncHealth(opts: {
  deviceId: string;
  now?: number;
  /** Override the last-sync value (tests); defaults to {@link getLastSyncAt}. */
  lastSyncAt?: number | null;
}): Promise<SyncHealthSnapshot> {
  const now = opts.now ?? Date.now();

  const [queueDepth, deadLetterCount, unresolvedConflictCount, oldestQueued, oldestDead] =
    await Promise.all([
      db.writeQueue.count(),
      db.deadLetter.count(),
      db.conflictLog.where("resolution").equals("unresolved").count(),
      db.writeQueue.orderBy("enqueuedAt").first(),
      db.deadLetter.orderBy("failedAt").first(),
    ]);

  return {
    deviceId: opts.deviceId,
    queueDepth,
    deadLetterCount,
    unresolvedConflictCount,
    oldestQueuedAt: oldestQueued?.enqueuedAt ?? null,
    oldestDeadLetterAt: oldestDead?.failedAt ?? null,
    lastSyncAt: opts.lastSyncAt !== undefined ? opts.lastSyncAt : getLastSyncAt(),
    reportedAt: now,
  };
}

export interface ReportSyncHealthOptions {
  /** Endpoint that collects fleet telemetry. */
  url: string;
  snapshot: SyncHealthSnapshot;
  /** Authorization header to send, if the endpoint requires auth. */
  authHeader?: string;
  /** Injectable fetch for testing. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * POST a snapshot to the telemetry endpoint. Best-effort: any network error or
 * non-OK response resolves to `false` and is swallowed by the caller — telemetry
 * must never disrupt the sync path or surface an error to the paramedic.
 */
export async function reportSyncHealth(opts: ReportSyncHealthOptions): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.authHeader) headers.Authorization = opts.authHeader;
    const res = await doFetch(opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.snapshot),
    });
    return res.ok;
  } catch {
    return false;
  }
}
