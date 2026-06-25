/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import type { Observation, Condition } from "fhir/r4";

const CIEL = "https://cielterminology.org";
const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";

/**
 * Concepts for the expanded prehospital assessment. As with the vitals and
 * intervention catalogs, the primary coding is the OpenMRS concept UUID derived
 * from the CIEL id (A-padded to 36 chars). LOINC is added as a standards-based
 * tertiary coding where a stable code is known.
 *
 * NOTE: the CIEL ids here are reference-instance values. A deployment must
 * validate them against its loaded CIEL dictionary before relying on the coded
 * mapping — see the "OpenMRS community validation" backlog item. Free-text
 * fields are emitted as `valueString`, so the reading is preserved even if a
 * coding fails to resolve server-side.
 */
const ASSESSMENT_CONCEPTS = {
  AVPU:        { ciel: "162643", loinc: "67775-7", display: "AVPU responsiveness" },
  PAIN:        { ciel: "1126",   loinc: "72514-3", display: "Pain score (0–10)" },
  GLUCOSE:     { ciel: "887",    loinc: "2339-0",  display: "Blood glucose" },
  PUPIL_LEFT:  { ciel: "162665", loinc: "79815-7", display: "Left pupil" },
  PUPIL_RIGHT: { ciel: "162666", loinc: "79816-5", display: "Right pupil" },
  MOI:         { ciel: "162872",                   display: "Mechanism of injury" },
  NARRATIVE:   { ciel: "162169",                   display: "Prehospital narrative" },
  ALLERGIES:   { ciel: "160643",                   display: "Known allergies" },
  MEDICATIONS: { ciel: "1779",                     display: "Current medications" },
} as const;

type Concept = { ciel: string; loinc?: string; display: string };

/** AVPU level of responsiveness, field-common single-letter codes. */
export type AvpuLevel = "A" | "V" | "P" | "U";

const AVPU_LABELS: Record<AvpuLevel, string> = {
  A: "Alert",
  V: "Responds to voice",
  P: "Responds to pain",
  U: "Unresponsive",
};

/** Pupil reaction to light. */
export type PupilReactivity = "brisk" | "sluggish" | "fixed";

/** One pupil's exam: size in mm and/or reactivity. Either may be omitted. */
export interface PupilExam {
  /** Diameter in millimetres (1–9). */
  size?: number;
  reactivity?: PupilReactivity;
}

/**
 * The expanded assessment captured alongside vitals: neuro/perfusion findings
 * plus the free-text clinical context (history, allergies, narrative). Every
 * field is optional — a medic fills in what's relevant.
 */
export interface AssessmentInput {
  avpu?: AvpuLevel;
  /** Pain score 0–10. */
  painScore?: number;
  /** Capillary/blood glucose in mg/dL. */
  bloodGlucose?: number;
  pupilLeft?: PupilExam;
  pupilRight?: PupilExam;
  /** Mechanism of injury (free text). */
  mechanismOfInjury?: string;
  /** Free-text prehospital narrative. */
  narrative?: string;
  /** Known allergies (free text). */
  allergies?: string;
  /** Current medications (free text). */
  medications?: string;
  /** Brief past medical history (free text). Mapped to a Condition. */
  pastHistory?: string;
}

export interface AssessmentContext {
  patientServerUUID: string;
  encounterServerUUID: string;
  effectiveTime?: string;
}

/** Pad a CIEL numeric id to the 36-char A-suffixed OpenMRS concept UUID form. */
function cielToUuid(ciel: string): string {
  return ciel + "A".repeat(36 - ciel.length);
}

function code(concept: Concept) {
  return {
    coding: [
      // Primary: OpenMRS concept UUID (no system = direct UUID lookup in fhir2).
      { code: cielToUuid(concept.ciel), display: concept.display },
      // Secondary: CIEL terminology for concept-mapping resolution.
      { system: CIEL, code: concept.ciel },
      // Tertiary: LOINC for downstream interoperability, where known.
      ...(concept.loinc ? [{ system: LOINC, code: concept.loinc }] : []),
    ],
    text: concept.display,
  };
}

