import type { VitalsInput } from "../builders/observation.js";

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
