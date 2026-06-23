/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect } from "vitest";
import {
  encryptString,
  decryptString,
  encryptField,
  decryptField,
  isEnvelope,
  deriveKeyFromPassphrase,
  setEncryptionKey,
} from "../crypto.js";

// A key is already installed by the test setup (setup.ts).

describe("envelope encryption", () => {
  it("round-trips a string through encrypt → decrypt", async () => {
    const plaintext = JSON.stringify({ name: "Jane Doe", complaint: "chest pain" });
    const envelope = await encryptString(plaintext);

    expect(isEnvelope(envelope)).toBe(true);
    expect(envelope).not.toContain("Jane Doe");
    expect(await decryptString(envelope)).toBe(plaintext);
  });

  it("uses a fresh IV so the same plaintext encrypts to different ciphertext", async () => {
    const a = await encryptString("vitals");
    const b = await encryptString("vitals");
    expect(a).not.toBe(b);
    expect(await decryptString(a)).toBe("vitals");
    expect(await decryptString(b)).toBe("vitals");
  });

  it("passes through non-envelope values unchanged (legacy/plaintext rows)", async () => {
    expect(await decryptString("{}")).toBe("{}");
    expect(await decryptField(42)).toBe(42);
    expect(await decryptField(undefined)).toBe(undefined);
  });

  it("preserves exact field types via encryptField/decryptField", async () => {
    for (const value of ["male", 34, true, { a: 1 }, "{\"hr\":80}"]) {
      const restored = await decryptField(await encryptField(value));
      expect(restored).toEqual(value);
    }
  });

  it("fails to decrypt tampered ciphertext (AES-GCM auth tag)", async () => {
    const envelope = await encryptString("secret");
    // Flip the last base64 char of the ciphertext segment.
    const tampered = envelope.slice(0, -1) + (envelope.endsWith("A") ? "B" : "A");
    await expect(decryptString(tampered)).rejects.toBeDefined();
  });
});

describe("deriveKeyFromPassphrase", () => {
  it("derives a usable AES-GCM key that decrypts what it encrypted", async () => {
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const key = await deriveKeyFromPassphrase("pin-1234", salt);
    setEncryptionKey(key);

    const envelope = await encryptString("patient data");
    expect(await decryptString(envelope)).toBe("patient data");
  });
});
