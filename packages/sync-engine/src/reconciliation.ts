/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { db, type ReconciliationLogEntry } from "./db.js";
import { encryptBody, decryptBody } from "./phiCrypto.js";
import { encryptCapture, decryptCapture } from "./phiCrypto.js";
import { getServerEncounterId } from "./syncWorker.js";

/**
 * Patient reconciliation / MPI matching.
 *
 * Field captures start life as a provisional "Unknown Patient" with a
 * `PROV-{uuid8}` identifier (see fhir-contracts buildProvisionalPatient). This
 * module links such a record to a confirmed OpenMRS patient found via the MPI,
 * re-pointing the synced Encounter and its dependent Observations/Conditions to
 * the confirmed identity — without losing the provisional identifier, which is
 * preserved for traceability and audited.
 */

/** A confirmed-patient candidate returned from an MPI search. */
export interface MpiCandidate {
  /** OpenMRS patient UUID. */
  uuid: string;
  /** Display name, e.g. "Jane Doe". */
  name: string;
  /** FHIR gender: male | female | other | unknown. */
  gender: string;
  /** Birth date (YYYY or YYYY-MM-DD), if recorded. */
  birthDate: string | undefined;
  /** Official identifier value (the real MRN), if any. */
  identifier: string | undefined;
}

/** Provisional identifiers carry this prefix — never a confirmed-identity match. */
const PROVISIONAL_PREFIX = "PROV-";

interface FhirBundle {
  entry?: Array<{ resource?: FhirPatient }>;
}

interface FhirPatient {
  resourceType?: string;
  id?: string;
  gender?: string;
  birthDate?: string;
  name?: Array<{ text?: string; given?: string[]; family?: string; use?: string }>;
  identifier?: Array<{ use?: string; value?: string }>;
}

/** Renders a FHIR HumanName into a single display string, preferring an official name. */
function formatName(patient: FhirPatient): string {
  const names = patient.name ?? [];
  const chosen = names.find((n) => n.use === "official") ?? names[0];
  if (!chosen) return "Unnamed patient";
  if (chosen.text) return chosen.text;
  const given = (chosen.given ?? []).join(" ");
  return [given, chosen.family].filter(Boolean).join(" ").trim() || "Unnamed patient";
}

/** Picks the official (real) identifier, skipping provisional PROV- values. */
function officialIdentifier(patient: FhirPatient): string | undefined {
  const ids = patient.identifier ?? [];
  const real = ids.find((i) => i.value && !i.value.startsWith(PROVISIONAL_PREFIX));
  return real?.value;
}

/** True when the patient's only identifiers are provisional PROV- values. */
function isProvisionalOnly(patient: FhirPatient): boolean {
  const ids = patient.identifier ?? [];
  if (ids.length === 0) return false;
  return ids.every((i) => i.value?.startsWith(PROVISIONAL_PREFIX));
}

/**
 * Searches the OpenMRS MPI for confirmed patients matching `query` (a name or an
 * identifier). Provisional ("Unknown Patient") records are filtered out — you
 * reconcile *to* a confirmed identity, never to another orphan. Returns an empty
 * array when offline, on error, or on timeout (4 s). Never throws.
 */
