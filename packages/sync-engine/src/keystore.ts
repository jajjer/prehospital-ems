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

/**
 * An auth token (access/auth header or refresh token) held encrypted at rest.
 *
 * The ciphertext is an AES-GCM envelope produced under the same data key that
 * protects PHI, so a stolen, locked device yields only ciphertext — there is no
 * plaintext token on disk. `expiresAt` is the access-token expiry (epoch ms); it
 * is not sensitive and is kept in cleartext so a proactive refresh can be
 * scheduled without first unwrapping the token. See {@link ./tokenStore} and
 * SECURITY.md.
 */
export interface TokenRow {
  id: string;
  /** AES-GCM `enc:v1:…` envelope of the token string. */
  ciphertext: string;
  /** Access-token expiry, epoch ms (not secret). */
  expiresAt?: number;
}

export const KEYSTORE_DB_NAME = "prehospital-ems-keystore";

class KeyStoreDatabase extends Dexie {
  meta!: Table<KeyMetaRow, string>;
  tokens!: Table<TokenRow, string>;
  constructor() {
    super(KEYSTORE_DB_NAME);
    this.version(1).stores({ meta: "id" });
    // v2 adds the encrypted auth-token table (issue #3). The existing `meta`
    // store is unchanged, so installs upgrade in place without touching the
    // wrapped data key or any PHI.
    this.version(2).stores({ meta: "id", tokens: "id" });
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
