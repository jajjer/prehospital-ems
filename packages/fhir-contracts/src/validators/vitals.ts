/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { GCS_RANGES, gcsTotalFromComponents, type VitalsInput } from "../builders/observation.js";

export interface ValidationError {
  field: keyof VitalsInput;
  message: string;
}

/** Returns a list of validation errors. Empty = valid. */
export function validateVitals(input: VitalsInput): ValidationError[] {
  const errors: ValidationError[] = [];

  if (input.hr < 0 || input.hr > 300) {
    errors.push({ field: "hr", message: "HR must be 0–300 bpm" });
  }
  if (input.rr < 0 || input.rr > 60) {
    errors.push({ field: "rr", message: "RR must be 0–60 breaths/min" });
  }
  if (input.temp !== 0 && (input.temp < 24 || input.temp > 45)) {
    errors.push({ field: "temp", message: "Temperature must be 24–45 °C" });
  }
  if (input.bpSystolic < 0 || input.bpSystolic > 300) {
    errors.push({ field: "bpSystolic", message: "Systolic BP must be 0–300 mmHg" });
  }
  if (input.bpDiastolic < 0 || input.bpDiastolic > 200) {
    errors.push({ field: "bpDiastolic", message: "Diastolic BP must be 0–200 mmHg" });
  }
  if (input.spo2 < 0 || input.spo2 > 100) {
    errors.push({ field: "spo2", message: "SpO2 must be 0–100 %" });
  }
  if (input.gcs < 3 || input.gcs > 15) {
    errors.push({ field: "gcs", message: "GCS must be 3–15" });
  }

  // GCS components are optional, but if any one is entered, all three must be present
  // and in range, and the total must equal their sum.
  const components = [input.gcsEye, input.gcsVerbal, input.gcsMotor];
  const anyComponent = components.some((c) => c !== undefined);
  if (anyComponent) {
    if (input.gcsEye === undefined || input.gcsVerbal === undefined || input.gcsMotor === undefined) {
      errors.push({ field: "gcs", message: "GCS needs all three of eye, verbal and motor" });
    } else {
      if (input.gcsEye < GCS_RANGES.eye.min || input.gcsEye > GCS_RANGES.eye.max) {
        errors.push({ field: "gcsEye", message: `GCS eye must be ${GCS_RANGES.eye.min}–${GCS_RANGES.eye.max}` });
      }
      if (input.gcsVerbal < GCS_RANGES.verbal.min || input.gcsVerbal > GCS_RANGES.verbal.max) {
        errors.push({ field: "gcsVerbal", message: `GCS verbal must be ${GCS_RANGES.verbal.min}–${GCS_RANGES.verbal.max}` });
      }
      if (input.gcsMotor < GCS_RANGES.motor.min || input.gcsMotor > GCS_RANGES.motor.max) {
        errors.push({ field: "gcsMotor", message: `GCS motor must be ${GCS_RANGES.motor.min}–${GCS_RANGES.motor.max}` });
      }
      const total = gcsTotalFromComponents(input);
      if (total !== undefined && total !== input.gcs) {
        errors.push({ field: "gcs", message: "GCS total must equal eye + verbal + motor" });
      }
    }
  }

  return errors;
}

/** Throws if vitals are invalid. */
export function assertValidVitals(input: VitalsInput): void {
  const errors = validateVitals(input);
  if (errors.length > 0) {
    throw new RangeError(
      `Invalid vitals: ${errors.map((e) => e.message).join("; ")}`
    );
  }
}
