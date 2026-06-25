/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { db, type ConflictLogEntry } from "./db.js";
import { encryptBody, decryptBody } from "./phiCrypto.js";

/** A responder's decision on a surfaced conflict (excludes the initial "unresolved"). */
export type ConflictResolution = "kept-server" | "kept-local";

/** Plaintext input to {@link recordConflict}; the body is encrypted before storage. */
export interface ConflictInput {
  id: string;
  resourceType: string;
  resourceId: string;
  mrn: string;
  serverUUID: string;
  localEnqueuedAt: number;
  serverLastUpdated: number | undefined;
  /** Plaintext local body that was not applied — encrypted at rest before persistence. */
  localBody: string;
}

/**
 * Persist a detected sync conflict for the audit trail. The local body (PHI) is
 * encrypted at rest. Keyed on the writeQueue item id, so a re-detection of the
 * same item overwrites rather than duplicates.
 */
export async function recordConflict(input: ConflictInput): Promise<void> {
  await db.conflictLog.put({
    id: input.id,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    mrn: input.mrn,
    serverUUID: input.serverUUID,
    localEnqueuedAt: input.localEnqueuedAt,
    serverLastUpdated: input.serverLastUpdated,
    detectedAt: Date.now(),
    resolution: "unresolved",
    resolvedAt: undefined,
    localBody: await encryptBody(input.localBody),
  });
}

/** Decrypt a stored conflict's local body for display. */
async function decryptConflict(entry: ConflictLogEntry): Promise<ConflictLogEntry> {
  return { ...entry, localBody: await decryptBody(entry.localBody) };
}

/** Count of conflicts still awaiting human review — for the status-bar badge. */
export async function getUnresolvedConflictCount(): Promise<number> {
  return db.conflictLog.where("resolution").equals("unresolved").count();
}

/** All unresolved conflicts, newest first, with PHI bodies decrypted. */
export async function getUnresolvedConflicts(): Promise<ConflictLogEntry[]> {
  const rows = await db.conflictLog.where("resolution").equals("unresolved").toArray();
  rows.sort((a, b) => b.detectedAt - a.detectedAt);
  return Promise.all(rows.map(decryptConflict));
}

/** Unresolved conflicts for one capture (by provisional MRN), newest first. */
export async function getConflictsForMrn(mrn: string): Promise<ConflictLogEntry[]> {
  const rows = await db.conflictLog.where("mrn").equals(mrn).toArray();
  const unresolved = rows.filter((r) => r.resolution === "unresolved");
  unresolved.sort((a, b) => b.detectedAt - a.detectedAt);
  return Promise.all(unresolved.map(decryptConflict));
}

/** Record a responder's resolution decision (audit trail). */
export async function resolveConflict(id: string, resolution: ConflictResolution): Promise<void> {
  await db.conflictLog.update(id, { resolution, resolvedAt: Date.now() });
}
