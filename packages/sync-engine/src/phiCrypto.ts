/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { encryptString, decryptString, encryptField, decryptField, isEnvelope } from "./crypto.js";
import type { CaptureLogEntry } from "./db.js";

/**
 * Field-level PHI encryption helpers.
 *
 * These run OUTSIDE IndexedDB transactions: encrypt before handing a record to
 * Dexie, decrypt after Dexie returns it. This is mandatory because AES-GCM via
 * WebCrypto is asynchronous, and an IndexedDB transaction auto-commits the
 * moment control yields to a non-IDB promise. Doing the crypto at the call site
 * (rather than inside a Dexie middleware) keeps every write a single synchronous
 * transaction over already-ciphertext values.
 *
 * Cleartext, by table:
 *  - writeQueue/deadLetter: everything except `body` (ids, indexes, timestamps).
 *  - captureLog: mrn, capturedAt, submissionStatus, encounterId, handoffAt,
 *    joined, patientRef — identifiers/state used for indexing and reference resolution.
 */

/** captureLog columns holding patient data. Keep in sync with SECURITY.md. */
const CAPTURE_PHI_FIELDS = [
  "sex",
  "approximateAge",
  "complaint",
  "vitalsJson",
  "repeatVitalsJson",
  "interventionsJson",
  "assessmentJson",
  "lat",
  "lng",
] as const satisfies readonly (keyof CaptureLogEntry)[];

/** Encrypt a FHIR resource body string for at-rest storage. */
export function encryptBody(body: string): Promise<string> {
  return encryptString(body);
}

/** Decrypt a stored FHIR resource body back to its original JSON string. */
export function decryptBody(stored: string): Promise<string> {
  return decryptString(stored);
}

/** Returns a copy of a capture entry with PHI fields encrypted, ready to store. */
export async function encryptCapture(entry: CaptureLogEntry): Promise<CaptureLogEntry> {
  const out = { ...entry } as Record<string, unknown>;
  for (const field of CAPTURE_PHI_FIELDS) {
    if (out[field] !== undefined && !isEnvelope(out[field])) {
      out[field] = await encryptField(out[field]);
    }
  }
  return out as unknown as CaptureLogEntry;
}

/** Returns a copy of a stored capture entry with PHI fields decrypted. */
export async function decryptCapture<T extends CaptureLogEntry | undefined>(entry: T): Promise<T> {
  if (!entry) return entry;
  const out = { ...entry } as Record<string, unknown>;
  for (const field of CAPTURE_PHI_FIELDS) {
    if (isEnvelope(out[field])) {
      out[field] = await decryptField(out[field]);
    }
  }
  return out as unknown as T;
}
