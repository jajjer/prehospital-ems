/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { encryptString, decryptString, isUnlocked } from "./crypto.js";
import { getKeyStore, type TokenRow } from "./keystore.js";

/**
 * Auth-token storage (issue #3).
 *
 * Access tokens, the OAuth2 refresh token, and the Basic-auth header used to
 * predate this module as plaintext in `sessionStorage` — readable by any
 * injected script and, for the refresh token, persisted across reloads in the
 * clear. This module replaces that with two layers:
 *
 *  1. **In memory.** The active auth header and refresh token live in module
 *     state for the unlocked session and are the single source of truth the app
 *     and sync worker read. They are never written to web storage in plaintext.
 *  2. **Encrypted at rest.** So the session survives a reload (a service-worker
 *     update reloads the page mid-shift), the same values are persisted to the
 *     keystore as AES-GCM envelopes under the PHI data key. A stolen, locked
 *     device therefore yields only ciphertext, and the tokens are wiped together
 *     with the keystore on logout, remote wipe, or brute-force auto-wipe.
 *
 * Persistence is gated on {@link isUnlocked}: while the app is locked (no data
 * key in memory) tokens are held in memory only and reconciled to disk once the
 * app unlocks ({@link reconcileTokenStorage}). This keeps token writes off the
 * crypto key-gate, so they never block on an app that has not unlocked yet.
 */

const AUTH_ROW = "auth-header";
const REFRESH_ROW = "refresh-token";

/** Build a token row, omitting `expiresAt` entirely when unknown (strict optionals). */
function tokenRow(id: string, ciphertext: string, expiresAt: number | null): TokenRow {
  return expiresAt === null ? { id, ciphertext } : { id, ciphertext, expiresAt };
}

let memAuthHeader: string | null = null;
let memRefreshToken: string | null = null;
let memTokenExpiry: number | null = null;

/** The active auth header (Bearer or Basic), or null. Synchronous, in-memory. */
export function getAuthHeader(): string | null {
  return memAuthHeader;
}

/** The active OAuth2 refresh token, or null. Synchronous, in-memory. */
export function getRefreshToken(): string | null {
  return memRefreshToken;
}

/** The access-token expiry (epoch ms), or null if unknown. */
export function getTokenExpiry(): number | null {
  return memTokenExpiry;
}

/**
 * Set the active auth header. Held in memory and, when the app is unlocked,
 * persisted encrypted at rest. Never written to web storage in plaintext.
 */
export async function setAuthHeader(header: string): Promise<void> {
  memAuthHeader = header;
  if (!isUnlocked()) return;
  try {
    await getKeyStore().tokens.put({ id: AUTH_ROW, ciphertext: await encryptString(header) });
  } catch {
    // Persistence is best-effort; the in-memory copy still works this session.
  }
}

/**
 * Set (or clear, with `null`) the refresh token and the access-token expiry.
 * Persisted encrypted at rest when unlocked.
 */
export async function setRefreshToken(token: string | null, expiresAt: number | null): Promise<void> {
  memRefreshToken = token;
  memTokenExpiry = expiresAt;
  if (!isUnlocked()) return;
  try {
    const store = getKeyStore();
    if (token) {
      await store.tokens.put(tokenRow(REFRESH_ROW, await encryptString(token), expiresAt));
    } else {
      await store.tokens.delete(REFRESH_ROW);
    }
  } catch {
    // Best-effort persistence.
  }
}

/**
 * Reconcile the in-memory tokens with the encrypted store after an unlock:
 * load persisted tokens into memory on a fresh page load, or flush
 * in-memory tokens to disk when they were set while still locked (e.g. an
 * OAuth2 redirect completed before the PIN was entered). Returns the auth
 * header now in effect. Safe to call repeatedly.
 */
export async function reconcileTokenStorage(): Promise<string | null> {
  if (!isUnlocked()) return memAuthHeader;
  try {
    const store = getKeyStore();

    if (memAuthHeader) {
      await store.tokens.put({ id: AUTH_ROW, ciphertext: await encryptString(memAuthHeader) });
    } else {
      const row = await store.tokens.get(AUTH_ROW);
      if (row) memAuthHeader = await decryptString(row.ciphertext);
    }

    if (memRefreshToken) {
      await store.tokens.put(tokenRow(REFRESH_ROW, await encryptString(memRefreshToken), memTokenExpiry));
    } else {
      const row = await store.tokens.get(REFRESH_ROW);
      if (row) {
        memRefreshToken = await decryptString(row.ciphertext);
        memTokenExpiry = row.expiresAt ?? null;
      }
    }
  } catch {
    // Degrade to whatever is already in memory rather than blocking sign-in.
  }
  return memAuthHeader;
}

/**
 * Drop all tokens from memory and from the encrypted store. Called on logout;
 * the keystore is also deleted wholesale by {@link ./wipe.wipeLocalData}.
 */
export async function clearTokens(): Promise<void> {
  memAuthHeader = null;
  memRefreshToken = null;
  memTokenExpiry = null;
  try {
    await getKeyStore().tokens.bulkDelete([AUTH_ROW, REFRESH_ROW]);
  } catch {
    // The keystore may already be gone (wipe path); nothing left to clear.
  }
}

/**
 * Reset only the in-memory token state. Used by the wipe path, where the
 * keystore database itself is deleted, so the persisted rows go with it.
 */
export function resetTokenMemory(): void {
  memAuthHeader = null;
  memRefreshToken = null;
  memTokenExpiry = null;
}
