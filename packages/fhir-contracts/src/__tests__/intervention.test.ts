/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect } from "vitest";
import type { MedicationAdministration, Procedure } from "fhir/r4";
import {
  buildIntervention,
  getInterventionConcept,
  INTERVENTION_CATALOG,
} from "../builders/intervention.js";

const ctx = {
  patientServerUUID: "patient-srv-uuid",
  encounterServerUUID: "encounter-srv-uuid",
};

describe("INTERVENTION_CATALOG", () => {
  it("has unique keys", () => {
    const keys = INTERVENTION_CATALOG.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every medication concept has a default dose, unit and route", () => {
    for (const c of INTERVENTION_CATALOG.filter((c) => c.resource === "MedicationAdministration")) {
      expect(c.defaultDose, c.key).toBeTypeOf("number");
      expect(c.doseUnit, c.key).toBeTruthy();
      expect(c.defaultRoute, c.key).toBeTruthy();
    }
  });

  it("every concept maps to MedicationAdministration or Procedure", () => {
    for (const c of INTERVENTION_CATALOG) {
      expect(["MedicationAdministration", "Procedure"]).toContain(c.resource);
    }
  });
});

describe("getInterventionConcept", () => {
  it("returns a concept for a known key", () => {
    expect(getInterventionConcept("aspirin")?.label).toBe("Aspirin");
  });
  it("returns undefined for an unknown key", () => {
    expect(getInterventionConcept("not-a-real-key")).toBeUndefined();
  });
});

describe("buildIntervention — Procedure", () => {
  it("builds a Procedure for a procedure concept", () => {
    const r = buildIntervention({ key: "cpr" }, ctx) as Procedure;
    expect(r.resourceType).toBe("Procedure");
    expect(r.status).toBe("completed");
    expect(r.subject.reference).toBe(`Patient/${ctx.patientServerUUID}`);
    expect(r.encounter?.reference).toBe(`Encounter/${ctx.encounterServerUUID}`);
    expect(r.performedDateTime).toBeTruthy();
  });

  it("emits text plus OpenMRS-UUID / CIEL / SNOMED codings when SNOMED is known", () => {
    const r = buildIntervention({ key: "cpr" }, ctx) as Procedure;
    const coding = r.code?.coding ?? [];
    expect(r.code?.text).toBe("CPR");
    // Primary OpenMRS concept UUID is the A-padded CIEL id, 36 chars, no system.
    expect(coding[0]?.system).toBeUndefined();
    expect(coding[0]?.code).toHaveLength(36);
    expect(coding[1]?.system).toBe("https://cielterminology.org");
    expect(coding[2]?.system).toBe("http://snomed.info/sct");
  });

  it("omits the SNOMED coding when the concept has none", () => {
    const r = buildIntervention({ key: "airway" }, ctx) as Procedure;
    const systems = (r.code?.coding ?? []).map((c) => c.system);
    expect(systems).not.toContain("http://snomed.info/sct");
  });

  it("attaches a truncated note when provided", () => {
    const r = buildIntervention({ key: "splint", note: "x".repeat(300) }, ctx) as Procedure;
    expect(r.note?.[0]?.text).toHaveLength(255);
  });

  it("honours an explicit time", () => {
    const t = "2026-01-02T03:04:05.000Z";
    const r = buildIntervention({ key: "cpr", time: t }, ctx) as Procedure;
    expect(r.performedDateTime).toBe(t);
  });
});

describe("buildIntervention — MedicationAdministration", () => {
  it("builds a MedicationAdministration with default dose/route from the catalog", () => {
    const r = buildIntervention({ key: "aspirin" }, ctx) as MedicationAdministration;
    expect(r.resourceType).toBe("MedicationAdministration");
    expect(r.status).toBe("completed");
    expect(r.subject.reference).toBe(`Patient/${ctx.patientServerUUID}`);
    // MedicationAdministration links the encounter via `context`, not `encounter`.
    expect(r.context?.reference).toBe(`Encounter/${ctx.encounterServerUUID}`);
    expect(r.medicationCodeableConcept?.text).toBe("Aspirin");
    expect(r.dosage?.dose?.value).toBe(300);
    expect(r.dosage?.dose?.unit).toBe("mg");
    expect(r.dosage?.dose?.system).toBe("http://unitsofmeasure.org");
    expect(r.dosage?.route?.text).toBe("Oral");
  });

  it("applies dose/route overrides", () => {
    const r = buildIntervention(
      { key: "adrenaline", dose: 1, doseUnit: "mg", route: "IV" },
      ctx,
    ) as MedicationAdministration;
    expect(r.dosage?.dose?.value).toBe(1);
    expect(r.dosage?.route?.text).toBe("Intravenous");
  });

  it("nebulized route expands to its label and uses the catalog dose", () => {
    const r = buildIntervention({ key: "salbutamol" }, ctx) as MedicationAdministration;
    expect(r.dosage?.route?.text).toBe("Nebulized");
    expect(r.dosage?.dose?.value).toBe(5);
  });
});

describe("buildIntervention — errors", () => {
  it("throws on an unknown key", () => {
    expect(() => buildIntervention({ key: "nope" }, ctx)).toThrow(/unknown intervention key/);
  });
});
