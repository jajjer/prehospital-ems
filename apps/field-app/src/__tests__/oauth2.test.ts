/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setRefreshToken,
  getRefreshToken,
  getAuthHeader,
  clearTokens,
} from "@prehospital-ems/sync-engine";
import {
  refreshAccessToken,
  computeRefreshDelay,
  scheduleProactiveRefresh,
  stopProactiveRefresh,
} from "../oauth2.js";

/** A successful OpenMRS token-endpoint response. */
function tokenResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

describe("oauth2 silent refresh", () => {
  beforeEach(async () => {
    stopProactiveRefresh();
    await clearTokens();
  });

  afterEach(() => {
    stopProactiveRefresh();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("exchanges the stored refresh token for a fresh access token", async () => {
    await setRefreshToken("refresh-abc", Date.now() + 60_000);
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: "new-access", refresh_token: "refresh-def", expires_in: 300 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = await refreshAccessToken();

    expect(auth).toBe("Bearer new-access");
    expect(getAuthHeader()).toBe("Bearer new-access");
    // Rotated refresh token is kept for the next refresh.
    expect(getRefreshToken()).toBe("refresh-def");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-abc");
  });

  it("keeps the existing refresh token when the endpoint omits a rotated one", async () => {
    await setRefreshToken("refresh-keep", Date.now() + 60_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      tokenResponse({ access_token: "rotated-access", expires_in: 300 }),
    ));

    await refreshAccessToken();

    expect(getRefreshToken()).toBe("refresh-keep");
  });

  it("returns null and clears the refresh token when the server rejects it", async () => {
    await setRefreshToken("refresh-stale", Date.now() + 60_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      { ok: false, status: 400, json: () => Promise.resolve({}) } as Response,
    ));

    const auth = await refreshAccessToken();

    expect(auth).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it("returns null without a network call when there is no refresh token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await refreshAccessToken()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("computeRefreshDelay refreshes a minute early and clamps at zero", () => {
    expect(computeRefreshDelay(100_000, 0)).toBe(40_000); // 100s out, 60s skew
    expect(computeRefreshDelay(1_000, 0)).toBe(0); // would be negative → clamp
  });

  it("scheduleProactiveRefresh fires a silent refresh before expiry", async () => {
    // Expiry within the 60s skew window → delay clamps to 0 → refreshes on the
    // next tick (real timers, so fake-indexeddb persistence still resolves).
    await setRefreshToken("refresh-proactive", Date.now() + 1_000);
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: "proactive-access", expires_in: 300 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await new Promise<string>((resolve) => {
      scheduleProactiveRefresh(resolve);
    });

    expect(refreshed).toBe("Bearer proactive-access");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
