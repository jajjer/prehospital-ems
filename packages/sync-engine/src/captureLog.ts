/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { db, type CaptureLogEntry, type WriteQueueItem } from "./db.js";
import { encryptCapture, decryptCapture } from "./phiCrypto.js";

export async function logCapture(entry: CaptureLogEntry): Promise<void> {
  await db.captureLog.put(await encryptCapture(entry));
}

/**
 * Returns the most recent captures (newest first) with PHI fields decrypted,
 * for the Records screen. Reads forward via the query path then reverses in
 * memory — a reverse cursor would surface ciphertext (PHI is decrypted after
 * the read, not inside it).
 */
export async function getRecentCaptures(limit = 50): Promise<CaptureLogEntry[]> {
  const entries = (await db.captureLog.orderBy("capturedAt").toArray()).reverse().slice(0, limit);
  return Promise.all(entries.map((e) => decryptCapture(e)));
}

export async function markCaptureComplete(mrn: string): Promise<void> {
  await db.captureLog.update(mrn, { submissionStatus: "complete" });
}

/** One timestamped vitals reading within an encounter's serial-vitals series. */
export interface VitalsTimePoint {
  capturedAt: number;
  /** JSON.stringify(VitalsInput) — same encoding as CaptureLogEntry.vitalsJson. */
  vitalsJson: string;
}

/**
 * Appends a repeat vitals set to an existing capture (serial vitals over transport).
 * The new reading is stored against the same encounter — callers are responsible for
 * enqueuing the corresponding FHIR Observations. PHI is re-encrypted before the write.
 * Throws if the capture no longer exists (e.g. pruned).
 */
export async function addVitalsSet(
  mrn: string,
  vitalsJson: string,
  capturedAt: number,
): Promise<void> {
  const stored = await db.captureLog.get(mrn);
  if (!stored) throw new Error(`addVitalsSet: no capture for mrn ${mrn}`);
  const entry = await decryptCapture(stored);
  const sets: VitalsTimePoint[] = entry.repeatVitalsJson
    ? (JSON.parse(entry.repeatVitalsJson) as VitalsTimePoint[])
    : [];
  sets.push({ capturedAt, vitalsJson });
  entry.repeatVitalsJson = JSON.stringify(sets);
  await db.captureLog.put(await encryptCapture(entry));
}

/**
 * Corrects the initial vitals set of a capture in place (issue #13). The amended
 * values become the record's local source of truth; the immutable audit entries
 * and the corresponding FHIR correction are recorded separately by the caller.
 * Only the initial set (`vitalsJson`) is rewritten — repeat sets are untouched.
 * PHI is re-encrypted before the write. Throws if the capture no longer exists.
 */
export async function amendInitialVitals(mrn: string, vitalsJson: string): Promise<void> {
  const stored = await db.captureLog.get(mrn);
  if (!stored) throw new Error(`amendInitialVitals: no capture for mrn ${mrn}`);
  const entry = await decryptCapture(stored);
  entry.vitalsJson = vitalsJson;
  await db.captureLog.put(await encryptCapture(entry));
}

/**
 * Returns the full vitals series for a (decrypted) capture, oldest first: the initial
 * set from `vitalsJson`/`capturedAt` followed by any repeat sets, sorted by time.
 */
export function vitalsSeries(entry: CaptureLogEntry): VitalsTimePoint[] {
  const series: VitalsTimePoint[] = [{ capturedAt: entry.capturedAt, vitalsJson: entry.vitalsJson }];
  if (entry.repeatVitalsJson) {
    try {
      series.push(...(JSON.parse(entry.repeatVitalsJson) as VitalsTimePoint[]));
    } catch { /* corrupt repeat data — fall back to the initial set only */ }
  }
  return series.sort((a, b) => a.capturedAt - b.capturedAt);
}

/** Returns the first captureLog entry with submissionStatus "pending", if any. */
export async function getPendingCapture(): Promise<CaptureLogEntry | undefined> {
  // submissionStatus is cleartext, so we can filter before decrypting.
  const all = await db.captureLog.toArray();
  return decryptCapture(all.find((e) => e.submissionStatus === "pending"));
}

export type CaptureStatus = "synced" | "queued" | "failed";

const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Deletes captureLog entries older than 30 days along with any associated
 * writeQueue and deadLetter rows. Safe to call on every app launch.
 */
export async function pruneOldCaptures(): Promise<void> {
  const cutoff = Date.now() - PRUNE_AGE_MS;
  const old = await db.captureLog.where("capturedAt").below(cutoff).toArray();
  for (const entry of old) {
    await db.writeQueue.filter((i) => i.patientId === entry.mrn || i.resourceId === entry.mrn).delete();
    await db.deadLetter.where("patientId").equals(entry.mrn).delete();
    await db.conflictLog.where("mrn").equals(entry.mrn).delete();
    await db.amendmentLog.where("mrn").equals(entry.mrn).delete();
    await db.captureLog.delete(entry.mrn);
  }
}

/**
 * Moves all dead-lettered items for a capture back into the write queue at retryCount=0.
 * Call flush() after this to attempt immediate re-upload.
 */
export async function retryDeadLettered(mrn: string): Promise<void> {
  const deadItems = await db.deadLetter.where("patientId").equals(mrn).toArray();
  for (const item of deadItems) {
    await db.writeQueue.put({
      id: item.id,
      resourceType: item.resourceType as WriteQueueItem["resourceType"],
      resourceId: item.resourceId,
      body: item.body,
      enqueuedAt: Date.now(),
      retryCount: 0,
      ...(item.patientId !== undefined ? { patientId: item.patientId } : {}),
      ...(item.encounterId !== undefined ? { encounterId: item.encounterId } : {}),
    });
    await db.deadLetter.delete(item.id);
  }
}

/**
 * Derives sync status for a capture from the live queue tables.
 * - failed  → dead-lettered items reference this MRN
 * - queued  → items still in writeQueue reference this MRN
 * - synced  → identity map has resolved this MRN to a server UUID
 */
export async function getCaptureStatus(mrn: string): Promise<CaptureStatus> {
  const dead = await db.deadLetter.where("patientId").equals(mrn).count();
  if (dead > 0) return "failed";

  const queued = await db.writeQueue
    .filter((item) => item.patientId === mrn || item.resourceId === mrn)
    .count();
  if (queued > 0) return "queued";

  return "synced";
}
