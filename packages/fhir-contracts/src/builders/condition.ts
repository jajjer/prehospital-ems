import type { Condition } from "fhir/r4";

export interface ChiefComplaintContext {
  patientServerUUID: string;
  encounterServerUUID: string;
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
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/condition-category",
            code: "encounter-diagnosis",
            display: "Encounter Diagnosis",
          },
        ],
      },
    ],
    code: { text: complaint },
    subject: {
      reference: `Patient/${ctx.patientServerUUID}`,
      type: "Patient",
    },
    encounter: {
      reference: `Encounter/${ctx.encounterServerUUID}`,
      type: "Encounter",
    },
    onsetDateTime,
  };
}
