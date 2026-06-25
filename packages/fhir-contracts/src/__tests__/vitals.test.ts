/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect } from "vitest";
import { validateVitals, assertValidVitals } from "../validators/vitals.js";
import { buildVitalObservations, gcsTotalFromComponents } from "../builders/observation.js";

const VALID_VITALS = { hr: 80, rr: 16, bpSystolic: 120, bpDiastolic: 80, temp: 37.0, spo2: 98, gcs: 15 };

describe("validateVitals", () => {
  it("returns no errors for valid vitals", () => {
    expect(validateVitals(VALID_VITALS)).toHaveLength(0);
  });

  it("rejects HR < 0", () => {
    const errors = validateVitals({ ...VALID_VITALS, hr: -1 });
    expect(errors.some((e) => e.field === "hr")).toBe(true);
  });

  it("rejects HR > 300", () => {
    const errors = validateVitals({ ...VALID_VITALS, hr: 301 });
    expect(errors.some((e) => e.field === "hr")).toBe(true);
  });

  it("rejects SpO2 > 100", () => {
    const errors = validateVitals({ ...VALID_VITALS, spo2: 101 });
    expect(errors.some((e) => e.field === "spo2")).toBe(true);
  });

  it("rejects SpO2 < 0", () => {
    const errors = validateVitals({ ...VALID_VITALS, spo2: -1 });
    expect(errors.some((e) => e.field === "spo2")).toBe(true);
  });

  it("rejects GCS < 3", () => {
    const errors = validateVitals({ ...VALID_VITALS, gcs: 2 });
    expect(errors.some((e) => e.field === "gcs")).toBe(true);
  });

  it("rejects GCS > 15", () => {
    const errors = validateVitals({ ...VALID_VITALS, gcs: 16 });
    expect(errors.some((e) => e.field === "gcs")).toBe(true);
  });

  it("accepts boundary values GCS=3 and GCS=15", () => {
    expect(validateVitals({ ...VALID_VITALS, gcs: 3 })).toHaveLength(0);
    expect(validateVitals({ ...VALID_VITALS, gcs: 15 })).toHaveLength(0);
  });

  it("rejects diastolic BP > 200", () => {
    const errors = validateVitals({ ...VALID_VITALS, bpDiastolic: 201 });
    expect(errors.some((e) => e.field === "bpDiastolic")).toBe(true);
  });

  it("rejects temp outside 24–45 when non-zero", () => {
    expect(validateVitals({ ...VALID_VITALS, temp: 23 }).some((e) => e.field === "temp")).toBe(true);
    expect(validateVitals({ ...VALID_VITALS, temp: 46 }).some((e) => e.field === "temp")).toBe(true);
  });

  it("accepts temp = 0 (not measured)", () => {
    expect(validateVitals({ ...VALID_VITALS, temp: 0 })).toHaveLength(0);
  });

  it("can return multiple errors", () => {
    const errors = validateVitals({ hr: -1, rr: -1, bpSystolic: 0, bpDiastolic: 0, temp: 0, spo2: 101, gcs: 16 });
    expect(errors.length).toBeGreaterThan(1);
  });
});

describe("validateVitals — GCS components", () => {
  const withGcs = { ...VALID_VITALS, gcs: 15, gcsEye: 4, gcsVerbal: 5, gcsMotor: 6 };

  it("accepts a consistent E/V/M breakdown", () => {
    expect(validateVitals(withGcs)).toHaveLength(0);
  });

  it("rejects a total that does not match the components", () => {
    const errors = validateVitals({ ...withGcs, gcs: 14 });
    expect(errors.some((e) => e.field === "gcs")).toBe(true);
  });

  it("rejects a partial breakdown (eye only)", () => {
    const errors = validateVitals({ ...VALID_VITALS, gcsEye: 4 });
    expect(errors.some((e) => e.field === "gcs")).toBe(true);
  });

  it("rejects out-of-range component (eye > 4)", () => {
    const errors = validateVitals({ ...withGcs, gcsEye: 5, gcs: 16 });
    expect(errors.some((e) => e.field === "gcsEye")).toBe(true);
  });

  it("rejects motor < 1", () => {
    const errors = validateVitals({ ...withGcs, gcsMotor: 0, gcs: 9 });
    expect(errors.some((e) => e.field === "gcsMotor")).toBe(true);
  });
});

