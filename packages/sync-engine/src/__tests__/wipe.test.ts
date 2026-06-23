/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { wipeLocalData } from "../wipe.js";
import { enqueue } from "../syncWorker.js";
import { logCapture } from "../captureLog.js";
import { db, SYNC_DB_NAME } from "../db.js";
import { KEYSTORE_DB_NAME, getKeyStore, deleteKeyStore } from "../keystore.js";
import { isUnlocked, lockEncryption } from "../crypto.js";
import { initAppLock } from "../appLock.js";

function dbExists(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let existed = true;
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => { existed = false; };
    req.onsuccess = () => { req.result.close(); resolve(existed); };
    req.onerror = () => resolve(false);
  });
}

beforeEach(async () => {
  await deleteKeyStore();
  lockEncryption();
  await db.open();
  await Promise.all([db.writeQueue.clear(), db.captureLog.clear()]);
});

describe("wipeLocalData", () => {
  it("deletes all PHI tables and the keystore, and re-arms the lock", async () => {
    await initAppLock();
    await enqueue({ id: "q-1", resourceType: "Patient", resourceId: "P-1", body: "{}" });
    await logCapture({
      mrn: "M-1", capturedAt: 1, sex: "female", approximateAge: 30,
      complaint: "x", vitalsJson: "{}",
    });
    await getKeyStore().meta.put({ id: "marker", deviceId: "keep" });

    expect(await dbExists(SYNC_DB_NAME)).toBe(true);
    expect(await dbExists(KEYSTORE_DB_NAME)).toBe(true);

    await wipeLocalData();

    expect(await dbExists(SYNC_DB_NAME)).toBe(false);
    expect(await dbExists(KEYSTORE_DB_NAME)).toBe(false);
    // The encryption gate is re-armed: no key is held after a wipe.
    expect(isUnlocked()).toBe(false);
  });
});
