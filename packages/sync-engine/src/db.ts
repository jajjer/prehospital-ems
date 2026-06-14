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
