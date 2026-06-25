/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import Dexie from "dexie";
import { db, SYNC_DB_NAME } from "./db.js";
import { lockEncryption } from "./crypto.js";
import { deleteKeyStore } from "./keystore.js";
import { resetTokenMemory } from "./tokenStore.js";

/**
 * Irrecoverably clear all local data: every PHI table and all key material.
 *
 * This backs both the lost-device defenses for issue #2 — the auto-wipe after
 * too many failed PIN attempts and the admin-triggered remote wipe. After this
 * resolves there is no plaintext, no ciphertext, and no key on the device: the
 * data key is destroyed along with the keystore, so even an attacker who later
 * recovers the (already-deleted) PHI tables has nothing to decrypt them with.
 *
 * The encryption gate is re-armed first so any in-flight database access blocks
 * rather than racing the deletion. The encrypted auth tokens live in the
 * keystore and so are destroyed with it; the in-memory copies are dropped here.
 */
export async function wipeLocalData(): Promise<void> {
  lockEncryption();
  resetTokenMemory();
  db.close();
  await Dexie.delete(SYNC_DB_NAME);
  await deleteKeyStore();
}
