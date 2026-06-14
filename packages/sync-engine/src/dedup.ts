/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */

export interface ActiveCallSummary {
  encounterId: string;
  patientServerUUID: string;
  mrn: string;
  gender: string;
  startTime: string;
}

interface BundleResource {
  resourceType: string;
  id?: string;
  subject?: { reference?: string };
  period?: { start?: string };
  identifier?: Array<{ use?: string; value?: string }>;
  gender?: string;
}

/**
 * Fetches currently in-progress encounters from the FHIR server.
 * Returns an empty array if offline, the request fails, or times out (4 s).
 * Safe to call before any capture — never throws.
 */
export async function checkActiveCalls(
  fhirBase: string,
  authHeader: string
): Promise<ActiveCallSummary[]> {
  if (!navigator.onLine) return [];
  try {
    const res = await fetch(
      `${fhirBase}/Encounter?status=in-progress&_include=Encounter:patient&_sort=-date&_count=20`,
      {
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(4_000),
      }
    );
    if (!res.ok) return [];
    const bundle = await res.json() as { entry?: Array<{ resource?: BundleResource }> };

    const encounters: Array<{ id: string; patientId: string; startTime: string }> = [];
    const patients = new Map<string, { mrn: string; gender: string }>();

    for (const entry of bundle.entry ?? []) {
      const r = entry.resource;
      if (!r) continue;
      if (r.resourceType === "Encounter" && r.id) {
        const parts = r.subject?.reference?.split("/");
        const patientId = parts?.[parts.length - 1];
        if (patientId) {
          encounters.push({ id: r.id, patientId, startTime: r.period?.start ?? new Date().toISOString() });
        }
      }
      if (r.resourceType === "Patient" && r.id) {
        const mrn = r.identifier?.find((i) => i.use === "official")?.value ?? r.id;
        patients.set(r.id, { mrn, gender: r.gender ?? "unknown" });
      }
    }

    return encounters.flatMap(({ id, patientId, startTime }) => {
      const p = patients.get(patientId);
      if (!p) return [];
      return [{ encounterId: id, patientServerUUID: patientId, mrn: p.mrn, gender: p.gender, startTime }];
    });
  } catch {
    return [];
  }
}
