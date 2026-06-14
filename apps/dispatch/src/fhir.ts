/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */

// Minimal FHIR R4 types — avoids pulling in the full fhir/r4 package.

interface FhirExtension {
  url: string;
  extension?: FhirExtension[];
  valueDecimal?: number;
}

interface FhirPatient {
  resourceType: "Patient";
  id?: string;
  identifier?: Array<{ use?: string; value?: string }>;
  gender?: string;
  birthDate?: string;
}

interface FhirEncounter {
  resourceType: "Encounter";
  id?: string;
  status?: string;
  subject?: { reference?: string };
  period?: { start?: string };
  extension?: FhirExtension[];
}

interface FhirBundle {
  resourceType: "Bundle";
  entry?: Array<{ resource?: FhirPatient | FhirEncounter }>;
}

export interface ActiveCall {
  encounterId: string;
  patientServerUUID: string;
  mrn: string;
  gender: string;
  startTime: string;
  gps?: { lat: number; lng: number };
}

const GPS_EXT_URL = "http://fhir.openmrs.org/ext/encounter/gps";

function parseGPS(enc: FhirEncounter): { lat: number; lng: number } | undefined {
  const ext = enc.extension?.find((e) => e.url === GPS_EXT_URL);
  if (!ext?.extension) return undefined;
  const lat = ext.extension.find((e) => e.url === "latitude")?.valueDecimal;
  const lng = ext.extension.find((e) => e.url === "longitude")?.valueDecimal;
  if (lat === undefined || lng === undefined) return undefined;
  return { lat, lng };
}

export async function fetchActiveCalls(
  fhirBase: string,
  authHeader: string
): Promise<ActiveCall[]> {
  const res = await fetch(
    `${fhirBase}/Encounter?status=in-progress&_include=Encounter:patient&_sort=-date&_count=50`,
    { headers: { Authorization: authHeader } }
  );
  if (!res.ok) throw new Error(`FHIR ${res.status}`);
  const bundle = await res.json() as FhirBundle;

  const encounters: FhirEncounter[] = [];
  const patients = new Map<string, FhirPatient>();

  for (const entry of bundle.entry ?? []) {
    const r = entry.resource;
    if (!r) continue;
    if (r.resourceType === "Encounter") encounters.push(r);
    if (r.resourceType === "Patient" && r.id) patients.set(r.id, r);
  }

  return encounters.flatMap((enc) => {
    if (!enc.id) return [];
    const patientId = enc.subject?.reference?.split("/")[1];
    const patient = patientId ? patients.get(patientId) : undefined;
    const mrn =
      patient?.identifier?.find((i) => i.use === "official")?.value ??
      patientId ??
      "Unknown";
    const gps = parseGPS(enc);
    return [{
      encounterId: enc.id,
      patientServerUUID: patientId ?? "",
      mrn,
      gender: patient?.gender ?? "unknown",
      startTime: enc.period?.start ?? new Date().toISOString(),
      ...(gps ? { gps } : {}),
    }];
  });
}
