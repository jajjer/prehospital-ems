import { describe, it, expect } from "vitest";
import { validateVitals, assertValidVitals } from "../validators/vitals.js";
import { buildVitalObservations } from "../builders/observation.js";

const VALID_VITALS = { hr: 80, rr: 16, bpSystolic: 120, bpDiastolic: 80, spo2: 98, gcs: 15 };

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

  it("can return multiple errors", () => {
    const errors = validateVitals({ hr: -1, rr: -1, bpSystolic: 0, bpDiastolic: 0, spo2: 101, gcs: 16 });
    expect(errors.length).toBeGreaterThan(1);
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

  it("returns 6 observations", () => {
    const obs = buildVitalObservations(VALID_VITALS, ctx);
    expect(obs).toHaveLength(6);
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
