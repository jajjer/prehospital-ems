import type { Patient, Identifier, HumanName } from "fhir/r4";

// Smoke test confirmed: fhir2 requires identifier location as an OpenMRS extension,
// not FHIR assigner. Old Identification Number (no Luhn validator) is the safe
// provisional type. "OpenMRS ID" type uses Luhn Mod-30 and cannot accept arbitrary strings.
const OPENMRS_IDENTIFIER_LOCATION_EXT =
  "http://fhir.openmrs.org/ext/patient/identifier#location";

// Old Identification Number — no validator, not required
const OLD_IDENTIFICATION_NUMBER_UUID = "8d79403a-c2cc-11de-8d13-0010c6dffd0f";

// Default location UUID (Outpatient Clinic in the reference app)
export const DEFAULT_LOCATION_UUID = "44c3efb0-2583-4c80-a79e-1f756a03c0a1";

export interface ProvisionalPatientOptions {
  /** UUID for the location to record on the identifier. Defaults to DEFAULT_LOCATION_UUID. */
  locationUUID?: string;
}

/** Returns a PROV-{uuid8} provisional MRN string. */
export function buildProvisionalMrn(): string {
  return `PROV-${crypto.randomUUID().slice(0, 8)}`;
}

/** Builds a minimal provisional FHIR R4 Patient for offline capture. */
export function buildProvisionalPatient(
  mrn: string,
  options: ProvisionalPatientOptions = {}
): Patient {
  const locationUUID = options.locationUUID ?? DEFAULT_LOCATION_UUID;

  const identifier: Identifier = {
    extension: [
      {
        url: OPENMRS_IDENTIFIER_LOCATION_EXT,
        valueReference: {
          reference: `Location/${locationUUID}`,
          type: "Location",
        },
      },
    ],
    use: "official",
    type: {
      coding: [{ code: OLD_IDENTIFICATION_NUMBER_UUID }],
      text: "Old Identification Number",
    },
    value: mrn,
  };

  const name: HumanName = {
    use: "temp",
    given: ["Unknown"],
    family: "Patient",
  };

  return {
    resourceType: "Patient",
    identifier: [identifier],
    name: [name],
    gender: "unknown",
  };
}