describe("gcsTotalFromComponents", () => {
  it("sums the three components", () => {
    expect(gcsTotalFromComponents({ gcsEye: 3, gcsVerbal: 4, gcsMotor: 5 })).toBe(12);
  });
  it("returns undefined when a component is missing", () => {
    expect(gcsTotalFromComponents({ gcsEye: 3, gcsVerbal: 4 })).toBeUndefined();
  });
});

describe("assertValidVitals", () => {
  it("does not throw for valid vitals", () => {
    expect(() => assertValidVitals(VALID_VITALS)).not.toThrow();
  });

  it("throws RangeError for invalid vitals", () => {
    expect(() => assertValidVitals({ ...VALID_VITALS, gcs: 0 })).toThrow(RangeError);
  });
});

describe("buildVitalObservations", () => {
  const ctx = {
    patientServerUUID: "patient-srv-uuid",
    encounterServerUUID: "encounter-srv-uuid",
  };

  it("returns 7 observations when temp is non-zero", () => {
    expect(buildVitalObservations(VALID_VITALS, ctx)).toHaveLength(7);
  });

  it("returns 6 observations when temp is 0 (not measured)", () => {
    expect(buildVitalObservations({ ...VALID_VITALS, temp: 0 }, ctx)).toHaveLength(6);
  });

  it("adds 3 GCS component observations when E/V/M are present", () => {
    const obs = buildVitalObservations({ ...VALID_VITALS, gcs: 15, gcsEye: 4, gcsVerbal: 5, gcsMotor: 6 }, ctx);
    // 7 base (temp present) + 3 components
    expect(obs).toHaveLength(10);
  });

  it("derives the GCS total observation from the components", () => {
    const obs = buildVitalObservations(
      { ...VALID_VITALS, gcs: 99, gcsEye: 3, gcsVerbal: 4, gcsMotor: 5 },
      ctx,
    );
    const total = obs.find((o) => o.code.coding?.[2]?.code === "9269-2");
    expect(total?.valueQuantity?.value).toBe(12);
  });

  it("emits no GCS components for a legacy total-only record", () => {
    const obs = buildVitalObservations(VALID_VITALS, ctx);
    const componentCodes = obs.flatMap((o) => o.code.coding ?? [])
      .filter((c) => ["9267-6", "9270-0", "9268-4"].includes(c.code ?? ""));
    expect(componentCodes).toHaveLength(0);
  });

  it("all observations reference the patient", () => {
    const obs = buildVitalObservations(VALID_VITALS, ctx);
    obs.forEach((o) => {
      expect(o.subject?.reference).toBe(`Patient/${ctx.patientServerUUID}`);
    });
  });

  it("all observations reference the encounter", () => {
    const obs = buildVitalObservations(VALID_VITALS, ctx);
    obs.forEach((o) => {
      expect(o.encounter?.reference).toBe(`Encounter/${ctx.encounterServerUUID}`);
    });
  });

  it("all observations have three-tier coding (OpenMRS UUID, CIEL, LOINC)", () => {
    const obs = buildVitalObservations(VALID_VITALS, ctx);
    obs.forEach((o) => {
      const codings = o.code.coding ?? [];
      expect(codings).toHaveLength(3);
      // Primary: OpenMRS concept UUID (no system)
      expect(codings[0]?.system).toBeUndefined();
      expect(codings[0]?.code).toBeTruthy();
      // Secondary: CIEL
      expect(codings[1]?.system).toBe("https://cielterminology.org");
      // Tertiary: LOINC
      expect(codings[2]?.system).toBe("http://loinc.org");
    });
  });
});