/** Cap free text at the OpenMRS 255-char obs/condition text limit. */
function clip(text: string): string {
  return text.slice(0, 255);
}

/**
 * Build the FHIR resources for one captured assessment. Returns only the
 * resources for fields the medic actually filled in (empty input → []).
 * Numeric findings map to valueQuantity Observations, coded/free-text findings
 * to valueString Observations, and past history to a problem-list Condition.
 */
export function buildAssessmentResources(
  input: AssessmentInput,
  ctx: AssessmentContext
): Array<Observation | Condition> {
  const effectiveDateTime = ctx.effectiveTime ?? new Date().toISOString();
  const subject = { reference: `Patient/${ctx.patientServerUUID}`, type: "Patient" as const };
  const encounter = { reference: `Encounter/${ctx.encounterServerUUID}`, type: "Encounter" as const };

  function quantityObs(concept: Concept, value: number, unit: string): Observation {
    return {
      resourceType: "Observation",
      status: "final",
      code: code(concept),
      subject,
      encounter,
      effectiveDateTime,
      valueQuantity: { value, unit, system: UCUM, code: unit },
    };
  }

  function stringObs(concept: Concept, value: string): Observation {
    return {
      resourceType: "Observation",
      status: "final",
      code: code(concept),
      subject,
      encounter,
      effectiveDateTime,
      valueString: clip(value),
    };
  }

  const out: Array<Observation | Condition> = [];

  if (input.avpu) {
    out.push(stringObs(ASSESSMENT_CONCEPTS.AVPU, `${input.avpu} — ${AVPU_LABELS[input.avpu]}`));
  }
  if (input.painScore !== undefined) {
    out.push(quantityObs(ASSESSMENT_CONCEPTS.PAIN, input.painScore, "{score}"));
  }
  if (input.bloodGlucose !== undefined) {
    out.push(quantityObs(ASSESSMENT_CONCEPTS.GLUCOSE, input.bloodGlucose, "mg/dL"));
  }

  const pupil = (concept: Concept, exam: PupilExam | undefined) => {
    if (!exam || (exam.size === undefined && !exam.reactivity)) return;
    const parts: string[] = [];
    if (exam.size !== undefined) parts.push(`${exam.size} mm`);
    if (exam.reactivity) parts.push(exam.reactivity);
    out.push(stringObs(concept, parts.join(", ")));
  };
  pupil(ASSESSMENT_CONCEPTS.PUPIL_LEFT, input.pupilLeft);
  pupil(ASSESSMENT_CONCEPTS.PUPIL_RIGHT, input.pupilRight);

  const text = (concept: Concept, value: string | undefined) => {
    if (value && value.trim()) out.push(stringObs(concept, value.trim()));
  };
  text(ASSESSMENT_CONCEPTS.MOI, input.mechanismOfInjury);
  text(ASSESSMENT_CONCEPTS.ALLERGIES, input.allergies);
  text(ASSESSMENT_CONCEPTS.MEDICATIONS, input.medications);
  text(ASSESSMENT_CONCEPTS.NARRATIVE, input.narrative);

  if (input.pastHistory && input.pastHistory.trim()) {
    out.push(pastHistoryCondition(input.pastHistory.trim(), subject, effectiveDateTime));
  }

  return out;
}

/**
 * Past medical history as a problem-list Condition. Uses the same free-text-safe
 * mapping as the chief complaint (problem-list-item accepts `code.text`; an
 * encounter-diagnosis would require a rank fhir2 can't derive — see condition.ts).
 */
function pastHistoryCondition(
  history: string,
  subject: { reference: string; type: "Patient" },
  onsetDateTime: string
): Condition {
  return {
    resourceType: "Condition",
    clinicalStatus: {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }],
    },
    verificationStatus: {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "provisional" }],
    },
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/condition-category",
            code: "problem-list-item",
            display: "Problem List Item",
          },
        ],
      },
    ],
    code: { text: `PMH: ${clip(history).slice(0, 250)}` },
    subject,
    onsetDateTime,
  };
}
