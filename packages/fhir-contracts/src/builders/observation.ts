import type { Observation } from "fhir/r4";

const LOINC = "http://loinc.org";

// CIEL/LOINC codes for WHO prehospital vitals (5 required for M1)
const VITAL_CODES = {
  HR: { code: "8867-4", display: "Heart rate" },
  RR: { code: "9279-1", display: "Respiratory rate" },
  // Systolic BP (diastolic added via component in full form; M1 uses systolic only)
  BP_SYSTOLIC: { code: "8480-6", display: "Systolic blood pressure" },
  SPO2: { code: "2708-6", display: "Oxygen saturation in Arterial blood" },
  GCS_TOTAL: { code: "9269-2", display: "Glasgow coma score total" },
} as const;

export interface VitalsInput {
  /** Heart rate in bpm (0–300) */
  hr: number;
  /** Respiratory rate in breaths/min (0–60) */
  rr: number;
  /** Systolic blood pressure in mmHg (0–300) */
  bpSystolic: number;
  /** SpO2 percentage (0–100) */
  spo2: number;
  /** GCS total (3–15) */
  gcs: number;
}

export interface ObservationContext {
  patientServerUUID: string;
  encounterServerUUID: string;
  effectiveTime?: string;
}

export function buildVitalObservations(
  vitals: VitalsInput,
  ctx: ObservationContext
): Observation[] {
  const effectiveDateTime = ctx.effectiveTime ?? new Date().toISOString();
  const subject = { reference: `Patient/${ctx.patientServerUUID}`, type: "Patient" as const };
  const encounter = { reference: `Encounter/${ctx.encounterServerUUID}`, type: "Encounter" as const };

  function base(code: (typeof VITAL_CODES)[keyof typeof VITAL_CODES], value: number, unit: string, system = "http://unitsofmeasure.org"): Observation {
    return {
      resourceType: "Observation",
      status: "final",
      code: { coding: [{ system: LOINC, code: code.code, display: code.display }] },
      subject,
      encounter,
      effectiveDateTime,
      valueQuantity: { value, unit, system, code: unit },
    };
  }

  return [
    base(VITAL_CODES.HR, vitals.hr, "/min"),
    base(VITAL_CODES.RR, vitals.rr, "/min"),
    base(VITAL_CODES.BP_SYSTOLIC, vitals.bpSystolic, "mm[Hg]"),
    base(VITAL_CODES.SPO2, vitals.spo2, "%"),
    {
      ...base(VITAL_CODES.GCS_TOTAL, vitals.gcs, "{score}", "http://unitsofmeasure.org"),
    },
  ];
}
