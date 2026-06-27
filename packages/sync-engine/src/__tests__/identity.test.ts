/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getCurrentUser, setCurrentUser, reconcileIdentity, clearIdentity, captureIdentity,
} from "../identity.js";
import { getKeyStore } from "../keystore.js";
import { isEnvelope, encryptString } from "../crypto.js";

beforeEach(async () => {
  await clearIdentity();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("identity", () => {
  it("holds the current user in memory and persists it encrypted at rest", async () => {
    await setCurrentUser({ uuid: "u-1", display: "Super User" });
    expect(getCurrentUser()).toEqual({ uuid: "u-1", display: "Super User" });

    const row = await getKeyStore().tokens.get("session-user");
    expect(row).toBeDefined();
    // No plaintext identity on disk.
    expect(isEnvelope(row!.ciphertext)).toBe(true);
    expect(row!.ciphertext).not.toContain("Super User");
  });

  it("restores the persisted identity into memory after a reload", async () => {
    await setCurrentUser({ uuid: "u-2", display: "Field Medic" });
    // Simulate a fresh page load: memory cleared but the encrypted row remains.
    await clearIdentity();
    await getKeyStore().tokens.put({
      id: "session-user",
      ciphertext: await encryptString(JSON.stringify({ uuid: "u-2", display: "Field Medic" })),
    });
    expect(getCurrentUser()).toBeNull();

    const restored = await reconcileIdentity();
    expect(restored).toEqual({ uuid: "u-2", display: "Field Medic" });
    expect(getCurrentUser()).toEqual({ uuid: "u-2", display: "Field Medic" });
  });

  it("clears identity from memory and disk on logout", async () => {
    await setCurrentUser({ uuid: "u-3", display: "Gone" });
    await clearIdentity();
    expect(getCurrentUser()).toBeNull();
    expect(await getKeyStore().tokens.get("session-user")).toBeUndefined();
  });

  it("captures the OpenMRS session user from /session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ authenticated: true, user: { uuid: "u-9", display: "Dr. Who" } }),
      { status: 200 },
    )));

    const user = await captureIdentity("http://omrs/ws/rest/v1", "Basic xyz");
    expect(user).toEqual({ uuid: "u-9", display: "Dr. Who" });
    expect(getCurrentUser()).toEqual({ uuid: "u-9", display: "Dr. Who" });
  });

  it("keeps the known identity when /session is unreachable", async () => {
    await setCurrentUser({ uuid: "u-4", display: "Cached User" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

    const user = await captureIdentity("http://omrs/ws/rest/v1", "Basic xyz");
    expect(user).toEqual({ uuid: "u-4", display: "Cached User" });
  });
});
