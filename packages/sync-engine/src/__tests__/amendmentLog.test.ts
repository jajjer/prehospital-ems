/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db.js";
import { recordAmendment, getAmendmentsForMrn } from "../amendmentLog.js";
import { isEnvelope } from "../crypto.js";

const base = {
  field: "vitals.hr",
  label: "Heart Rate",
  amendedByDisplay: "Dr. Strange",
  amendedByUuid: "user-uuid-1",
  reason: undefined as string | undefined,
  originalSynced: false,
};

beforeEach(async () => {
  await db.open();
  await db.amendmentLog.clear();
});

describe("amendmentLog", () => {
  it("records an amendment with the value columns encrypted at rest", async () => {
    await recordAmendment({
      ...base, mrn: "PROV-aaa",
      previousValue: "80", newValue: "88", reason: "transposed digits",
    });

    const rows = await db.amendmentLog.where("mrn").equals("PROV-aaa").toArray();
    expect(rows).toHaveLength(1);
    const stored = rows[0]!;
    // PHI value columns are encrypted — no plaintext on disk.
    expect(isEnvelope(stored.previousValue)).toBe(true);
    expect(isEnvelope(stored.newValue)).toBe(true);
    expect(isEnvelope(stored.reason)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("88");
    // Actor identity and field stay cleartext for indexing/filtering.
    expect(stored.amendedByDisplay).toBe("Dr. Strange");
    expect(stored.field).toBe("vitals.hr");
    expect(stored.originalSynced).toBe(false);

    // …and decrypts back through the accessor.
    const [amendment] = await getAmendmentsForMrn("PROV-aaa");
    expect(amendment?.previousValue).toBe("80");
    expect(amendment?.newValue).toBe("88");
    expect(amendment?.reason).toBe("transposed digits");
  });

  it("leaves an omitted reason undefined (not encrypted)", async () => {
    await recordAmendment({ ...base, mrn: "PROV-bbb", previousValue: "1", newValue: "2" });
    const [amendment] = await getAmendmentsForMrn("PROV-bbb");
    expect(amendment?.reason).toBeUndefined();
  });

  it("is append-only: re-amending the same field adds a new immutable row", async () => {
    await recordAmendment({ ...base, mrn: "PROV-ccc", previousValue: "80", newValue: "88" });
    await recordAmendment({ ...base, mrn: "PROV-ccc", previousValue: "88", newValue: "92" });

    const rows = await getAmendmentsForMrn("PROV-ccc");
    expect(rows).toHaveLength(2);
    // Distinct primary keys — nothing was overwritten.
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    // Both corrections survive in the trail.
    const newValues = rows.map((r) => r.newValue).sort();
    expect(newValues).toEqual(["88", "92"]);
  });

  it("returns amendments newest first and scoped to the mrn", async () => {
    await recordAmendment({ ...base, mrn: "PROV-ddd", previousValue: "a", newValue: "b" });
    await recordAmendment({ ...base, mrn: "PROV-eee", previousValue: "c", newValue: "d" });
    await recordAmendment({ ...base, mrn: "PROV-ddd", previousValue: "b", newValue: "e" });

    const rows = await getAmendmentsForMrn("PROV-ddd");
    // Scoped to PROV-ddd only (PROV-eee excluded), and sorted by amendedAt descending.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.mrn === "PROV-ddd")).toBe(true);
    expect(rows[0]!.amendedAt).toBeGreaterThanOrEqual(rows[1]!.amendedAt);
  });
});
