/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import Dexie, { type Table } from "dexie";

export interface WriteQueueItem {
  id: string;
  resourceType: "Patient" | "Encounter" | "Observation" | "Condition" | "MedicationAdministration" | "Procedure";
  resourceId: string;
  body: string;
  enqueuedAt: number;
  retryCount: number;
  patientId?: string;
  encounterId?: string;
}

export interface DeadLetterItem {
  id: string;
  resourceType: string;
  resourceId: string;
  patientId: string | undefined;
  encounterId: string | undefined;
  statusCode: number;
  body: string;
  failedAt: number;
}

/**
 * A sync conflict detected during flush: a resource this device captured already
 * existed on the server, created/edited concurrently by another responder or the
 * receiving facility. Persisted as an audit record and surfaced in the Records
 * screen for human resolution — we never silently overwrite clinical PHI.
 */
export interface ConflictLogEntry {
  /** writeQueue item id that triggered the conflict — primary key. */
  id: string;
  resourceType: string;
  resourceId: string;
  /** Provisional MRN this conflict belongs to, for linking back to a captureLog row. */
  mrn: string;
  /** Server UUID of the pre-existing resource this local write was reconciled to. */
  serverUUID: string;
  /** When the local resource was enqueued on this device (Unix ms). */
  localEnqueuedAt: number;
  /** meta.lastUpdated of the server copy at detection time (Unix ms), if provided. */
  serverLastUpdated: number | undefined;
  /** When the conflict was detected during flush (Unix ms). */
  detectedAt: number;
  /** Human-resolution state — "unresolved" until a responder reviews it.
   *  "kept-server": accept the server copy (this device's details were not applied).
   *  "kept-local": responder will re-apply this device's details manually at handoff. */
  resolution: "unresolved" | "kept-server" | "kept-local";
  /** When a responder resolved the conflict (Unix ms), if resolved. */
  resolvedAt: number | undefined;
  /** The local body that was NOT applied to the server, kept for audit / manual
   *  merge. PHI — encrypted at rest. */
  localBody: string;
}

export interface IdentityMapEntry {
  provisionalId: string;
  serverUUID: string;
  resourceType: "Patient" | "Encounter";
  resolvedAt: number;
}

export interface ConceptCacheEntry {
  /** OpenMRS concept UUID — primary key */
  uuid: string;
  /** CIEL numeric concept ID for lookup */
  cielId: string;
  /** Display name for the concept */
  display: string;
  /** UCUM unit string, if applicable */
  unit?: string;
  cachedAt: number;
}

export interface CaptureLogEntry {
  /** Provisional MRN — primary key, links to writeQueue.patientId and identityMap */
  mrn: string;
  capturedAt: number;
  sex: "male" | "female" | "unknown";
  approximateAge: number | undefined;
  complaint: string;
  /** JSON.stringify(VitalsInput) — avoids a cross-package type dep in the DB layer */
  vitalsJson: string;
  /** Written "pending" before FHIR resources are enqueued; updated to "complete" after.
   *  A crash between these two writes leaves "pending" — detected on next mount. */
  submissionStatus?: "pending" | "complete";
  /** Provisional encounter ID (ENC-xxxxxxxx) — stored at capture time so finalizeEncounter
   *  can resolve it to a server UUID via the identity map. Absent on pre-LMIC-4 records. */
  encounterId?: string;
  /** Unix ms timestamp set when the encounter was PATCHed to "finished" on handoff. */
  handoffAt?: number;
  /** GPS coordinates captured at submission time. Absent if geolocation was unavailable
   *  or timed out. Used by the dispatch map to pin the incident location. */
  lat?: number;
  lng?: number;
  /** True when this device joined an existing call rather than creating a new patient.
   *  The encounterId field holds the server encounter UUID directly — no identityMap lookup. */
  joined?: boolean;
  /** Patient reference used as the Observation `subject` for repeat vitals sets.
   *  For joined calls this is the server Patient UUID (the local mrn is never enqueued);
   *  absent for own captures, where the provisional mrn resolves via the identity map. */
  patientRef?: string;
  /** JSON-encoded array of additional timestamped vitals sets captured against this same
   *  encounter after the initial submission (serial/repeat vitals over transport).
   *  Shape: Array<{ capturedAt: number; vitalsJson: string }>. The initial set lives in
   *  `vitalsJson`/`capturedAt`; this holds every re-take. PHI — encrypted at rest. */
  repeatVitalsJson?: string;
  /** JSON-encoded array of interventions/treatments captured against this encounter
   *  (medications, O2/airway, CPR, splinting, IV/fluids…). Each entry is an
   *  `InterventionInput` plus a `capturedAt` timestamp; the corresponding FHIR
   *  MedicationAdministration/Procedure resources are enqueued separately.
   *  PHI — encrypted at rest. */
  interventionsJson?: string;
  /** JSON-encoded `AssessmentInput` — the expanded clinical assessment captured with
   *  this record (GCS E/V/M, AVPU, pain, glucose, pupils, allergies, meds, history,
   *  mechanism of injury, narrative). The corresponding FHIR Observation/Condition
   *  resources are enqueued separately. PHI — encrypted at rest. */
  assessmentJson?: string;
}

