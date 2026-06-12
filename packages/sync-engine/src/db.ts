import Dexie, { type Table } from "dexie";

export interface WriteQueueItem {
  id: string;
  resourceType: "Patient" | "Encounter" | "Observation";
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

export interface CaptureLogEntry {
  /** Provisional MRN — primary key, links to writeQueue.patientId and identityMap */
  mrn: string;
  capturedAt: number;
  sex: "male" | "female" | "unknown";
  approximateAge: number | undefined;
  complaint: string;
  /** JSON.stringify(VitalsInput) — avoids a cross-package type dep in the DB layer */
  vitalsJson: string;
}

export class SyncDatabase extends Dexie {
  writeQueue!: Table<WriteQueueItem, string>;
  deadLetter!: Table<DeadLetterItem, string>;
  identityMap!: Table<IdentityMapEntry, string>;
  captureLog!: Table<CaptureLogEntry, string>;

  constructor() {
    super("prehospital-ems-sync");

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
  }
}

export const db = new SyncDatabase();
