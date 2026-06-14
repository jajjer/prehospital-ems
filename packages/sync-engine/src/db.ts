/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import Dexie, { type Table } from "dexie";

export interface WriteQueueItem {
  id: string;
  resourceType: "Patient" | "Encounter" | "Observation" | "Condition";
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
}

export class SyncDatabase extends Dexie {
  writeQueue!: Table<WriteQueueItem, string>;
  deadLetter!: Table<DeadLetterItem, string>;
  identityMap!: Table<IdentityMapEntry, string>;
  captureLog!: Table<CaptureLogEntry, string>;
  concepts!: Table<ConceptCacheEntry, string>;

  constructor() {
    super("prehospital-ems-sync");

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
  }
}

export const db = new SyncDatabase();
