import type { Encounter } from "fhir/r4";

// fhir2 maps OpenMRS Visit → FHIR Encounter.
// The `type` field must use the fhir.openmrs.org visit-type code system,
// NOT the encounter-type system.
const VISIT_TYPE_SYSTEM = "http://fhir.openmrs.org/code-system/visit-type";

// "Facility Visit" — most appropriate for prehospital EMS arrivals
const FACILITY_VISIT_UUID = "7b0f5697-27e3-40c4-8bae-f4049abfb4ed";

export interface PrehospitalEncounterOptions {
  /** Server-assigned patient UUID (resolved from identity map before POST). */
  patientServerUUID: string;
  /** ISO 8601 start time; defaults to now. */
  startTime?: string;
  /** Location UUID; defaults to Outpatient Clinic. */
  locationUUID?: string;
}

export function buildPrehospitalEncounter(
  options: PrehospitalEncounterOptions
): Encounter {
  const startTime = options.startTime ?? new Date().toISOString();
  const locationUUID =
    options.locationUUID ?? "44c3efb0-2583-4c80-a79e-1f756a03c0a1";

  return {
    resourceType: "Encounter",
    status: "in-progress",
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "EMER",
      display: "emergency",
    },
    type: [
      {
        coding: [
          {
            system: VISIT_TYPE_SYSTEM,
            code: FACILITY_VISIT_UUID,
            display: "Facility Visit",
          },
        ],
      },
    ],
    subject: {
      reference: `Patient/${options.patientServerUUID}`,
      type: "Patient",
    },
    period: { start: startTime },
    location: [
      {
        location: {
          reference: `Location/${locationUUID}`,
          type: "Location",
        },
      },
    ],
  };
}
