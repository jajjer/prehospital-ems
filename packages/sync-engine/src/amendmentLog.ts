/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { db, type AmendmentLogEntry } from "./db.js";
import { encryptString, decryptString } from "./crypto.js";

/**
 * Append-only audit trail of field corrections to a captured record (issue #13).
 *
 * Once a record is captured, a typo'd value can be corrected — but the original,
 * who changed it, and when must remain reconstructable (a clinical-legal
 * requirement). Each correction writes a NEW, immutable row keyed on a fresh id;
 * this module exposes no update or delete, so history is never rewritten. The
 * value columns (previous/new/reason) hold patient data and are encrypted at rest;
 * the actor's identity and timestamps stay cleartext so the log can be indexed and
 * filtered without unwrapping PHI.
 */

/** Plaintext input to {@link recordAmendment}; PHI fields are encrypted on write. */
export interface AmendmentInput {
  mrn: string;
  field: string;
  label: string;
  /** Prior value, plaintext — encrypted at rest before persistence. */
  previousValue: string;
  /** Corrected value, plaintext — encrypted at rest before persistence. */
  newValue: string;
  amendedByDisplay: string;
  amendedByUuid: string | undefined;
  /** Optional reason, plaintext — encrypted at rest before persistence. */
  reason: string | undefined;
  originalSynced: boolean;
}

/**
 * Persist one field correction to the audit trail. Always inserts a fresh,
 * immutable row (a random id), so re-amending the same field appends rather than
 * overwrites. The value columns are encrypted at rest.
 */
export async function recordAmendment(input: AmendmentInput): Promise<void> {
  await db.amendmentLog.add({
    id: crypto.randomUUID(),
    mrn: input.mrn,
    field: input.field,
    label: input.label,
    previousValue: await encryptString(input.previousValue),
    newValue: await encryptString(input.newValue),
    amendedByDisplay: input.amendedByDisplay,
    amendedByUuid: input.amendedByUuid,
    reason: input.reason !== undefined ? await encryptString(input.reason) : undefined,
    amendedAt: Date.now(),
    originalSynced: input.originalSynced,
  });
}

/** Decrypt a stored amendment's PHI value columns for display. */
async function decryptAmendment(entry: AmendmentLogEntry): Promise<AmendmentLogEntry> {
  return {
    ...entry,
    previousValue: await decryptString(entry.previousValue),
    newValue: await decryptString(entry.newValue),
    reason: entry.reason !== undefined ? await decryptString(entry.reason) : undefined,
  };
}

/** All amendments for one capture (by provisional MRN), newest first, decrypted. */
export async function getAmendmentsForMrn(mrn: string): Promise<AmendmentLogEntry[]> {
  const rows = await db.amendmentLog.where("mrn").equals(mrn).toArray();
  rows.sort((a, b) => b.amendedAt - a.amendedAt);
  return Promise.all(rows.map(decryptAmendment));
}
