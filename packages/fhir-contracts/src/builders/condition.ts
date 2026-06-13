import type { Condition } from "fhir/r4";

export interface ChiefComplaintContext {
  patientServerUUID: string;
  onsetTime?: string;
}

export function buildChiefComplaintCondition(
  complaint: string,
  ctx: ChiefComplaintContext
): Condition {
  const onsetDateTime = ctx.onsetTime ?? new Date().toISOString();

  return {
    resourceType: "Condition",
    clinicalStatus: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/condition-clinical",
          code: "active",
        },
      ],
    },
    verificationStatus: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
          code: "provisional",
        },
      ],
    },
    // fhir2 maps "encounter-diagnosis" to OpenMRS Diagnosis, which requires
    // a rank field that fhir2 cannot derive from the FHIR payload → 422.
    // "problem-list-item" maps to OpenMRS Condition which accepts free-text.
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
    code: { text: complaint },
    subject: {
      reference: `Patient/${ctx.patientServerUUID}`,
      type: "Patient",
    },
    onsetDateTime,
  };
}
