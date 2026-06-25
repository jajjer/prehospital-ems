/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect } from "vitest";
import type { Observation, Condition } from "fhir/r4";
import { buildAssessmentResources, type AssessmentInput } from "../builders/assessment.js";
import { validateAssessment, assertValidAssessment } from "../validators/assessment.js";

const ctx = {
  patientServerUUID: "patient-srv-uuid",
  encounterServerUUID: "encounter-srv-uuid",
};

const obsByText = (resources: Array<Observation | Condition>, text: string) =>
  resources.find((r) => r.resourceType === "Observation" && r.code?.text === text) as Observation | undefined;

describe("buildAssessmentResources", () => {
  it("returns nothing for an empty assessment", () => {
    expect(buildAssessmentResources({}, ctx)).toHaveLength(0);
  });

  it("maps pain score to a valueQuantity Observation", () => {
    const r = obsByText(buildAssessmentResources({ painScore: 7 }, ctx), "Pain score (0–10)");
    expect(r?.valueQuantity?.value).toBe(7);
    expect(r?.valueQuantity?.code).toBe("{score}");
  });

  it("maps blood glucose with mg/dL units", () => {
    const r = obsByText(buildAssessmentResources({ bloodGlucose: 90 }, ctx), "Blood glucose");
    expect(r?.valueQuantity?.value).toBe(90);
    expect(r?.valueQuantity?.unit).toBe("mg/dL");
  });

  it("maps AVPU to a valueString with the expanded label", () => {
    const r = obsByText(buildAssessmentResources({ avpu: "V" }, ctx), "AVPU responsiveness");
    expect(r?.valueString).toBe("V — Responds to voice");
  });

  it("emits a pupil Observation only when size or reactivity is present", () => {
    expect(buildAssessmentResources({ pupilLeft: {} }, ctx)).toHaveLength(0);
    const left = obsByText(buildAssessmentResources({ pupilLeft: { size: 4, reactivity: "brisk" } }, ctx), "Left pupil");
    expect(left?.valueString).toBe("4 mm, brisk");
    const right = obsByText(buildAssessmentResources({ pupilRight: { reactivity: "fixed" } }, ctx), "Right pupil");
    expect(right?.valueString).toBe("fixed");
  });

  it("maps free-text fields to valueString Observations", () => {
    const resources = buildAssessmentResources(
      { mechanismOfInjury: "RTC, 60 km/h", allergies: "penicillin", medications: "metformin", narrative: "Found supine." },
      ctx,
    );
    expect(obsByText(resources, "Mechanism of injury")?.valueString).toBe("RTC, 60 km/h");
    expect(obsByText(resources, "Known allergies")?.valueString).toBe("penicillin");
    expect(obsByText(resources, "Current medications")?.valueString).toBe("metformin");
    expect(obsByText(resources, "Prehospital narrative")?.valueString).toBe("Found supine.");
  });

  it("skips blank/whitespace-only free-text fields", () => {
    expect(buildAssessmentResources({ narrative: "   ", allergies: "" }, ctx)).toHaveLength(0);
  });

  it("maps past history to a problem-list Condition", () => {
    const resources = buildAssessmentResources({ pastHistory: "Type 2 diabetes" }, ctx);
    const cond = resources.find((r) => r.resourceType === "Condition") as Condition | undefined;
    expect(cond?.code?.text).toContain("Type 2 diabetes");
    expect(cond?.category?.[0]?.coding?.[0]?.code).toBe("problem-list-item");
    expect(cond?.subject?.reference).toBe(`Patient/${ctx.patientServerUUID}`);
  });

  it("references the patient and encounter on every Observation", () => {
    const resources = buildAssessmentResources({ painScore: 3, avpu: "A", bloodGlucose: 100 }, ctx);
    for (const r of resources) {
      if (r.resourceType !== "Observation") continue;
      expect(r.subject?.reference).toBe(`Patient/${ctx.patientServerUUID}`);
      expect(r.encounter?.reference).toBe(`Encounter/${ctx.encounterServerUUID}`);
    }
  });

  it("carries OpenMRS-UUID + CIEL coding, and LOINC where known", () => {
    const r = obsByText(buildAssessmentResources({ painScore: 5 }, ctx), "Pain score (0–10)");
    const coding = r?.code?.coding ?? [];
    expect(coding[0]?.system).toBeUndefined();
    expect(coding[0]?.code).toHaveLength(36);
    expect(coding[1]?.system).toBe("https://cielterminology.org");
    expect(coding[2]?.system).toBe("http://loinc.org");
  });

  it("truncates free text to 255 characters", () => {
    const r = obsByText(buildAssessmentResources({ narrative: "x".repeat(400) }, ctx), "Prehospital narrative");
    expect(r?.valueString).toHaveLength(255);
  });

  it("honours an explicit effective time", () => {
    const t = "2026-01-02T03:04:05.000Z";
    const resources = buildAssessmentResources({ painScore: 1 }, { ...ctx, effectiveTime: t });
    expect((resources[0] as Observation).effectiveDateTime).toBe(t);
  });
});

describe("validateAssessment", () => {
  it("accepts an empty assessment", () => {
    expect(validateAssessment({})).toHaveLength(0);
  });

  it("accepts a fully-populated valid assessment", () => {
    const input: AssessmentInput = {
      avpu: "A", painScore: 0, bloodGlucose: 95,
      pupilLeft: { size: 3, reactivity: "brisk" }, pupilRight: { size: 3, reactivity: "brisk" },
      mechanismOfInjury: "fall", narrative: "ok", allergies: "none", medications: "none", pastHistory: "none",
    };
    expect(validateAssessment(input)).toHaveLength(0);
  });

  it("rejects a pain score above 10", () => {
    expect(validateAssessment({ painScore: 11 }).some((e) => e.field === "painScore")).toBe(true);
  });

  it("rejects an out-of-range blood glucose", () => {
    expect(validateAssessment({ bloodGlucose: 5 }).some((e) => e.field === "bloodGlucose")).toBe(true);
  });

  it("rejects an implausible pupil size", () => {
    expect(validateAssessment({ pupilLeft: { size: 12 } }).some((e) => e.field === "pupilLeft")).toBe(true);
  });

  it("rejects over-long free text", () => {
    expect(validateAssessment({ narrative: "x".repeat(256) }).some((e) => e.field === "narrative")).toBe(true);
  });

  it("assertValidAssessment throws on invalid input", () => {
    expect(() => assertValidAssessment({ painScore: -1 })).toThrow(RangeError);
  });
});
