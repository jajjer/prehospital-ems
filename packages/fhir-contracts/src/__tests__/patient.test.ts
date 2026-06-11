import { describe, it, expect } from "vitest";
import { buildProvisionalMrn, buildProvisionalPatient } from "../builders/patient.js";

describe("buildProvisionalMrn", () => {
  it("produces PROV- prefix", () => {
    expect(buildProvisionalMrn()).toMatch(/^PROV-/);
  });

  it("is unique across two calls in the same session", () => {
    const a = buildProvisionalMrn();
    const b = buildProvisionalMrn();
    expect(a).not.toBe(b);
  });

  it("has 8 hex chars after the prefix", () => {
    const mrn = buildProvisionalMrn();
    expect(mrn).toMatch(/^PROV-[0-9a-f]{8}$/);
  });
});

describe("buildProvisionalPatient", () => {
  const mrn = "PROV-abc12345";

  it("sets resourceType to Patient", () => {
    const p = buildProvisionalPatient(mrn);
    expect(p.resourceType).toBe("Patient");
  });

  it("includes the provisional MRN as the identifier value", () => {
    const p = buildProvisionalPatient(mrn);
    expect(p.identifier?.[0]?.value).toBe(mrn);
  });

  it("uses Old Identification Number type UUID", () => {
    const p = buildProvisionalPatient(mrn);
    expect(p.identifier?.[0]?.type?.coding?.[0]?.code).toBe(
      "8d79403a-c2cc-11de-8d13-0010c6dffd0f"
    );
  });

  it("includes the OpenMRS location extension on the identifier", () => {
    const p = buildProvisionalPatient(mrn);
    const ext = p.identifier?.[0]?.extension?.[0];
    expect(ext?.url).toBe(
      "http://fhir.openmrs.org/ext/patient/identifier#location"
    );
    expect((ext as { url: string; valueReference: { reference: string } }).valueReference.reference).toMatch(
      /^Location\//
    );
  });

  it("respects a custom locationUUID", () => {
    const customUUID = "deadbeef-0000-0000-0000-000000000001";
    const p = buildProvisionalPatient(mrn, { locationUUID: customUUID });
    const ext = p.identifier?.[0]?.extension?.[0] as { url: string; valueReference: { reference: string } };
    expect(ext.valueReference.reference).toBe(`Location/${customUUID}`);
  });

  it("sets gender to unknown", () => {
    const p = buildProvisionalPatient(mrn);
    expect(p.gender).toBe("unknown");
  });

  it("has a temp name with given Unknown", () => {
    const p = buildProvisionalPatient(mrn);
    const name = p.name?.[0];
    expect(name?.use).toBe("temp");
    expect(name?.given).toContain("Unknown");
  });
});
