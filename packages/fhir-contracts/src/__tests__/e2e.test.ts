/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect } from "vitest";
import {
  buildProvisionalPatient,
  buildPrehospitalEncounter,
  buildVitalObservations,
  buildChiefComplaintCondition,
} from "../index.js";

const BASE = process.env.OPENMRS_E2E_BASE_URL ?? "http://localhost:8069/openmrs";
const FHIR = `${BASE}/ws/fhir2/R4`;
const AUTH = `Basic ${Buffer.from(process.env.OPENMRS_E2E_CREDS ?? "admin:Admin123").toString("base64")}`;
const FHIR_HEADERS = { "Content-Type": "application/fhir+json", Authorization: AUTH };

type FhirResource = { id: string; resourceType: string };
type Bundle = { total?: number; entry?: Array<{ resource?: FhirResource }> };

async function fhirPost<T>(resourceType: string, body: unknown): Promise<{ status: number; resource: T }> {
  const res = await fetch(`${FHIR}/${resourceType}`, {
    method: "POST",
    headers: FHIR_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, resource: (await res.json()) as T };
}

// Probe before defining tests — skip the whole suite if the stack isn't running.
const serverUp = await fetch(`${BASE}/ws/rest/v1/session`, {
  headers: { Authorization: AUTH },
  signal: AbortSignal.timeout(3_000),
})
  .then((r) => r.ok)
  .catch(() => false);

describe.skipIf(!serverUp)("FHIR chain E2E (requires Docker stack on :8069)", () => {
  // Unique MRN per run so records are identifiable in OpenMRS (prefix E2E-).
  const mrn = `E2E-${Date.now()}`;
  const provisionalEncounterId = `ENC-${crypto.randomUUID().slice(0, 8)}`;

  const vitals = { hr: 90, rr: 18, bpSystolic: 130, bpDiastolic: 85, temp: 37.2, spo2: 97, gcs: 14 };

  // Shared across tests — populated as the chain progresses.
  let patientServerUUID = "";
  let encounterServerUUID = "";

  it("POSTs a provisional patient and receives a server UUID", async () => {
    const patient = buildProvisionalPatient(mrn, { sex: "male", approximateAge: 45 });
    const { status, resource } = await fhirPost<FhirResource>("Patient", patient);
    expect(status).toBe(201);
    expect(resource.id).toBeTruthy();
    patientServerUUID = resource.id;
  }, 10_000);

  it("POSTs a prehospital encounter referencing the patient", async () => {
    expect(patientServerUUID).toBeTruthy(); // guard: previous test must have passed
    const encounter = {
      ...buildPrehospitalEncounter({ patientServerUUID }),
      id: provisionalEncounterId,
    };
    const { status, resource } = await fhirPost<FhirResource>("Encounter", encounter);
    expect(status).toBe(201);
    expect(resource.id).toBeTruthy();
    encounterServerUUID = resource.id;
  }, 10_000);

  it("POSTs all vital observations and all return 201", async () => {
    expect(encounterServerUUID).toBeTruthy();
    const observations = buildVitalObservations(vitals, { patientServerUUID, encounterServerUUID });
    const results = await Promise.all(
      observations.map((obs) => fhirPost<FhirResource>("Observation", obs))
    );
    for (const { status, resource } of results) {
      expect(status, `${resource.resourceType} ${JSON.stringify((resource as { issue?: unknown }).issue)}`).toBe(201);
    }
  }, 30_000);

  it("POSTs a chief complaint condition", async () => {
    const condition = buildChiefComplaintCondition("chest pain", { patientServerUUID });
    const { status } = await fhirPost<FhirResource>("Condition", condition);
    expect(status).toBe(201);
  }, 10_000);

  it("search-before-create: patient is findable by provisional identifier", async () => {
    const res = await fetch(
      `${FHIR}/Patient?identifier=${encodeURIComponent(mrn)}`,
      { headers: { Authorization: AUTH } }
    );
    expect(res.ok).toBe(true);
    const bundle = (await res.json()) as Bundle;
    expect(bundle.total ?? 0).toBeGreaterThan(0);
    expect(bundle.entry?.[0]?.resource?.id).toBe(patientServerUUID);
  }, 10_000);
});
