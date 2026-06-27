/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { VitalsInput } from "@prehospital-ems/fhir-contracts";
import { db } from "../db.js";
import { logCapture, getRecentCaptures, amendInitialVitals, vitalsSeries, addVitalsSet } from "../captureLog.js";

const VITALS: VitalsInput = { hr: 80, rr: 16, bpSystolic: 120, bpDiastolic: 80, temp: 0, spo2: 98, gcs: 15 };

beforeEach(async () => {
  await db.open();
  await db.captureLog.clear();
});

describe("amendInitialVitals", () => {
  it("rewrites the initial vitals set in place, re-encrypted at rest", async () => {
    await logCapture({
      mrn: "PROV-amd", capturedAt: 1_000, sex: "male", approximateAge: 40,
      complaint: "chest pain", vitalsJson: JSON.stringify(VITALS), submissionStatus: "complete",
      encounterId: "ENC-amd",
    });

    await amendInitialVitals("PROV-amd", JSON.stringify({ ...VITALS, hr: 88 }));

    const [record] = await getRecentCaptures(1);
    expect((JSON.parse(record!.vitalsJson) as VitalsInput).hr).toBe(88);
  });

  it("does not disturb repeat vitals sets", async () => {
    await logCapture({
      mrn: "PROV-rep", capturedAt: 1_000, sex: "female", approximateAge: 30,
      complaint: "SOB", vitalsJson: JSON.stringify(VITALS), submissionStatus: "complete",
      encounterId: "ENC-rep",
    });
    await addVitalsSet("PROV-rep", JSON.stringify({ ...VITALS, hr: 110 }), 2_000);

    await amendInitialVitals("PROV-rep", JSON.stringify({ ...VITALS, hr: 84 }));

    const [record] = await getRecentCaptures(1);
    const series = vitalsSeries(record!);
    expect(series).toHaveLength(2);
    // Initial set corrected, repeat set untouched.
    expect((JSON.parse(series[0]!.vitalsJson) as VitalsInput).hr).toBe(84);
    expect((JSON.parse(series[1]!.vitalsJson) as VitalsInput).hr).toBe(110);
  });

  it("throws when the capture no longer exists", async () => {
    await expect(amendInitialVitals("PROV-missing", JSON.stringify(VITALS))).rejects.toThrow();
  });
});
