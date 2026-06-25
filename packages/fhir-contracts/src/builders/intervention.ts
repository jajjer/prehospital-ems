/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import type { MedicationAdministration, Procedure, CodeableConcept } from "fhir/r4";

const CIEL = "https://cielterminology.org";
const SNOMED = "http://snomed.info/sct";
const UCUM = "http://unitsofmeasure.org";

/** The two FHIR resource types prehospital interventions map to. */
export type InterventionResource = "MedicationAdministration" | "Procedure";

/** Routes of administration for medications, by their field-common abbreviation. */
export type MedRoute = "PO" | "SL" | "IV" | "IM" | "IO" | "IN" | "SC" | "neb" | "PR" | "topical";

const ROUTE_LABELS: Record<MedRoute, string> = {
  PO: "Oral",
  SL: "Sublingual",
  IV: "Intravenous",
  IM: "Intramuscular",
  IO: "Intraosseous",
  IN: "Intranasal",
  SC: "Subcutaneous",
  neb: "Nebulized",
  PR: "Rectal",
  topical: "Topical",
};

/**
 * A quick-pick intervention concept. `ciel` is the CIEL numeric concept id; the
 * primary OpenMRS coding is derived from it with the same 36-char A-padding the
 * vitals observations use (see observation.ts). `snomed` adds a standards-based
 * tertiary coding where a stable code is known.
 *
 * NOTE: The CIEL ids below are reference-instance values. A deployment must
 * validate them against its loaded CIEL dictionary before going live — see the
 * "OpenMRS community validation" backlog item. Until then the human-readable
 * `text` (always emitted) keeps the resource clinically meaningful even if a
 * coding fails to resolve server-side.
 */
export interface InterventionConcept {
  /** Stable key used by the UI and local storage. */
  key: string;
  /** Short label for the quick-pick button and the resource `text`. */
  label: string;
  /** FHIR resource this intervention maps to. */
  resource: InterventionResource;
  /** CIEL numeric concept id. */
  ciel: string;
  /** SNOMED CT code, where a stable one is known. */
  snomed?: string;
  /** Default dose amount (medications only). */
  defaultDose?: number;
  /** UCUM dose unit (medications only), e.g. "mg", "mL", "g". */
  doseUnit?: string;
  /** Default route (medications only). */
  defaultRoute?: MedRoute;
}

/**
 * Common prehospital interventions, offline-friendly and minimal-typing: most
 * are a single tap; medications pre-fill a typical adult dose and route the
 * medic can adjust. Ordered roughly by frequency of field use.
 */
export const INTERVENTION_CATALOG: readonly InterventionConcept[] = [
  // Procedures — airway / breathing / circulation / immobilization
  { key: "oxygen",     label: "Oxygen",            resource: "Procedure", ciel: "160255", snomed: "57485005" },
  { key: "bvm",        label: "BVM ventilation",   resource: "Procedure", ciel: "160257", snomed: "243141005" },
  { key: "airway",     label: "Airway adjunct",    resource: "Procedure", ciel: "162825" },
  { key: "cpr",        label: "CPR",               resource: "Procedure", ciel: "160319", snomed: "89666000" },
  { key: "defib",      label: "Defibrillation",    resource: "Procedure", ciel: "160812", snomed: "429500007" },
  { key: "iv-access",  label: "IV/IO access",      resource: "Procedure", ciel: "162055" },
  { key: "hemorrhage", label: "Bleeding control",  resource: "Procedure", ciel: "165270", snomed: "788759005" },
  { key: "splint",     label: "Splint/immobilize", resource: "Procedure", ciel: "162454" },
  { key: "spinal",     label: "Spinal precaution", resource: "Procedure", ciel: "161641" },
  { key: "dressing",   label: "Wound dressing",    resource: "Procedure", ciel: "165270" },

  // Medications — MedicationAdministration with a typical adult dose + route
  { key: "iv-fluids",  label: "IV fluids (NS)",    resource: "MedicationAdministration", ciel: "70670",  defaultDose: 500, doseUnit: "mL", defaultRoute: "IV" },
  { key: "aspirin",    label: "Aspirin",           resource: "MedicationAdministration", ciel: "71617",  defaultDose: 300, doseUnit: "mg", defaultRoute: "PO" },
  { key: "gtn",        label: "GTN",               resource: "MedicationAdministration", ciel: "75959",  defaultDose: 0.4, doseUnit: "mg", defaultRoute: "SL" },
  { key: "adrenaline", label: "Adrenaline",        resource: "MedicationAdministration", ciel: "71613",  defaultDose: 0.5, doseUnit: "mg", defaultRoute: "IM" },
  { key: "salbutamol", label: "Salbutamol",        resource: "MedicationAdministration", ciel: "70771",  defaultDose: 5,   doseUnit: "mg", defaultRoute: "neb" },
  { key: "naloxone",   label: "Naloxone",          resource: "MedicationAdministration", ciel: "72706",  defaultDose: 0.4, doseUnit: "mg", defaultRoute: "IN" },
  { key: "dextrose",   label: "Dextrose 50%",      resource: "MedicationAdministration", ciel: "72869",  defaultDose: 25,  doseUnit: "g",  defaultRoute: "IV" },
  { key: "morphine",   label: "Morphine",          resource: "MedicationAdministration", ciel: "70540",  defaultDose: 5,   doseUnit: "mg", defaultRoute: "IV" },
];

