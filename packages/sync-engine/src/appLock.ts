/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { getKeyStore } from "./keystore.js";
import {
  setEncryptionKey,
  lockEncryption,
  getActiveKey,
  generateDataKey,
  wrapDataKey,
  unwrapDataKey,
  deriveKeyFromPassphrase,
  DEFAULT_PBKDF2_ITERATIONS,
} from "./crypto.js";
import { wipeLocalData } from "./wipe.js";

/**
 * App lock for the field app (issue #2).
 *
 * On a budget Android device that gets lost or stolen, an offline forensic dump
 * is defeated by at-rest encryption — but an attacker who simply unlocks the
 * phone and opens the app is not, as long as the data key is recoverable without
 * a user secret. App lock closes that gap: it gates the data key behind a PIN.
 *
 * The data key is wrapped (see {@link wrapDataKey}); unlocking re-derives the
 * PIN key and unwraps it. Because the data key itself never changes, turning on
 * a PIN, locking, and unlocking never touch the encrypted PHI on disk.
 */

const SALT_ID = "device-salt";
const DEVICE_KEK_ID = "device-kek";
const DEK_ID = "dek";
const LOCK_ID = "lock";
const DEVICE_ID_ID = "device-id";

/** Minimum PIN length. Numeric PINs are the realistic input on field devices. */
export const MIN_PIN_LENGTH = 4;
/** Wipe local data after this many consecutive failed unlock attempts. */
export const MAX_PIN_ATTEMPTS = 10;

export type AppLockMode = "device" | "pin";

export interface AppLockState {
  /** True once a user PIN has been provisioned (the steady state). */
  pinSet: boolean;
  /** True if the app is locked: a PIN is set but the data key is not in memory. */
  locked: boolean;
  /** How the data key is currently wrapped. */
  mode: AppLockMode;
}

type Store = ReturnType<typeof getKeyStore>;

async function getOrCreateSalt(db: Store): Promise<Uint8Array> {
  const existing = await db.meta.get(SALT_ID);
  if (existing?.salt) return existing.salt;
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  await db.meta.put({ id: SALT_ID, salt });
  return salt;
}

async function getOrCreateDeviceKek(db: Store): Promise<CryptoKey> {
  const existing = await db.meta.get(DEVICE_KEK_ID);
  if (existing?.deviceKek) return existing.deviceKek;
  // extractable: false — the browser persists an opaque handle, not raw bytes.
  const key = await globalThis.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  await db.meta.put({ id: DEVICE_KEK_ID, deviceKek: key });
  return key;
}

/**
 * Resolve the at-rest data key and the lock state. Call once on app start.
 *
 * - First ever launch: generate a data key, wrap it under the device key, and
 *   install it (interim device-key mode — usable before a PIN exists).
 * - Returning, no PIN yet: unwrap with the device key and install it.
 * - Returning, PIN set: leave the encryption gate armed and report `locked`.
 *   The caller must show the lock screen and call {@link unlockWithPin}.
 */
export async function initAppLock(): Promise<AppLockState> {
  const db = getKeyStore();
  const salt = await getOrCreateSalt(db);
  const dekRow = await db.meta.get(DEK_ID);

  if (!dekRow?.wrappedDek || !dekRow.wrapIv) {
    // First launch — bootstrap a data key under the device key.
    const deviceKek = await getOrCreateDeviceKek(db);
    const dek = await generateDataKey();
    const { wrapped, iv } = await wrapDataKey(dek, deviceKek);
    await db.meta.put({ id: DEK_ID, wrappedDek: wrapped, wrapIv: iv, wrapMode: "device" });
    setEncryptionKey(dek);
    return { pinSet: false, locked: false, mode: "device" };
  }

  if (dekRow.wrapMode === "pin") {
    // A PIN is required; do not unwrap. Leave the gate armed for unlockWithPin.
    void salt;
    return { pinSet: true, locked: true, mode: "pin" };
  }

  // Device-key mode: unwrap silently and install the data key.
  const deviceKek = await getOrCreateDeviceKek(db);
  const dek = await unwrapDataKey(dekRow.wrappedDek, dekRow.wrapIv, deviceKek);
  setEncryptionKey(dek);
  return { pinSet: false, locked: false, mode: "device" };
}

/** True if a user PIN has been provisioned. */
export async function isPinSet(): Promise<boolean> {
  const row = await getKeyStore().meta.get(DEK_ID);
  return row?.wrapMode === "pin";
}