export const SYNC_DB_NAME = "prehospital-ems-sync";

export class SyncDatabase extends Dexie {
  writeQueue!: Table<WriteQueueItem, string>;
  deadLetter!: Table<DeadLetterItem, string>;
  identityMap!: Table<IdentityMapEntry, string>;
  captureLog!: Table<CaptureLogEntry, string>;
  concepts!: Table<ConceptCacheEntry, string>;
  conflictLog!: Table<ConflictLogEntry, string>;

  constructor() {
    super(SYNC_DB_NAME);

    // Close this connection when another tab/SW wants to upgrade the schema,
    // so the upgrade isn't blocked indefinitely.
    this.on("versionchange", () => { this.close(); });

    // v1 baseline
    this.version(1).stores({
      writeQueue: "id, resourceType, resourceId, enqueuedAt, retryCount, [patientId], [encounterId]",
      deadLetter: "id, resourceType, resourceId, failedAt",
      identityMap: "provisionalId, serverUUID, resourceType",
    });

    // v2: add captureLog for local record-keeping / history screen
    this.version(2).stores({
      writeQueue: "id, resourceType, resourceId, enqueuedAt, retryCount, [patientId], [encounterId]",
      deadLetter: "id, resourceType, resourceId, failedAt",
      identityMap: "provisionalId, serverUUID, resourceType",
      captureLog: "mrn, capturedAt",
    });

    // v3: index patientId on deadLetter so getCaptureStatus can query it
    this.version(3).stores({
      writeQueue: "id, resourceType, resourceId, enqueuedAt, retryCount, [patientId], [encounterId]",
      deadLetter: "id, resourceType, resourceId, patientId, failedAt",
      identityMap: "provisionalId, serverUUID, resourceType",
      captureLog: "mrn, capturedAt",
    });

    // v4 (M2): add encounterId index on deadLetter + concepts table for CIEL caching.
    // Bundled into one version so M2 doesn't require a v5 mid-deployment.
    // concepts schema is a placeholder — non-indexed fields can be added without a bump.
    this.version(4).stores({
      writeQueue: "id, resourceType, resourceId, enqueuedAt, retryCount, [patientId], [encounterId]",
      deadLetter: "id, resourceType, resourceId, patientId, encounterId, failedAt",
      identityMap: "provisionalId, serverUUID, resourceType",
      captureLog: "mrn, capturedAt",
      concepts: "uuid, cielId",
    });

    // v5: add conflictLog — concurrent-edit conflicts surfaced for human resolution.
    // Indexed by mrn (Records-screen lookup) and resolution (unresolved-count badge).
    this.version(5).stores({
      writeQueue: "id, resourceType, resourceId, enqueuedAt, retryCount, [patientId], [encounterId]",
      deadLetter: "id, resourceType, resourceId, patientId, encounterId, failedAt",
      identityMap: "provisionalId, serverUUID, resourceType",
      captureLog: "mrn, capturedAt",
      concepts: "uuid, cielId",
      conflictLog: "id, resourceType, mrn, resolution, detectedAt",
    });
  }
}

export const db = new SyncDatabase();