const CATALOG_BY_KEY: ReadonlyMap<string, InterventionConcept> = new Map(
  INTERVENTION_CATALOG.map((c) => [c.key, c]),
);

/** Look up a catalog concept by key. Returns undefined for unknown keys. */
export function getInterventionConcept(key: string): InterventionConcept | undefined {
  return CATALOG_BY_KEY.get(key);
}

/** A single captured intervention, as produced by the capture UI. */
export interface InterventionInput {
  /** Catalog key identifying the intervention. */
  key: string;
  /** ISO 8601 time administered/performed; defaults to now. */
  time?: string;
  /** Dose amount (medications only); defaults to the concept's `defaultDose`. */
  dose?: number;
  /** UCUM dose unit override (medications only); defaults to the concept's `doseUnit`. */
  doseUnit?: string;
  /** Route of administration (medications only); defaults to the concept's `defaultRoute`. */
  route?: MedRoute;
  /** Free-text remark (site, patient response, provider), capped at 255 chars. */
  note?: string;
}

export interface InterventionContext {
  patientServerUUID: string;
  encounterServerUUID: string;
}

/** Build the CodeableConcept (OpenMRS UUID → CIEL → SNOMED) for a concept. */
function conceptCodeable(concept: InterventionConcept): CodeableConcept {
  const coding = [
    // Primary: OpenMRS concept UUID (no system = direct UUID lookup in fhir2).
    // CIEL-backed concepts are stored A-padded to 36 chars (see observation.ts).
    { code: cielToUuid(concept.ciel), display: concept.label },
    // Secondary: CIEL terminology for concept-mapping resolution.
    { system: CIEL, code: concept.ciel },
    // Tertiary: SNOMED CT for downstream interoperability, where known.
    ...(concept.snomed ? [{ system: SNOMED, code: concept.snomed }] : []),
  ];
  return { coding, text: concept.label };
}

/** Pad a CIEL numeric id to the 36-char A-suffixed OpenMRS concept UUID form. */
function cielToUuid(ciel: string): string {
  return ciel + "A".repeat(36 - ciel.length);
}

function buildMedicationAdministration(
  concept: InterventionConcept,
  input: InterventionInput,
  ctx: InterventionContext,
  effectiveDateTime: string,
): MedicationAdministration {
  const dose = input.dose ?? concept.defaultDose;
  const doseUnit = input.doseUnit ?? concept.doseUnit;
  const route = input.route ?? concept.defaultRoute;

  const dosage: MedicationAdministration["dosage"] = {};
  if (route) dosage.route = { text: ROUTE_LABELS[route] };
  if (dose !== undefined && doseUnit) {
    dosage.dose = { value: dose, unit: doseUnit, system: UCUM, code: doseUnit };
  }

  return {
    resourceType: "MedicationAdministration",
    status: "completed",
    medicationCodeableConcept: conceptCodeable(concept),
    subject: { reference: `Patient/${ctx.patientServerUUID}`, type: "Patient" },
    // MedicationAdministration links the encounter via `context`, not `encounter`.
    context: { reference: `Encounter/${ctx.encounterServerUUID}`, type: "Encounter" },
    effectiveDateTime,
    ...(dosage.route || dosage.dose ? { dosage } : {}),
    ...(input.note ? { note: [{ text: input.note.slice(0, 255) }] } : {}),
  };
}

function buildProcedure(
  concept: InterventionConcept,
  input: InterventionInput,
  ctx: InterventionContext,
  performedDateTime: string,
): Procedure {
  return {
    resourceType: "Procedure",
    status: "completed",
    code: conceptCodeable(concept),
    subject: { reference: `Patient/${ctx.patientServerUUID}`, type: "Patient" },
    encounter: { reference: `Encounter/${ctx.encounterServerUUID}`, type: "Encounter" },
    performedDateTime,
    ...(input.note ? { note: [{ text: input.note.slice(0, 255) }] } : {}),
  };
}

/**
 * Build the FHIR resource for one captured intervention, dispatching to
 * MedicationAdministration or Procedure based on its catalog concept.
 * Throws on an unknown key — the UI only ever passes catalog keys.
 */
export function buildIntervention(
  input: InterventionInput,
  ctx: InterventionContext,
): MedicationAdministration | Procedure {
  const concept = getInterventionConcept(input.key);
  if (!concept) throw new Error(`buildIntervention: unknown intervention key "${input.key}"`);
  const time = input.time ?? new Date().toISOString();
  return concept.resource === "MedicationAdministration"
    ? buildMedicationAdministration(concept, input, ctx, time)
    : buildProcedure(concept, input, ctx, time);
}
