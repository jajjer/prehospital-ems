/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { encryptString, decryptString, isUnlocked } from "./crypto.js";
import { getKeyStore } from "./keystore.js";

/**
 * Authenticated-user identity (issue #13).
 *
 * Field-record amendments must be tied to an authenticated identity, but the app
 * previously kept only an opaque auth header — never *who* was signed in. This
 * module captures the OpenMRS user behind the current session so the audit trail
 * can attribute corrections, and so attribution survives offline: the identity is
 * fetched once at sign-in (when the network is necessarily available) and then
 * held in memory and, mirroring {@link ./tokenStore}, persisted as an AES-GCM
 * envelope under the PHI data key so a reload mid-shift keeps the attribution
 * without a round-trip. It is cleared on logout and wiped with the keystore.
 */

/** The authenticated OpenMRS user behind the current session. */
export interface UserIdentity {
  /** OpenMRS user UUID; "" when the session response omitted it. */
  uuid: string;
  /** Display name, e.g. "Super User". */
  display: string;
}

const USER_ROW = "session-user";

let memUser: UserIdentity | null = null;

/** The current authenticated user, or null. Synchronous, in-memory. */
export function getCurrentUser(): UserIdentity | null {
  return memUser;
}

/**
 * Set the current user. Held in memory and, when the app is unlocked, persisted
 * encrypted at rest. Never written to web storage in plaintext.
 */
export async function setCurrentUser(user: UserIdentity): Promise<void> {
  memUser = user;
  if (!isUnlocked()) return;
  try {
    await getKeyStore().tokens.put({ id: USER_ROW, ciphertext: await encryptString(JSON.stringify(user)) });
  } catch {
    // Best-effort persistence; the in-memory copy still attributes this session.
  }
}

/**
 * Reconcile the in-memory identity with the encrypted store after an unlock:
 * load the persisted user on a fresh page load, or flush an in-memory user set
 * while still locked. Returns the identity now in effect. Safe to call repeatedly.
 */
export async function reconcileIdentity(): Promise<UserIdentity | null> {
  if (!isUnlocked()) return memUser;
  try {
    const store = getKeyStore();
    if (memUser) {
      await store.tokens.put({ id: USER_ROW, ciphertext: await encryptString(JSON.stringify(memUser)) });
    } else {
      const row = await store.tokens.get(USER_ROW);
      if (row) memUser = JSON.parse(await decryptString(row.ciphertext)) as UserIdentity;
    }
  } catch {
    // Degrade to whatever is already in memory.
  }
  return memUser;
}

/** Drop the identity from memory and from the encrypted store. Called on logout. */
export async function clearIdentity(): Promise<void> {
  memUser = null;
  try {
    await getKeyStore().tokens.delete(USER_ROW);
  } catch {
    // The keystore may already be gone (wipe path); nothing left to clear.
  }
}

/**
 * Fetch the OpenMRS REST `/session` for the signed-in user and store it. Returns
 * the captured identity, or the already-known one if the request fails (e.g.
 * offline after a reload) — sign-in is online, so identity is captured then.
 */
export async function captureIdentity(restBase: string, authHeader: string): Promise<UserIdentity | null> {
  try {
    const res = await fetch(`${restBase}/session`, { headers: { Authorization: authHeader } });
    if (!res.ok) return memUser;
    const data = await res.json() as { authenticated?: boolean; user?: { uuid?: string; display?: string } };
    if (data.authenticated && data.user?.display) {
      const user: UserIdentity = { uuid: data.user.uuid ?? "", display: data.user.display };
      await setCurrentUser(user);
      return user;
    }
    return memUser;
  } catch {
    return memUser;
  }
}