/**
 * Provision a PIN. Requires the app to be unlocked (a data key in memory): the
 * current data key is re-wrapped under the PIN-derived key, the device key is
 * removed, and the attempt counter is reset. No PHI is re-encrypted.
 */
export async function setupPin(pin: string): Promise<void> {
  if (pin.length < MIN_PIN_LENGTH) {
    throw new Error(`PIN must be at least ${MIN_PIN_LENGTH} characters`);
  }
  const dek = getActiveKey();
  if (!dek) throw new Error("Cannot set a PIN before the app is unlocked");

  const db = getKeyStore();
  const salt = await getOrCreateSalt(db);
  const iterations = DEFAULT_PBKDF2_ITERATIONS;
  const kek = await deriveKeyFromPassphrase(pin, salt, iterations);
  const { wrapped, iv } = await wrapDataKey(dek, kek);

  await db.meta.put({
    id: DEK_ID,
    wrappedDek: wrapped,
    wrapIv: iv,
    wrapMode: "pin",
    pinIterations: iterations,
  });
  // The device key must no longer be able to unwrap the data key on its own.
  await db.meta.delete(DEVICE_KEK_ID);
  await db.meta.put({ id: LOCK_ID, failedAttempts: 0 });
}

export interface UnlockResult {
  ok: boolean;
  /** Attempts left before an automatic wipe (only meaningful when `ok` is false). */
  remaining?: number;
  /** True if this failure triggered an automatic local wipe. */
  wiped?: boolean;
}

/**
 * Attempt to unlock with a PIN. On success the data key is installed and the
 * attempt counter resets. On failure the counter increments; once it reaches
 * {@link MAX_PIN_ATTEMPTS}, local data is wiped to defeat brute force on a
 * stolen device.
 */
export async function unlockWithPin(pin: string): Promise<UnlockResult> {
  const db = getKeyStore();
  const dekRow = await db.meta.get(DEK_ID);
  if (!dekRow?.wrappedDek || !dekRow.wrapIv || dekRow.wrapMode !== "pin") {
    throw new Error("No PIN has been set");
  }

  const salt = await getOrCreateSalt(db);
  const kek = await deriveKeyFromPassphrase(pin, salt, dekRow.pinIterations ?? DEFAULT_PBKDF2_ITERATIONS);

  try {
    const dek = await unwrapDataKey(dekRow.wrappedDek, dekRow.wrapIv, kek);
    setEncryptionKey(dek);
    await db.meta.put({ id: LOCK_ID, failedAttempts: 0 });
    return { ok: true };
  } catch {
    const lock = await db.meta.get(LOCK_ID);
    const failedAttempts = (lock?.failedAttempts ?? 0) + 1;
    if (failedAttempts >= MAX_PIN_ATTEMPTS) {
      await wipeLocalData();
      return { ok: false, wiped: true, remaining: 0 };
    }
    await db.meta.put({ id: LOCK_ID, failedAttempts });
    return { ok: false, remaining: MAX_PIN_ATTEMPTS - failedAttempts };
  }
}

/**
 * Change the PIN. Verifies the current PIN by unlocking with it, then re-wraps
 * the data key under the new PIN.
 */
export async function changePin(currentPin: string, newPin: string): Promise<UnlockResult> {
  const result = await unlockWithPin(currentPin);
  if (!result.ok) return result;
  await setupPin(newPin);
  return { ok: true };
}

/** Consecutive failed unlock attempts so far. */
export async function getFailedAttempts(): Promise<number> {
  const lock = await getKeyStore().meta.get(LOCK_ID);
  return lock?.failedAttempts ?? 0;
}

/**
 * Lock the app: drop the in-memory data key and re-arm the encryption gate.
 * Encrypted PHI on disk and the offline queue are untouched — the next PHI
 * access blocks until {@link unlockWithPin} succeeds.
 */
export function lock(): void {
  lockEncryption();
}

/**
 * A stable, opaque per-device identifier (generated on first call). Used to
 * address this device for remote wipe without exposing any PHI.
 */
export async function getDeviceId(): Promise<string> {
  const db = getKeyStore();
  const existing = await db.meta.get(DEVICE_ID_ID);
  if (existing?.deviceId) return existing.deviceId;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let id = "";
  for (const b of bytes) id += b.toString(16).padStart(2, "0");
  await db.meta.put({ id: DEVICE_ID_ID, deviceId: id });
  return id;
}
