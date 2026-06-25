/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db.js";
import { getServerEncounterId } from "../syncWorker.js";
import { logCapture } from "../captureLog.js";

beforeEach(async () => {
  await db.open();
  await Promise.all([db.identityMap.clear(), db.captureLog.clear()]);
});

describe("getServerEncounterId", () => {
  it("joined call: returns the stored server UUID directly", async () => {
    const mrn = "PROV-join0001";
    await logCapture({
      mrn, capturedAt: Date.now(), sex: "male", approximateAge: 50, complaint: "MVC",
      vitalsJson: "{}", submissionStatus: "complete",
      encounterId: "server-enc-uuid", joined: true, patientRef: "server-patient-uuid",
    });
    expect(await getServerEncounterId(mrn)).toBe("server-enc-uuid");
  });

  it("own capture: resolves the provisional id through the identity map", async () => {
    const mrn = "PROV-own00001";
    const provEnc = "ENC-own00001";
    await db.identityMap.put({ provisionalId: provEnc, serverUUID: "resolved-enc-uuid", resourceType: "Encounter", resolvedAt: Date.now() });
    await logCapture({
      mrn, capturedAt: Date.now(), sex: "female", approximateAge: 33, complaint: "fall",
      vitalsJson: "{}", submissionStatus: "complete", encounterId: provEnc,
    });
    expect(await getServerEncounterId(mrn)).toBe("resolved-enc-uuid");
  });

  it("returns undefined while the encounter is still queued (no identity-map entry)", async () => {
    const mrn = "PROV-pending1";
    await logCapture({
      mrn, capturedAt: Date.now(), sex: "unknown", approximateAge: undefined, complaint: "",
      vitalsJson: "{}", submissionStatus: "complete", encounterId: "ENC-not-resolved",
    });
    expect(await getServerEncounterId(mrn)).toBeUndefined();
  });

  it("returns undefined when the capture has no encounter id", async () => {
    const mrn = "PROV-noenc001";
    await logCapture({
      mrn, capturedAt: Date.now(), sex: "male", approximateAge: 40, complaint: "chest pain",
      vitalsJson: "{}", submissionStatus: "complete",
    });
    expect(await getServerEncounterId(mrn)).toBeUndefined();
  });

  it("returns undefined when there is no capture at all", async () => {
    expect(await getServerEncounterId("PROV-missing")).toBeUndefined();
  });
});
