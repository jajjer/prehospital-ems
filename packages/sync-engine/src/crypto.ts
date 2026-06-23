/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */

/**
 * AES-GCM at-rest encryption for PHI stored in IndexedDB.
 *
 * Budget Android field devices get lost and stolen, so patient data must never
 * sit in IndexedDB as plaintext. This module provides the primitives — a held
 * AES-GCM key plus envelope encrypt/decrypt — that the Dexie encryption
 * middleware ({@link ./encryptionMiddleware}) uses to transparently encrypt PHI
 * fields on write and decrypt them on read.
 *
 * The key itself is never persisted in plaintext: it is either derived from a
 * user secret (app-lock PIN) via PBKDF2, or backed by a non-extractable device
 * key in the browser keystore. See {@link ./deviceKey} and SECURITY.md.
 */

/** Marks a value as an AES-GCM envelope produced by this module. */
const ENVELOPE_PREFIX = "enc:v1:";
/** AES-GCM recommends a 96-bit (12-byte) IV. */
const IV_BYTES = 12;
/** OWASP-recommended PBKDF2-SHA256 work factor (2023). */
export const DEFAULT_PBKDF2_ITERATIONS = 210_000;

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto SubtleCrypto is unavailable in this environment");
  return s;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Key store — a single AES-GCM key held for the unlocked session.
//
// getEncryptionKey() returns a promise that resolves once a key is set. The
// middleware awaits it, so database operations issued before the app finishes
// unlocking simply queue until the key is available rather than racing or
// failing. lockEncryption() re-arms the gate, which is what the app-lock /
// session-timeout flow (issue #2) hooks into.
// ---------------------------------------------------------------------------

let currentKey: CryptoKey | null = null;
let resolveKey: ((key: CryptoKey) => void) | null = null;
let keyPromise: Promise<CryptoKey> = new Promise((resolve) => {
  resolveKey = resolve;
});

/** Install the active encryption key, unblocking any queued database operations. */
export function setEncryptionKey(key: CryptoKey): void {
  currentKey = key;
  if (resolveKey) {
    resolveKey(key);
    resolveKey = null;
  } else {
    keyPromise = Promise.resolve(key);
  }
}

/** Resolves with the active key, waiting if the app has not unlocked yet. */
export function getEncryptionKey(): Promise<CryptoKey> {
  return keyPromise;
}

/** True once an encryption key has been installed for this session. */
export function isUnlocked(): boolean {
  return currentKey !== null;
}

/**
 * The active key object, or null if the app is locked. Used by the app-lock
 * flow to re-wrap the in-memory data key under a new key-encryption key (e.g.
 * when a PIN is first set) without re-encrypting any PHI.
 */
export function getActiveKey(): CryptoKey | null {
  return currentKey;
}

/**
 * Drop the in-memory key and re-arm the gate. Subsequent database reads/writes
 * block until {@link setEncryptionKey} is called again (e.g. after re-entering
 * the app-lock PIN). The encrypted data on disk is untouched.
 */
export function lockEncryption(): void {
  currentKey = null;
  keyPromise = new Promise((resolve) => {
    resolveKey = resolve;
  });
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a non-extractable AES-GCM key from a passphrase (user secret / PIN)
 * and a per-device salt using PBKDF2-SHA256. This is the path used once app
 * lock (issue #2) supplies a user secret.
 */
export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const baseKey = await subtle().importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle().deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ---------------------------------------------------------------------------
// Data-key wrapping (envelope-key scheme)
//
// PHI is always encrypted under a single random Data Encryption Key (DEK). The
// DEK never changes for the life of the install, so existing ciphertext stays
// readable no matter how the app is unlocked. What changes is the Key
// Encryption Key (KEK) that the DEK is *wrapped* under: the non-extractable
// device key (interim) or a PIN-derived key (steady state). Setting or changing
// a PIN therefore just re-wraps the DEK — no PHI is ever re-encrypted.
//
// Wrapping is plain AES-GCM over the DEK's raw bytes (rather than SubtleCrypto's
// wrapKey, which has thinner runtime support): GCM's auth tag means unwrapping
// with the wrong KEK throws instead of yielding a garbage key.
// ---------------------------------------------------------------------------

/** Generate a fresh, extractable AES-256-GCM data key. */
export async function generateDataKey(): Promise<CryptoKey> {
  // extractable: true so it can be exported for wrapping. The raw bytes only
  // ever leave the subsystem to be immediately re-encrypted under a KEK.
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** Encrypt (wrap) a data key under a key-encryption key. */
export async function wrapDataKey(
  dek: CryptoKey,
  kek: CryptoKey,
): Promise<{ wrapped: Uint8Array; iv: Uint8Array }> {
  const raw = new Uint8Array(await subtle().exportKey("raw", dek));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv }, kek, raw as BufferSource),
  );
  return { wrapped, iv };
}

/**
 * Decrypt (unwrap) a data key with a key-encryption key. Rejects if the KEK is
 * wrong (GCM auth-tag failure) — which is exactly how a wrong PIN is detected.
 */
export async function unwrapDataKey(
  wrapped: Uint8Array,
  iv: Uint8Array,
  kek: CryptoKey,
): Promise<CryptoKey> {
  const raw = await subtle().decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    kek,
    wrapped as BufferSource,
  );
  // extractable: true so the DEK can be re-wrapped later (e.g. on PIN change).
  return subtle().importKey("raw", raw, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

// ---------------------------------------------------------------------------
// Envelope encrypt / decrypt
// ---------------------------------------------------------------------------

/** True if a stored value is one of our AES-GCM envelopes. */
export function isEnvelope(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Encrypt a string into a self-describing envelope: `enc:v1:<ivB64>:<ciphertextB64>`.
 * A fresh random IV is generated per call.
 */
export async function encryptString(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  return `${ENVELOPE_PREFIX}${toBase64(iv)}:${toBase64(ciphertext)}`;
}

/**
 * Decrypt an envelope produced by {@link encryptString}. Values that are not
 * envelopes (e.g. rows written before encryption was introduced) are returned
 * unchanged so the app degrades gracefully rather than bricking.
 */
export async function decryptString(envelope: string): Promise<string> {
  if (!isEnvelope(envelope)) return envelope;
  const key = await getEncryptionKey();
  const [ivB64, ciphertextB64] = envelope.slice(ENVELOPE_PREFIX.length).split(":");
  if (!ivB64 || !ciphertextB64) throw new Error("Malformed encryption envelope");
  const plaintext = await subtle().decrypt(
    { name: "AES-GCM", iv: fromBase64(ivB64) as BufferSource },
    key,
    fromBase64(ciphertextB64) as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypt an arbitrary JSON-serialisable field value. The value is JSON-encoded
 * first so numbers, booleans, and string unions round-trip back to their exact
 * type on read.
 */
export async function encryptField(value: unknown): Promise<string> {
  return encryptString(JSON.stringify(value));
}

/**
 * Inverse of {@link encryptField}. Non-envelope values (legacy plaintext) are
 * passed through untouched.
 */
export async function decryptField(stored: unknown): Promise<unknown> {
  if (!isEnvelope(stored)) return stored;
  return JSON.parse(await decryptString(stored));
}
