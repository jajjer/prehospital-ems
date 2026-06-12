import type { Observation } from "fhir/r4";

const CIEL = "https://cielterminology.org";
const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";

// OpenMRS concept UUIDs for WHO prehospital vitals.
// Format: CIEL numeric ID padded with A's to 36 chars total (e.g. "5087" + 32 A's).
// GCS concept was created manually in the local instance — UUID may differ per deployment.
const VITAL_CONCEPTS = {
  HR: {
    uuid: "5087AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ciel: "5087",
    loinc: "8867-4",
    display: "Pulse",
  },
  RR: {
    uuid: "5242AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ciel: "5242",
    loinc: "9279-1",
    display: "Respiratory rate",
  },
  BP_SYSTOLIC: {
    uuid: "5085AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ciel: "5085",
    loinc: "8480-6",
    display: "Systolic blood pressure",
  },
  SPO2: {
    uuid: "5092AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ciel: "5092",
    loinc: "2708-6",
    display: "Arterial blood oxygen saturation (pulse oximeter)",
  },
  GCS_TOTAL: {
    // Created manually in this instance; CIEL 162643 if the full CIEL dict is loaded.
    uuid: "8a7ff9be-79af-4485-9499-094597f01335",
    ciel: "162643",
    loinc: "9269-2",
    display: "Glasgow coma score total",
  },
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

  function obs(
    concept: (typeof VITAL_CONCEPTS)[keyof typeof VITAL_CONCEPTS],
    value: number,
    unit: string
  ): Observation {
    return {
      resourceType: "Observation",
      status: "final",
      code: {
        coding: [
          // Primary: OpenMRS concept UUID (no system = direct UUID lookup in fhir2)
          { code: concept.uuid, display: concept.display },
          // Secondary: CIEL terminology for concept mapping resolution
          { system: CIEL, code: concept.ciel },
          // Tertiary: LOINC for downstream interoperability
          { system: LOINC, code: concept.loinc },
        ],
      },
      subject,
      encounter,
      effectiveDateTime,
      valueQuantity: { value, unit, system: UCUM, code: unit },
    };
  }

  return [
    obs(VITAL_CONCEPTS.HR,          vitals.hr,          "/min"),
    obs(VITAL_CONCEPTS.RR,          vitals.rr,          "/min"),
    obs(VITAL_CONCEPTS.BP_SYSTOLIC, vitals.bpSystolic,  "mm[Hg]"),
    obs(VITAL_CONCEPTS.SPO2,        vitals.spo2,        "%"),
    obs(VITAL_CONCEPTS.GCS_TOTAL,   vitals.gcs,         "{score}"),
  ];
}
