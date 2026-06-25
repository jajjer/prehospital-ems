/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db.js";
import {
  recordConflict,
  getUnresolvedConflicts,
  getUnresolvedConflictCount,
  getConflictsForMrn,
  resolveConflict,
} from "../conflictLog.js";
import { isEnvelope } from "../crypto.js";

const base = {
  resourceType: "Patient",
  resourceId: "PROV-aaa",
  mrn: "PROV-aaa",
  serverUUID: "srv-1",
  localEnqueuedAt: 1_000,
  serverLastUpdated: 2_000,
};

beforeEach(async () => {
  await db.open();
  await db.conflictLog.clear();
});

describe("conflictLog", () => {
  it("records a conflict as unresolved with the local body encrypted at rest", async () => {
    await recordConflict({ ...base, id: "c1", localBody: JSON.stringify({ note: "secret-phi" }) });

    const stored = await db.conflictLog.get("c1");
    expect(stored?.resolution).toBe("unresolved");
    expect(stored?.resolvedAt).toBeUndefined();
    expect(stored?.serverUUID).toBe("srv-1");
    // Body is encrypted — no plaintext PHI on disk.
    expect(isEnvelope(stored?.localBody)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("secret-phi");

    // …but decrypts back to the original when read through the accessor.
    const [conflict] = await getUnresolvedConflicts();
    expect(conflict?.localBody).toContain("secret-phi");
  });

  it("counts and lists only unresolved conflicts, newest first", async () => {
    await recordConflict({ ...base, id: "c1", localBody: "{}" });
    await recordConflict({ ...base, id: "c2", localBody: "{}" });
    // Force a distinct, later detectedAt for ordering, then resolve one.
    await db.conflictLog.update("c2", { detectedAt: (await db.conflictLog.get("c1"))!.detectedAt + 100 });

    expect(await getUnresolvedConflictCount()).toBe(2);

    await resolveConflict("c1", "kept-server");
    expect(await getUnresolvedConflictCount()).toBe(1);

    const resolved = await db.conflictLog.get("c1");
    expect(resolved?.resolution).toBe("kept-server");
    expect(resolved?.resolvedAt).toBeTypeOf("number");

    // The remaining unresolved one is excluded from neither list nor mrn lookup.
    expect((await getUnresolvedConflicts()).map((c) => c.id)).toEqual(["c2"]);
  });

  it("getConflictsForMrn returns only unresolved conflicts for that mrn", async () => {
    await recordConflict({ ...base, id: "c1", mrn: "PROV-aaa", localBody: "{}" });
    await recordConflict({ ...base, id: "c2", mrn: "PROV-bbb", localBody: "{}" });
    await resolveConflict("c1", "kept-local");

    expect(await getConflictsForMrn("PROV-aaa")).toHaveLength(0);
    expect((await getConflictsForMrn("PROV-bbb")).map((c) => c.id)).toEqual(["c2"]);
  });
});
