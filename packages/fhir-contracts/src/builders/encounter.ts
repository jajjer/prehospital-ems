/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import type { Encounter, Extension } from "fhir/r4";
import { DEFAULT_LOCATION_UUID } from "./patient.js";

// fhir2 maps OpenMRS Visit → FHIR Encounter.
// The `type` field must use the fhir.openmrs.org visit-type code system,
// NOT the encounter-type system.
const VISIT_TYPE_SYSTEM = "http://fhir.openmrs.org/code-system/visit-type";

// "Facility Visit" — most appropriate for prehospital EMS arrivals
const FACILITY_VISIT_UUID = "7b0f5697-27e3-40c4-8bae-f4049abfb4ed";

// GPS extension stored on the Encounter for the dispatch console map
const GPS_EXTENSION_URL = "http://fhir.openmrs.org/ext/encounter/gps";

export interface PrehospitalEncounterOptions {
  /** Server-assigned patient UUID (resolved from identity map before POST). */
  patientServerUUID: string;
  /** ISO 8601 start time; defaults to now. */
  startTime?: string;
  /** Location UUID; defaults to Outpatient Clinic. */
  locationUUID?: string;
  /** GPS coordinates captured at submission time — stored as a FHIR extension
   *  so the dispatch console can pin incidents on the map. */
  gps?: { lat: number; lng: number };
}

export function buildPrehospitalEncounter(
  options: PrehospitalEncounterOptions
): Encounter {
  const startTime = options.startTime ?? new Date().toISOString();
  const locationUUID =
    options.locationUUID ?? DEFAULT_LOCATION_UUID;

  const gpsExtension: Extension[] = options.gps
    ? [{
        url: GPS_EXTENSION_URL,
        extension: [
          { url: "latitude",  valueDecimal: options.gps.lat },
          { url: "longitude", valueDecimal: options.gps.lng },
        ],
      }]
    : [];

  return {
    resourceType: "Encounter",
    ...(gpsExtension.length > 0 ? { extension: gpsExtension } : {}),
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
