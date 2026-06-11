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

export class SyncDatabase extends Dexie {
  writeQueue!: Table<WriteQueueItem, string>;
  deadLetter!: Table<DeadLetterItem, string>;
  identityMap!: Table<IdentityMapEntry, string>;

  constructor() {
    super("prehospital-ems-sync");

    // v1 baseline — do not change indexes without bumping version and adding upgrade()
    this.version(1).stores({
      writeQueue: "id, resourceType, resourceId, enqueuedAt, retryCount, [patientId], [encounterId]",
      deadLetter: "id, resourceType, resourceId, failedAt",
      identityMap: "provisionalId, serverUUID, resourceType",
      // identityMap maps client provisional MRNs (e.g. "PROV-abc12345") to
      // server-assigned UUIDs after a successful POST. Required because fhir2
      // does not support updateCreate — see design doc for details.
    });

    // v2 (milestone 2): add patientId+encounterId to deadLetter + concepts table
    // this.version(2).stores({
    //   writeQueue: "id, resourceType, resourceId, enqueuedAt, retryCount, [patientId], [encounterId]",
    //   deadLetter: "id, resourceType, resourceId, patientId, encounterId, failedAt",
    //   identityMap: "provisionalId, serverUUID, resourceType",
    //   concepts: "id, system, code",
    // }).upgrade(() => { /* deadLetter fields are nullable — no data migration needed */ });
  }
}

export const db = new SyncDatabase();
