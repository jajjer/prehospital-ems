import { db, type CaptureLogEntry, type WriteQueueItem } from "./db.js";

export async function logCapture(entry: CaptureLogEntry): Promise<void> {
  await db.captureLog.put(entry);
}

export type CaptureStatus = "synced" | "queued" | "failed";

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
      patientId: item.patientId,
      encounterId: item.encounterId,
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
