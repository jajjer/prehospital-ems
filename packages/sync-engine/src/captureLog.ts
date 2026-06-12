import { db, type CaptureLogEntry } from "./db.js";

export async function logCapture(entry: CaptureLogEntry): Promise<void> {
  await db.captureLog.put(entry);
}

export type CaptureStatus = "synced" | "queued" | "failed";

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
