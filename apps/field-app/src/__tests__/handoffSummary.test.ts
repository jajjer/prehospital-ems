/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect } from "vitest";
import { parseInterventions, buildShareText, latestVitals } from "../HandoffSummary.js";
import type { EnrichedEntry } from "../RecordsScreen.js";

const VITALS_A = { hr: 88, rr: 16, bpSystolic: 120, bpDiastolic: 80, temp: 0, spo2: 98, gcs: 15 };
const VITALS_B = { hr: 110, rr: 22, bpSystolic: 90, bpDiastolic: 60, temp: 0, spo2: 92, gcs: 13 };

function record(overrides: Partial<EnrichedEntry> = {}): EnrichedEntry {
  return {
    mrn: "PROV-test0001",
    capturedAt: Date.UTC(2026, 5, 24, 12, 0, 0),
    sex: "male",
    approximateAge: 54,
    complaint: "Chest pain",
    vitalsJson: JSON.stringify(VITALS_A),
    status: "synced",
    vitals: VITALS_A,
    series: [{ capturedAt: Date.UTC(2026, 5, 24, 12, 0, 0), vitalsJson: JSON.stringify(VITALS_A) }],
    conflicts: [],
    ...overrides,
  } as EnrichedEntry;
}

describe("parseInterventions", () => {
  it("labels a medication with its dose, unit and route", () => {
    const json = JSON.stringify([{ key: "aspirin", dose: 300, doseUnit: "mg", route: "PO" }]);
    const [iv] = parseInterventions(json);
    expect(iv?.label).toBe("Aspirin");
    expect(iv?.detail).toBe("300mg PO");
  });

  it("falls back to the catalog defaults for dose unit and route", () => {
    const json = JSON.stringify([{ key: "adrenaline", dose: 0.5 }]);
    const [iv] = parseInterventions(json);
    expect(iv?.detail).toBe("0.5mg IM");
  });

  it("renders a procedure with no dose detail and keeps the note", () => {
    const json = JSON.stringify([{ key: "oxygen", note: "15L NRB" }]);
    const [iv] = parseInterventions(json);
    expect(iv?.label).toBe("Oxygen");
    expect(iv?.detail).toBe("");
    expect(iv?.note).toBe("15L NRB");
  });

  it("formats an ISO administration time into a clock time", () => {
    const json = JSON.stringify([{ key: "oxygen", time: "2026-06-24T08:30:00.000Z" }]);
    const [iv] = parseInterventions(json);
    expect(iv?.time).toMatch(/\d{1,2}:\d{2}/);
  });

  it("uses the raw key for an unknown intervention", () => {
    const json = JSON.stringify([{ key: "mystery-drug" }]);
    expect(parseInterventions(json)[0]?.label).toBe("mystery-drug");
  });

  it("is resilient to missing and malformed input", () => {
    expect(parseInterventions(undefined)).toEqual([]);
    expect(parseInterventions("not json")).toEqual([]);
    expect(parseInterventions('{"not":"an array"}')).toEqual([]);
  });
});

describe("latestVitals", () => {
  it("returns the most recent set from a multi-set series", () => {
    const r = record({
      series: [
        { capturedAt: 1, vitalsJson: JSON.stringify(VITALS_A) },
        { capturedAt: 2, vitalsJson: JSON.stringify(VITALS_B) },
      ],
    });
    expect(latestVitals(r)).toEqual(VITALS_B);
  });

  it("falls back to the initial vitalsJson when the series is empty", () => {
    expect(latestVitals(record({ series: [] }))).toEqual(VITALS_A);
  });
});

describe("buildShareText", () => {
  it("summarises complaint, demographics, latest vitals and the record link", () => {
    const r = record({
      series: [
        { capturedAt: 1, vitalsJson: JSON.stringify(VITALS_A) },
        { capturedAt: 2, vitalsJson: JSON.stringify(VITALS_B) },
      ],
      interventionsJson: JSON.stringify([{ key: "aspirin", dose: 300, doseUnit: "mg", route: "PO" }]),
    });
    const text = buildShareText(r, "https://fhir.test/R4/Encounter/abc");
    expect(text).toContain("Chest pain");
    expect(text).toContain("Male, ~54y");
    expect(text).toContain("HR 110"); // latest set, not the initial one
    expect(text).toContain("Aspirin (300mg PO)");
    expect(text).toContain("https://fhir.test/R4/Encounter/abc");
  });

  it("omits the record line when no encounter URL is available", () => {
    expect(buildShareText(record(), null)).not.toContain("Record:");
  });
});
