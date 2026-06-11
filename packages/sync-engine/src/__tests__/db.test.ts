import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { SyncDatabase } from "../db.js";

// Give each test its own isolated IDB instance — prevents cross-test state
let db: SyncDatabase;

beforeEach(() => {
  // fake-indexeddb/auto (setup.ts) sets globalThis.indexedDB; new IDBFactory
  // per test ensures clean state between tests.
  globalThis.indexedDB = new IDBFactory();
  db = new SyncDatabase();
});

describe("writeQueue", () => {
  it("enqueues and retrieves a Patient item", async () => {
    await db.writeQueue.put({
      id: "q-001",
      resourceType: "Patient",
      resourceId: "res-001",
      body: "{}",
      enqueuedAt: Date.now(),
      retryCount: 0,
    });

    const item = await db.writeQueue.get("q-001");
    expect(item?.resourceType).toBe("Patient");
  });

  it("can update retryCount", async () => {
    await db.writeQueue.put({
      id: "q-002",
      resourceType: "Encounter",
      resourceId: "res-002",
      body: "{}",
      enqueuedAt: Date.now(),
      retryCount: 0,
    });

    await db.writeQueue.update("q-002", { retryCount: 3 });
    const item = await db.writeQueue.get("q-002");
    expect(item?.retryCount).toBe(3);
  });
});

describe("deadLetter", () => {
  it("stores a dead-letter entry with patientId", async () => {
    await db.deadLetter.put({
      id: "dl-001",
      resourceType: "Encounter",
      resourceId: "enc-001",
      patientId: "pat-001",
      encounterId: undefined as string | undefined,
      statusCode: 422,
      body: "{}",
      failedAt: Date.now(),
    });

    const entry = await db.deadLetter.get("dl-001");
    expect(entry?.patientId).toBe("pat-001");
    expect(entry?.statusCode).toBe(422);
  });
});

describe("identityMap", () => {
  it("stores and retrieves a provisional → server UUID mapping", async () => {
    await db.identityMap.put({
      provisionalId: "PROV-abc12345",
      serverUUID: "srv-uuid-xyz",
      resourceType: "Patient",
      resolvedAt: Date.now(),
    });

    const entry = await db.identityMap.get("PROV-abc12345");
    expect(entry?.serverUUID).toBe("srv-uuid-xyz");
  });
});
