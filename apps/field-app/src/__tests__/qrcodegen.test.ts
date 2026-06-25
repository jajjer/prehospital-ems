/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect } from "vitest";
import { QrCode, QrSegment, Ecc } from "../qrcodegen.js";

// The 7×7 finder pattern, mandated by the QR spec at all three positioning
// corners. Verifying it byte-for-byte exercises the function-pattern drawing.
const FINDER = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
];

function expectFinderAt(qr: QrCode, ox: number, oy: number): void {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      expect(qr.getModule(ox + x, oy + y)).toBe(FINDER[y]![x] === 1);
    }
  }
}

describe("QrCode", () => {
  it("produces a square symbol whose size follows version*4+17", () => {
    const qr = QrCode.encodeText("https://fhir.test/R4/Encounter/abc-123", Ecc.MEDIUM);
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.size).toBeGreaterThanOrEqual(21);
  });

  it("places correct finder patterns in all three corners", () => {
    const qr = QrCode.encodeText("PREHOSPITAL HANDOFF", Ecc.MEDIUM);
    expectFinderAt(qr, 0, 0); // top-left
    expectFinderAt(qr, qr.size - 7, 0); // top-right
    expectFinderAt(qr, 0, qr.size - 7); // bottom-left
  });

  it("draws the alternating timing patterns on row and column 6", () => {
    const qr = QrCode.encodeText("TIMING", Ecc.MEDIUM);
    for (let i = 8; i < qr.size - 8; i++) {
      expect(qr.getModule(i, 6)).toBe(i % 2 === 0);
      expect(qr.getModule(6, i)).toBe(i % 2 === 0);
    }
  });

  it("treats coordinates outside the symbol as light (quiet zone)", () => {
    const qr = QrCode.encodeText("X", Ecc.MEDIUM);
    expect(qr.getModule(-1, 0)).toBe(false);
    expect(qr.getModule(0, -1)).toBe(false);
    expect(qr.getModule(qr.size, 0)).toBe(false);
    expect(qr.getModule(0, qr.size)).toBe(false);
  });

  it("is deterministic — same input yields an identical matrix", () => {
    const a = QrCode.encodeText("https://fhir.test/R4/Encounter/same", Ecc.MEDIUM);
    const b = QrCode.encodeText("https://fhir.test/R4/Encounter/same", Ecc.MEDIUM);
    expect(a.size).toBe(b.size);
    for (let y = 0; y < a.size; y++)
      for (let x = 0; x < a.size; x++)
        expect(a.getModule(x, y)).toBe(b.getModule(x, y));
  });

  it("grows to a larger version as the payload grows", () => {
    const short = QrCode.encodeText("A", Ecc.MEDIUM);
    const long = QrCode.encodeText("A".repeat(400), Ecc.MEDIUM);
    expect(long.version).toBeGreaterThan(short.version);
  });

  it("encodes a realistic encounter URL without throwing and stays scannable-size", () => {
    const url = "https://openmrs.example.org/openmrs/ws/fhir2/R4/Encounter/9f1c2e7a-1234-4abc-9def-0123456789ab";
    const qr = QrCode.encodeText(url, Ecc.MEDIUM);
    // A ~90-char byte payload at ECC-M fits comfortably under version 10.
    expect(qr.version).toBeLessThanOrEqual(10);
    expectFinderAt(qr, 0, 0);
  });

  it("selects the most compact segment mode for the payload", () => {
    expect(QrSegment.isNumeric("0123456789")).toBe(true);
    expect(QrSegment.isAlphanumeric("HELLO WORLD")).toBe(true);
    expect(QrSegment.isAlphanumeric("https://x.test")).toBe(false); // lowercase → byte mode
  });
});
