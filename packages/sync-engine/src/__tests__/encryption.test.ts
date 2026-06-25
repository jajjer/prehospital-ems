/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db.js";
import { enqueue } from "../syncWorker.js";
import { logCapture, getRecentCaptures, markCaptureComplete, retryDeadLettered } from "../captureLog.js";
import { isEnvelope, decryptString, decryptField, encryptString } from "../crypto.js";

beforeEach(async () => {
  // The accessors under test use the db singleton, so clear its tables between
  // tests rather than swapping the IndexedDB factory (which would desync the
  // singleton's open connection from rawGet's view).
  await db.open();
  await Promise.all([
    db.writeQueue.clear(),
    db.deadLetter.clear(),
    db.captureLog.clear(),
  ]);
});

/**
 * Read a record straight from IndexedDB, bypassing Dexie entirely — this is what
 * an attacker inspecting the device (or DevTools) sees on disk.
 */
function rawGet(store: string, key: IDBValidKey): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("prehospital-ems-sync");
    open.onsuccess = () => {
      const idb = open.result;
      const tx = idb.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => {
        resolve(req.result as Record<string, unknown>);
        idb.close();
      };
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
}

describe("PHI at-rest encryption", () => {
  it("stores writeQueue.body as ciphertext and round-trips to plaintext", async () => {
    const body = JSON.stringify({ resourceType: "Patient", name: [{ text: "Jane Doe" }] });
    await enqueue({ id: "q-1", resourceType: "Patient", resourceId: "PROV-1", body });

    const raw = await rawGet("writeQueue", "q-1");
    expect(isEnvelope(raw.body)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("Jane Doe");
    // Non-PHI indexed fields stay queryable in cleartext.
    expect(raw.resourceId).toBe("PROV-1");

    // Decrypting (as the sync worker does before POST) recovers the exact body.
    expect(await decryptString(raw.body as string)).toBe(body);
  });

  it("encrypts every captureLog PHI field at rest and decrypts on read", async () => {
    await logCapture({
      mrn: "MRN-1",
      capturedAt: Date.now(),
      sex: "female",
      approximateAge: 34,
      complaint: "shortness of breath",
      vitalsJson: JSON.stringify({ hr: 110, spo2: 88 }),
      assessmentJson: JSON.stringify({ allergies: "penicillin", narrative: "found supine" }),
      submissionStatus: "pending",
      encounterId: "ENC-abc12345",
      lat: -1.2921,
      lng: 36.8219,
    });

    const raw = await rawGet("captureLog", "MRN-1");
    for (const field of ["sex", "approximateAge", "complaint", "vitalsJson", "assessmentJson", "lat", "lng"]) {
      expect(isEnvelope(raw[field])).toBe(true);
    }
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain("shortness of breath");
    expect(serialized).not.toContain("penicillin");
    expect(serialized).not.toContain("36.8219");
    // mrn, timestamp, and the reference id used by the sync worker stay cleartext.
    expect(raw.mrn).toBe("MRN-1");
    expect(raw.encounterId).toBe("ENC-abc12345");

    const [readBack] = await getRecentCaptures();
    expect(readBack).toMatchObject({
      sex: "female",
      approximateAge: 34,
      complaint: "shortness of breath",
      vitalsJson: JSON.stringify({ hr: 110, spo2: 88 }),
      assessmentJson: JSON.stringify({ allergies: "penicillin", narrative: "found supine" }),
      lat: -1.2921,
      lng: 36.8219,
    });
  });

  it("does not double-encrypt PHI when a non-PHI field is updated", async () => {
    await logCapture({
      mrn: "MRN-2",
      capturedAt: Date.now(),
      sex: "male",
      approximateAge: undefined,
      complaint: "laceration",
      vitalsJson: "{}",
      submissionStatus: "pending",
    });

    await markCaptureComplete("MRN-2");

    const raw = await rawGet("captureLog", "MRN-2");
    expect(raw.submissionStatus).toBe("complete");
    expect(isEnvelope(raw.complaint)).toBe(true);
    // A single decrypt yields the original — proves it wasn't wrapped twice.
    expect(await decryptField(raw.complaint)).toBe("laceration");

    const [readBack] = await getRecentCaptures();
    expect(readBack?.complaint).toBe("laceration");
    expect(readBack?.submissionStatus).toBe("complete");
  });

  it("keeps a body single-encrypted as it moves deadLetter → writeQueue on retry", async () => {
    const body = JSON.stringify({ resourceType: "Observation", note: "confidential" });
    await db.deadLetter.put({
      id: "dl-1",
      resourceType: "Observation",
      resourceId: "obs-1",
      patientId: "MRN-3",
      encounterId: undefined,
      statusCode: 422,
      body: await encryptString(body), // stored encrypted, as the sync worker does
      failedAt: Date.now(),
    });

    await retryDeadLettered("MRN-3");

    // Moved back to the queue, still ciphertext, still cleartext on decrypt.
    expect(await db.deadLetter.get("dl-1")).toBeUndefined();
    const raw = await rawGet("writeQueue", "dl-1");
    expect(isEnvelope(raw.body)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("confidential");
    expect(await decryptString(raw.body as string)).toBe(body);
  });
});
