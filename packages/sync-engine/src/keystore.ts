/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import Dexie, { type Table } from "dexie";

/**
 * Tiny, dedicated database for key material and app-lock metadata, kept separate
 * from the PHI tables so it can be reasoned about (and wiped) independently and
 * so adding to it never forces a schema bump on the main sync database.
 *
 * It holds, by row id:
 *  - `device-salt`  — random per-device salt for PBKDF2 (not secret).
 *  - `device-kek`   — the non-extractable device key-encryption key (interim
 *                     unlock mode; deleted once a PIN is set).
 *  - `dek`          — the data key, wrapped under the active KEK, plus the wrap
 *                     IV, the wrap mode, and the PBKDF2 iteration count.
 *  - `lock`         — failed-unlock attempt counter.
 *  - `device-id`    — opaque per-device identifier for remote-wipe addressing.
 *
 * The raw data key is never stored; only its wrapped form. See SECURITY.md.
 */
export interface KeyMetaRow {
  id: string;
  /** Per-device PBKDF2 salt (`device-salt`). */
  salt?: Uint8Array;
  /** Non-extractable device key-encryption key (`device-kek`). */
  deviceKek?: CryptoKey;
  /** Data key encrypted under the active KEK (`dek`). */
  wrappedDek?: Uint8Array;
  /** IV used to wrap the data key (`dek`). */
  wrapIv?: Uint8Array;
  /** Which KEK the data key is currently wrapped under (`dek`). */
  wrapMode?: "device" | "pin";
  /** PBKDF2 iterations used for the PIN-derived KEK (`dek`). */
  pinIterations?: number;
  /** Consecutive failed unlock attempts (`lock`). */
  failedAttempts?: number;
  /** Opaque per-device id (`device-id`). */
  deviceId?: string;
}

export const KEYSTORE_DB_NAME = "prehospital-ems-keystore";

class KeyStoreDatabase extends Dexie {
  meta!: Table<KeyMetaRow, string>;
  constructor() {
    super(KEYSTORE_DB_NAME);
    this.version(1).stores({ meta: "id" });
  }
}

let keyStore: KeyStoreDatabase | null = null;

export function getKeyStore(): KeyStoreDatabase {
  return (keyStore ??= new KeyStoreDatabase());
}

/** Drop and delete the keystore database (used by the wipe path). */
export async function deleteKeyStore(): Promise<void> {
  const db = getKeyStore();
  db.close();
  keyStore = null;
  await Dexie.delete(KEYSTORE_DB_NAME);
}
