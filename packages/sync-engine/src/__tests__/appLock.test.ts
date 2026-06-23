/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  initAppLock,
  setupPin,
  unlockWithPin,
  isPinSet,
  changePin,
  getFailedAttempts,
  lock,
  getDeviceId,
  MAX_PIN_ATTEMPTS,
  MIN_PIN_LENGTH,
} from "../appLock.js";
import { encryptString, decryptString, isUnlocked, lockEncryption } from "../crypto.js";
import { deleteKeyStore, getKeyStore, KEYSTORE_DB_NAME } from "../keystore.js";
import { SYNC_DB_NAME } from "../db.js";

/** Does an IndexedDB database currently exist? */
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
  // Simulate a pristine device: drop the keystore and re-arm the encryption gate.
  await deleteKeyStore();
  lockEncryption();
});

describe("initAppLock", () => {
  it("bootstraps device-key mode on first launch and installs a usable key", async () => {
    const state = await initAppLock();
    expect(state).toEqual({ pinSet: false, locked: false, mode: "device" });
    expect(isUnlocked()).toBe(true);
    // The installed key can encrypt and decrypt.
    expect(await decryptString(await encryptString("hi"))).toBe("hi");
  });

  it("re-opens silently in device mode on a subsequent launch", async () => {
    await initAppLock();
    const envelope = await encryptString("vitals");

    lockEncryption(); // simulate the app closing
    const state = await initAppLock();

    expect(state.mode).toBe("device");
    expect(state.locked).toBe(false);
    // Same data key — ciphertext written before the relaunch still decrypts.
    expect(await decryptString(envelope)).toBe("vitals");
  });

  it("reports locked (without installing a key) when a PIN is set", async () => {
    await initAppLock();
    await setupPin("1234");

    lockEncryption(); // simulate the app closing
    const state = await initAppLock();

    expect(state).toEqual({ pinSet: true, locked: true, mode: "pin" });
    expect(isUnlocked()).toBe(false);
  });
});

describe("setupPin + unlockWithPin", () => {
  it("keeps existing PHI readable after a PIN is set (no re-encryption)", async () => {
    await initAppLock();
    const envelope = await encryptString("Jane Doe, chest pain");

    await setupPin("4321");
    expect(await isPinSet()).toBe(true);

    lockEncryption(); // relaunch
    await initAppLock();
    const result = await unlockWithPin("4321");

    expect(result.ok).toBe(true);
    expect(isUnlocked()).toBe(true);
    // Proves the data key survived the PIN change unchanged.
    expect(await decryptString(envelope)).toBe("Jane Doe, chest pain");
  });

  it("removes the device key so it can no longer unlock once a PIN is set", async () => {
    await initAppLock();
    await setupPin("0000");
    const deviceKek = await getKeyStore().meta.get("device-kek");
    expect(deviceKek).toBeUndefined();
  });

  it("rejects PINs shorter than the minimum", async () => {
    await initAppLock();
    await expect(setupPin("1".repeat(MIN_PIN_LENGTH - 1))).rejects.toThrow();
  });

  it("refuses to set a PIN while locked", async () => {
    await initAppLock();
    await setupPin("1234");
    lock();
    await expect(setupPin("5678")).rejects.toThrow(/unlocked/);
  });

  it("rejects a wrong PIN and counts the attempt", async () => {
    await initAppLock();
    await setupPin("1234");
    lock();

    const result = await unlockWithPin("9999");
    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(MAX_PIN_ATTEMPTS - 1);
    expect(isUnlocked()).toBe(false);
    expect(await getFailedAttempts()).toBe(1);
  });

  it("resets the attempt counter after a successful unlock", async () => {
    await initAppLock();
    await setupPin("1234");
    lock();

    await unlockWithPin("0000"); // wrong
    expect(await getFailedAttempts()).toBe(1);
    const ok = await unlockWithPin("1234"); // right
    expect(ok.ok).toBe(true);
    expect(await getFailedAttempts()).toBe(0);
  });
});

describe("changePin", () => {
  it("re-wraps under the new PIN and keeps PHI readable", async () => {
    await initAppLock();
    const envelope = await encryptString("secret");
    await setupPin("1111");

    const changed = await changePin("1111", "2222");
    expect(changed.ok).toBe(true);

    lockEncryption();
    await initAppLock();
    expect((await unlockWithPin("1111")).ok).toBe(false);
    expect((await unlockWithPin("2222")).ok).toBe(true);
    expect(await decryptString(envelope)).toBe("secret");
  });

  it("fails (and does not change the PIN) when the current PIN is wrong", async () => {
    await initAppLock();
    await setupPin("1111");
    const changed = await changePin("9999", "2222");
    expect(changed.ok).toBe(false);
    lockEncryption();
    await initAppLock();
    expect((await unlockWithPin("1111")).ok).toBe(true);
  });
});

describe("auto-wipe on too many attempts", () => {
  it("wipes local data after MAX_PIN_ATTEMPTS consecutive failures", async () => {
    await initAppLock();
    await setupPin("1234");
    lock();

    let last;
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
      last = await unlockWithPin("0000");
    }
    expect(last?.wiped).toBe(true);
    expect(await dbExists(KEYSTORE_DB_NAME)).toBe(false);
    expect(await dbExists(SYNC_DB_NAME)).toBe(false);
  });
});

describe("getDeviceId", () => {
  it("returns a stable id across calls", async () => {
    await initAppLock();
    const a = await getDeviceId();
    const b = await getDeviceId();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});