export async function searchPatientsByMpi(
  query: string,
  fhirBase: string,
  authHeader: string,
): Promise<MpiCandidate[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (typeof navigator !== "undefined" && !navigator.onLine) return [];

  try {
    const res = await fetch(
      `${fhirBase}/Patient?name=${encodeURIComponent(trimmed)}&_count=20`,
      { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(4_000) },
    );
    if (!res.ok) return [];
    const bundle = (await res.json()) as FhirBundle;

    const candidates: MpiCandidate[] = [];
    for (const entry of bundle.entry ?? []) {
      const p = entry.resource;
      if (!p || p.resourceType !== "Patient" || !p.id) continue;
      if (isProvisionalOnly(p)) continue;
      candidates.push({
        uuid: p.id,
        name: formatName(p),
        gender: p.gender ?? "unknown",
        birthDate: p.birthDate,
        identifier: officialIdentifier(p),
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

export type ReconcileResult = "ok" | "not-synced" | "network-error" | "server-error";

export interface ReconcileOptions {
  /** Provisional MRN of the capture being reconciled. */
  mrn: string;
  /** The confirmed patient this record should be linked to. */
  target: MpiCandidate;
  fhirBaseUrl: string;
  authHeader: string;
}

/** Dependent resource types whose `subject` is re-pointed to the confirmed patient. */
const DEPENDENT_TYPES = ["Observation", "Condition", "Procedure", "MedicationAdministration"] as const;

/**
 * Reconciles a provisional record to a confirmed OpenMRS patient.
 *
 * Two timing cases, both lossless:
 *  - Pre-sync (the provisional Patient is still queued): drop the queued Patient
 *    POST so no orphan is ever created, and map the provisional id → confirmed
 *    UUID. The Encounter and Observations then resolve to the confirmed patient
 *    on the next flush via the existing identity-map reference resolution.
 *  - Post-sync (the provisional Patient already reached the server): PATCH the
 *    Encounter's subject to the confirmed patient, then re-point every dependent
 *    Observation/Condition/Procedure/MedicationAdministration found for that
 *    encounter. Future resources (e.g. repeat vitals) follow via the updated map.
 *
 * In both cases the provisional identifier is preserved (it stays the captureLog
 * key) and the reconciliation is audited. Requires the device to be online for
 * the post-sync case. Never overwrites confirmed-patient demographics.
 */
export async function reconcilePatient(opts: ReconcileOptions): Promise<ReconcileResult> {
  const { mrn, target, fhirBaseUrl, authHeader } = opts;

  const capture = await db.captureLog.get(mrn);
  if (!capture) return "not-synced";

  const patientMapEntry = await db.identityMap.get(mrn);
  const provisionalPatientUUID = patientMapEntry?.serverUUID;

  let repointedCount = 0;
  let serverEncounterId: string | undefined;

  if (!provisionalPatientUUID) {
    // Pre-sync: the provisional Patient hasn't been created server-side yet.
    // Remove its queued POST and map the provisional id straight to the confirmed
    // patient — dependents resolve via the identity map, no orphan is created.
    await db.writeQueue
      .filter((i) => i.resourceType === "Patient" && i.resourceId === mrn)
      .delete();
    await db.identityMap.put({
      provisionalId: mrn,
      serverUUID: target.uuid,
      resourceType: "Patient",
      resolvedAt: Date.now(),
    });
  } else {
    // Post-sync: re-point the already-created server resources.
    serverEncounterId = await getServerEncounterId(mrn);
    if (serverEncounterId) {
      const patched = await patchSubject(
        `${fhirBaseUrl}/Encounter/${serverEncounterId}`,
        target.uuid,
        authHeader,
      );
      if (patched === "network-error") return "network-error";
      if (patched === "server-error") return "server-error";

      repointedCount = await repointDependents(
        serverEncounterId,
        target.uuid,
        fhirBaseUrl,
        authHeader,
      );
    }

    // Point the provisional id at the confirmed patient so any resources enqueued
    // after reconciliation (e.g. serial vitals) attach to the confirmed identity.
    await db.identityMap.put({
      provisionalId: mrn,
      serverUUID: target.uuid,
      resourceType: "Patient",
      resolvedAt: Date.now(),
    });
  }

  // Update the local capture so Records/handoff show the confirmed identity, while
  // the provisional mrn stays the key for traceability. patientRef keeps repeat
  // vitals (joined or own) pointed at the confirmed patient.
  const decrypted = await decryptCapture(capture);
  decrypted.reconciledPatientUUID = target.uuid;
  decrypted.reconciledName = target.name;
  decrypted.reconciledAt = Date.now();
  decrypted.patientRef = target.uuid;
  await db.captureLog.put(await encryptCapture(decrypted));

  await recordReconciliation({
    mrn,
    provisionalPatientUUID,
    targetPatientUUID: target.uuid,
    targetName: target.name,
    targetIdentifier: target.identifier,
    encounterId: serverEncounterId,
    repointedCount,
  });

  return "ok";
}

type PatchOutcome = "ok" | "network-error" | "server-error";

/** PATCHes a resource's `/subject/reference` to `Patient/{uuid}` (JSON Patch). */
async function patchSubject(url: string, patientUUID: string, authHeader: string): Promise<PatchOutcome> {
  const patches = [{ op: "replace", path: "/subject/reference", value: `Patient/${patientUUID}` }];
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json-patch+json", Authorization: authHeader },
      body: JSON.stringify(patches),
    });
  } catch {
    return "network-error";
  }
  return response.ok ? "ok" : "server-error";
}

/**
 * Re-points every dependent resource attached to `encounterId` at the confirmed
 * patient. Best-effort: a search or PATCH failure for one type is skipped rather
 * than aborting the whole reconciliation — the Encounter link (re-pointed first
 * by the caller) is the authoritative one. Returns the count actually re-pointed.
 */
async function repointDependents(
  encounterId: string,
  patientUUID: string,
  fhirBase: string,
  authHeader: string,
): Promise<number> {
  let count = 0;
  for (const type of DEPENDENT_TYPES) {
    let ids: string[];
    try {
      const res = await fetch(
        `${fhirBase}/${type}?encounter=Encounter/${encounterId}&_count=100`,
        { headers: { Authorization: authHeader } },
      );
      if (!res.ok) continue;
      const bundle = (await res.json()) as { entry?: Array<{ resource?: { id?: string } }> };
      ids = (bundle.entry ?? []).map((e) => e.resource?.id).filter((id): id is string => !!id);
    } catch {
      continue;
    }
    for (const id of ids) {
      if ((await patchSubject(`${fhirBase}/${type}/${id}`, patientUUID, authHeader)) === "ok") {
        count++;
      }
    }
  }
  return count;
}

interface RecordReconciliationInput {
  mrn: string;
  provisionalPatientUUID: string | undefined;
  targetPatientUUID: string;
  targetName: string;
  targetIdentifier: string | undefined;
  encounterId: string | undefined;
  repointedCount: number;
}

/** Persists the reconciliation audit record. The confirmed name (PHI) is encrypted. */
async function recordReconciliation(input: RecordReconciliationInput): Promise<void> {
  await db.reconciliationLog.put({
    mrn: input.mrn,
    provisionalPatientUUID: input.provisionalPatientUUID,
    targetPatientUUID: input.targetPatientUUID,
    targetName: await encryptBody(input.targetName),
    targetIdentifier: input.targetIdentifier,
    encounterId: input.encounterId,
    repointedCount: input.repointedCount,
    reconciledAt: Date.now(),
  });
}

/** The reconciliation audit record for an MRN (confirmed name decrypted), if any. */
export async function getReconciliation(mrn: string): Promise<ReconciliationLogEntry | undefined> {
  const entry = await db.reconciliationLog.get(mrn);
  if (!entry) return undefined;
  return { ...entry, targetName: await decryptBody(entry.targetName) };
}
