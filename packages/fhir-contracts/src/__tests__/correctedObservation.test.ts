/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect } from "vitest";
import { buildVitalObservations, buildCorrectedVitalObservations, type VitalsInput } from "../builders/observation.js";

const VITALS: VitalsInput = {
  hr: 88, rr: 16, bpSystolic: 120, bpDiastolic: 80, temp: 37, spo2: 98,
  gcs: 15, gcsEye: 4, gcsVerbal: 5, gcsMotor: 6,
};
const CTX = { patientServerUUID: "pat-1", encounterServerUUID: "enc-1", effectiveTime: "2026-06-27T10:00:00.000Z" };

describe("buildCorrectedVitalObservations", () => {
  it("emits one corrected Observation per changed field, and only those", () => {
    const obs = buildCorrectedVitalObservations(VITALS, ["hr"], CTX);
    expect(obs).toHaveLength(1);
    expect(obs[0]!.status).toBe("corrected");
    expect(obs[0]!.valueQuantity?.value).toBe(88);
  });

  it("carries the same primary coding buildVitalObservations would emit for a field", () => {
    const corrected = buildCorrectedVitalObservations(VITALS, ["hr"], CTX)[0]!;
    const full = buildVitalObservations(VITALS, CTX).find(
      (o) => o.valueQuantity?.value === 88 && o.code?.coding?.[0]?.display === corrected.code?.coding?.[0]?.display,
    );
    expect(corrected.code?.coding?.[0]?.code).toBe(full?.code?.coding?.[0]?.code);
    expect(corrected.valueQuantity?.code).toBe(full?.valueQuantity?.code); // same UCUM unit
  });

  it("references the supplied patient/encounter and original effective time", () => {
    const [obs] = buildCorrectedVitalObservations(VITALS, ["spo2"], CTX);
    expect(obs!.subject?.reference).toBe("Patient/pat-1");
    expect(obs!.encounter?.reference).toBe("Encounter/enc-1");
    expect(obs!.effectiveDateTime).toBe(CTX.effectiveTime);
  });

  it("honors the GCS concept UUID override for the total", () => {
    const [obs] = buildCorrectedVitalObservations(VITALS, ["gcs"], { ...CTX, gcsConceptUUID: "local-gcs-uuid" });
    expect(obs!.code?.coding?.[0]?.code).toBe("local-gcs-uuid");
  });

  it("skips fields whose value is undefined", () => {
    const { gcsEye: _omit, ...noBreakdown } = VITALS;
    const obs = buildCorrectedVitalObservations(noBreakdown, ["gcsEye", "hr"], CTX);
    // gcsEye is undefined → skipped; hr remains.
    expect(obs).toHaveLength(1);
    expect(obs[0]!.valueQuantity?.value).toBe(88);
  });

  it("returns nothing when no fields changed", () => {
    expect(buildCorrectedVitalObservations(VITALS, [], CTX)).toHaveLength(0);
  });
});
