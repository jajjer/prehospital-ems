/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect } from "vitest";
import { isRemoteWipeRequested } from "../remoteWipe.js";

const BASE = "https://admin.example.org/wipe-status";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe("isRemoteWipeRequested", () => {
  it("returns true when the server flags the device", async () => {
    const fetchImpl = (async () => jsonResponse({ wipe: true })) as unknown as typeof fetch;
    expect(await isRemoteWipeRequested({ url: BASE, deviceId: "d1", fetchImpl })).toBe(true);
  });

  it("returns false when the server does not flag the device", async () => {
    const fetchImpl = (async () => jsonResponse({ wipe: false })) as unknown as typeof fetch;
    expect(await isRemoteWipeRequested({ url: BASE, deviceId: "d1", fetchImpl })).toBe(false);
  });

  it("passes the deviceId and auth header through", async () => {
    let seenUrl = "";
    let seenAuth: string | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return jsonResponse({ wipe: false });
    }) as unknown as typeof fetch;

    await isRemoteWipeRequested({ url: BASE, deviceId: "abc123", authHeader: "Bearer t", fetchImpl });
    expect(seenUrl).toContain("deviceId=abc123");
    expect(seenAuth).toBe("Bearer t");
  });

  it("fails safe (false) on a non-OK response", async () => {
    const fetchImpl = (async () => jsonResponse({ wipe: true }, false)) as unknown as typeof fetch;
    expect(await isRemoteWipeRequested({ url: BASE, deviceId: "d1", fetchImpl })).toBe(false);
  });

  it("fails safe (false) on a network error", async () => {
    const fetchImpl = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await isRemoteWipeRequested({ url: BASE, deviceId: "d1", fetchImpl })).toBe(false);
  });

  it("fails safe (false) on an unparseable body", async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => { throw new Error("bad json"); } })) as unknown as typeof fetch;
    expect(await isRemoteWipeRequested({ url: BASE, deviceId: "d1", fetchImpl })).toBe(false);
  });
});
