/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import type { AssessmentInput, PupilExam } from "../builders/assessment.js";

export interface AssessmentValidationError {
  field: keyof AssessmentInput;
  message: string;
}

/** Diameter range for a pupil measurement, in millimetres. */
const PUPIL_SIZE = { min: 1, max: 9 } as const;
/** Plausible capillary blood glucose bounds, in mg/dL. */
const GLUCOSE = { min: 10, max: 1000 } as const;
/** Free-text fields share the OpenMRS 255-char obs/condition limit. */
const TEXT_MAX = 255;

function checkPupil(
  exam: PupilExam | undefined,
  field: keyof AssessmentInput,
  errors: AssessmentValidationError[]
): void {
  if (exam?.size !== undefined && (exam.size < PUPIL_SIZE.min || exam.size > PUPIL_SIZE.max)) {
    errors.push({ field, message: `Pupil size must be ${PUPIL_SIZE.min}–${PUPIL_SIZE.max} mm` });
  }
}

/** Returns a list of validation errors for the assessment. Empty = valid. */
export function validateAssessment(input: AssessmentInput): AssessmentValidationError[] {
  const errors: AssessmentValidationError[] = [];

  if (input.painScore !== undefined && (input.painScore < 0 || input.painScore > 10)) {
    errors.push({ field: "painScore", message: "Pain score must be 0–10" });
  }
  if (
    input.bloodGlucose !== undefined &&
    (input.bloodGlucose < GLUCOSE.min || input.bloodGlucose > GLUCOSE.max)
  ) {
    errors.push({ field: "bloodGlucose", message: `Blood glucose must be ${GLUCOSE.min}–${GLUCOSE.max} mg/dL` });
  }

  checkPupil(input.pupilLeft, "pupilLeft", errors);
  checkPupil(input.pupilRight, "pupilRight", errors);

  const textFields: Array<[keyof AssessmentInput, string | undefined]> = [
    ["mechanismOfInjury", input.mechanismOfInjury],
    ["narrative", input.narrative],
    ["allergies", input.allergies],
    ["medications", input.medications],
    ["pastHistory", input.pastHistory],
  ];
  for (const [field, value] of textFields) {
    if (value !== undefined && value.length > TEXT_MAX) {
      errors.push({ field, message: `${field} must be ${TEXT_MAX} characters or fewer` });
    }
  }

  return errors;
}

/** Throws if the assessment is invalid. */
export function assertValidAssessment(input: AssessmentInput): void {
  const errors = validateAssessment(input);
  if (errors.length > 0) {
    throw new RangeError(`Invalid assessment: ${errors.map((e) => e.message).join("; ")}`);
  }
}
