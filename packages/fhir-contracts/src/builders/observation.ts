/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
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
  BP_DIASTOLIC: {
    uuid: "5086AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ciel: "5086",
    loinc: "8462-4",
    display: "Diastolic blood pressure",
  },
  TEMP: {
    uuid: "5088AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ciel: "5088",
    loinc: "8310-5",
    display: "Temperature (C)",
  },
  SPO2: {
    uuid: "5092AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ciel: "5092",
    loinc: "59408-5",
    display: "Arterial blood oxygen saturation (pulse oximeter)",
  },
  GCS_TOTAL: {
    // Created manually in this instance; CIEL 162643 if the full CIEL dict is loaded.
    uuid: "8a7ff9be-79af-4485-9499-094597f01335",
    ciel: "162643",
    loinc: "9269-2",
    display: "Glasgow coma score total",
  },
  // GCS sub-scores. CIEL ids are reference-instance values (A-padded to the OpenMRS
  // concept UUID like the vitals above); validate against the loaded CIEL dictionary
  // before a deployment relies on the coded mapping. LOINC codes are authoritative.
  GCS_EYE: {
    uuid: "162646AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ciel: "162646",
    loinc: "9267-6",
    display: "Glasgow coma score eye opening",
  },
  GCS_VERBAL: {
    uuid: "162647AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ciel: "162647",
    loinc: "9270-0",
    display: "Glasgow coma score verbal",
  },
  GCS_MOTOR: {
    uuid: "162648AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ciel: "162648",
    loinc: "9268-4",
    display: "Glasgow coma score motor",
  },
} as const;

/** Valid component ranges for the Glasgow Coma Scale sub-scores. */
export const GCS_RANGES = {
  eye: { min: 1, max: 4 },
  verbal: { min: 1, max: 5 },
  motor: { min: 1, max: 6 },
} as const;

/**
 * Total GCS from its E/V/M components, or `undefined` if any component is missing.
 * Used by the UI to derive the displayed total and by the builder to keep the
 * total observation consistent with the components.
 */
export function gcsTotalFromComponents(
  v: Pick<VitalsInput, "gcsEye" | "gcsVerbal" | "gcsMotor">
): number | undefined {
  if (v.gcsEye === undefined || v.gcsVerbal === undefined || v.gcsMotor === undefined) {
    return undefined;
  }
  return v.gcsEye + v.gcsVerbal + v.gcsMotor;
}

export interface VitalsInput {
  /** Heart rate in bpm (0–300) */
  hr: number;
  /** Respiratory rate in breaths/min (0–60) */
  rr: number;
  /** Systolic blood pressure in mmHg (0–300) */
  bpSystolic: number;
  /** Diastolic blood pressure in mmHg (0–200) */
  bpDiastolic: number;
  /** Temperature in °C (0 = not measured) */
  temp: number;
  /** SpO2 percentage (0–100) */
  spo2: number;
  /** GCS total (3–15). When E/V/M components are present this is derived from them
   *  (eye + verbal + motor); legacy records carry only this total. */
  gcs: number;
  /** GCS eye-opening sub-score (1–4). Optional — absent on pre-assessment records. */
  gcsEye?: number;
  /** GCS verbal sub-score (1–5). Optional — absent on pre-assessment records. */
  gcsVerbal?: number;
  /** GCS motor sub-score (1–6). Optional — absent on pre-assessment records. */
  gcsMotor?: number;
}

export interface ObservationContext {
  patientServerUUID: string;
  encounterServerUUID: string;
  effectiveTime?: string;
  /** Override the GCS concept UUID for deployments that have a different local concept.
   *  Defaults to the UUID created manually in the reference instance. */
  gcsConceptUUID?: string;
}

export function buildVitalObservations(
  vitals: VitalsInput,
  ctx: ObservationContext
): Observation[] {
  const effectiveDateTime = ctx.effectiveTime ?? new Date().toISOString();
  const gcsConcept = ctx.gcsConceptUUID
    ? { ...VITAL_CONCEPTS.GCS_TOTAL, uuid: ctx.gcsConceptUUID }
    : VITAL_CONCEPTS.GCS_TOTAL;
  const subject = { reference: `Patient/${ctx.patientServerUUID}`, type: "Patient" as const };
  const encounter = { reference: `Encounter/${ctx.encounterServerUUID}`, type: "Encounter" as const };

  function obs(
    concept: { readonly uuid: string; readonly ciel: string; readonly loinc: string; readonly display: string },
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

  // Keep the total consistent with the components when those are captured.
  const gcsTotal = gcsTotalFromComponents(vitals) ?? vitals.gcs;

  const observations = [
    obs(VITAL_CONCEPTS.HR,           vitals.hr,           "/min"),
    obs(VITAL_CONCEPTS.RR,           vitals.rr,           "/min"),
    obs(VITAL_CONCEPTS.BP_SYSTOLIC,  vitals.bpSystolic,   "mm[Hg]"),
    obs(VITAL_CONCEPTS.BP_DIASTOLIC, vitals.bpDiastolic,  "mm[Hg]"),
    obs(VITAL_CONCEPTS.SPO2,         vitals.spo2,         "%"),
    obs(gcsConcept,                  gcsTotal,            "{score}"),
  ];
  // GCS sub-scores — emitted only when all three are captured, so the clinician sees
  // the breakdown (e.g. E1V1M4 vs E4V1M1 at the same total) on the receiving chart.
  if (gcsTotalFromComponents(vitals) !== undefined) {
    observations.push(
      obs(VITAL_CONCEPTS.GCS_EYE,    vitals.gcsEye!,    "{score}"),
      obs(VITAL_CONCEPTS.GCS_VERBAL, vitals.gcsVerbal!, "{score}"),
      obs(VITAL_CONCEPTS.GCS_MOTOR,  vitals.gcsMotor!,  "{score}"),
    );
  }
  // Temperature is optional — skip the observation if not measured (value = 0).
  // Posting 0°C would display as a valid reading in the OpenMRS chart.
  if (vitals.temp > 0) {
    observations.splice(2, 0, obs(VITAL_CONCEPTS.TEMP, vitals.temp, "Cel"));
  }
  return observations;
}
