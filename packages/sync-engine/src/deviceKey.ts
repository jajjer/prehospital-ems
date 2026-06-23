/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import Dexie, { type Table } from "dexie";
import { setEncryptionKey, deriveKeyFromPassphrase } from "./crypto.js";

/**
 * Provisions the at-rest encryption key for the field app and installs it via
 * {@link setEncryptionKey}.
 *
 * Key lifecycle (see SECURITY.md):
 *  - With a user secret (app-lock PIN, issue #2): the key is derived from the
 *    PIN + a per-device salt via PBKDF2. The key material exists only while the
 *    app is unlocked — the strongest option, and the intended steady state.
 *  - Without a user secret (current interim state): a non-extractable AES-GCM
 *    device key is generated once and persisted in the browser keystore. Its raw
 *    bytes never leave the crypto subsystem, so a raw IndexedDB/disk dump yields
 *    ciphertext only. It is recoverable by code running in the app's own origin,
 *    which is why the PIN layer (#2) is required to fully close the lost-device
 *    threat.
 */

interface KeyMetaRow {
  id: string;
  salt?: Uint8Array;
  deviceKey?: CryptoKey;
}

/**
 * Separate, tiny database so key material is isolated from PHI tables and so
 * adding it never forces a schema bump on the main sync database.
 */
class KeyStoreDatabase extends Dexie {
  meta!: Table<KeyMetaRow, string>;
  constructor() {
    super("prehospital-ems-keystore");
    this.version(1).stores({ meta: "id" });
  }
}

let keyStore: KeyStoreDatabase | null = null;
function getKeyStore(): KeyStoreDatabase {
  return (keyStore ??= new KeyStoreDatabase());
}

const SALT_ID = "device-salt";
const DEVICE_KEY_ID = "device-key";

async function getOrCreateSalt(db: KeyStoreDatabase): Promise<Uint8Array> {
  const existing = await db.meta.get(SALT_ID);
  if (existing?.salt) return existing.salt;
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  await db.meta.put({ id: SALT_ID, salt });
  return salt;
}

async function getOrCreateDeviceKey(db: KeyStoreDatabase): Promise<CryptoKey> {
  const existing = await db.meta.get(DEVICE_KEY_ID);
  if (existing?.deviceKey) return existing.deviceKey;
  // extractable: false — the browser persists an opaque handle, not raw bytes.
  const key = await globalThis.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  await db.meta.put({ id: DEVICE_KEY_ID, deviceKey: key });
  return key;
}

export interface InitEncryptionOptions {
  /**
   * User secret (e.g. app-lock PIN). When provided, the at-rest key is derived
   * from it via PBKDF2 over the per-device salt. Supplied by the app-lock flow
   * (issue #2).
   */
  userSecret?: string;
}

/**
 * Resolve the at-rest encryption key and install it. Call once on app start
 * (and again after unlocking with a PIN, once issue #2 lands) before any PHI
 * read or write.
 */
export async function initEncryption(options: InitEncryptionOptions = {}): Promise<void> {
  const db = getKeyStore();
  const salt = await getOrCreateSalt(db);

  if (options.userSecret) {
    setEncryptionKey(await deriveKeyFromPassphrase(options.userSecret, salt));
    return;
  }

  setEncryptionKey(await getOrCreateDeviceKey(db));
}
