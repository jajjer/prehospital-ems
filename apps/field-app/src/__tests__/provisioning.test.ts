/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  enrollDevice,
  refreshDeviceConfig,
  unenrollDevice,
  getEnrollment,
  isEnrolled,
  getFleetIdentity,
} from "../provisioning.js";
import {
  DEFAULT_CONFIG,
  getActiveConfig,
  getProvisionedConfig,
  clearProvisionedConfig,
  setAdminOverrides,
  clearAdminOverrides,
} from "../config.js";
import * as cfg from "../config.js";

/** Minimal in-memory localStorage (the Node test env has none). */
function installLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
  return store;
}

function okJson(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

const DEVICE_ID = "abcdef0123456789";

describe("device provisioning / fleet management (issue #15)", () => {
  beforeEach(() => {
    installLocalStorage();
    unenrollDevice();
    clearProvisionedConfig();
    clearAdminOverrides();
  });
  afterEach(() => {
    unenrollDevice();
    clearProvisionedConfig();
    clearAdminOverrides();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("enrollDevice", () => {
    it("registers the device and applies the pushed config", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(okJson({
        token: "tok-123",
        label: "Medic-7",
        fleetId: "bozeman-fire",
        config: {
          openmrsBaseUrl: "https://fleet.example.org/openmrs",
          locationUuid: "loc-pushed",
          wipeCheckUrl: "https://fleet.example.org/wipe",
          syncTelemetryUrl: "https://fleet.example.org/telemetry",
        },
      }));

      const res = await enrollDevice({
        provisioningUrl: "https://fleet.example.org/provision/",
        enrollmentCode: "CODE-1",
        label: "Medic-7",
        deviceId: DEVICE_ID,
        fetchImpl,
        now: 1_700_000_000_000,
      });

      expect(res.ok).toBe(true);
      // POSTed to /enroll with the device id, code, and label.
      const [calledUrl, init] = fetchImpl.mock.calls[0]!;
      expect(calledUrl).toBe("https://fleet.example.org/provision/enroll");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ deviceId: DEVICE_ID, enrollmentCode: "CODE-1", label: "Medic-7" });

      // The pushed config is now in effect (including the wipe/telemetry endpoints).
      expect(cfg.OPENMRS_BASE).toBe("https://fleet.example.org/openmrs");
      expect(cfg.LOCATION_UUID).toBe("loc-pushed");
      expect(cfg.WIPE_CHECK_URL).toBe("https://fleet.example.org/wipe");
      expect(cfg.SYNC_TELEMETRY_URL).toBe("https://fleet.example.org/telemetry");
      expect(getActiveConfig().deviceLabel).toBe("Medic-7");
      expect(getFleetIdentity()).toEqual({
        deviceLabel: "Medic-7",
        fleetId: "bozeman-fire",
        provisioningUrl: "https://fleet.example.org/provision",
      });

      // Enrollment record persisted (trailing slash trimmed).
      expect(isEnrolled()).toBe(true);
      expect(getEnrollment()).toEqual({
        provisioningUrl: "https://fleet.example.org/provision",
        deviceLabel: "Medic-7",
        fleetId: "bozeman-fire",
        token: "tok-123",
        enrolledAt: 1_700_000_000_000,
      });
    });

    it("enrolls even when the service returns no config body", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(okJson({ label: "Rig-2" }));
      const res = await enrollDevice({ provisioningUrl: "https://f.org", deviceId: DEVICE_ID, fetchImpl });
      expect(res.ok).toBe(true);
      expect(isEnrolled()).toBe(true);
      // Only the identity fields land in the provisioned layer; facility config
      // falls through to defaults.
      expect(getProvisionedConfig()).toEqual({ provisioningUrl: "https://f.org", deviceLabel: "Rig-2" });
      expect(cfg.LOCATION_UUID).toBe(DEFAULT_CONFIG.locationUuid);
    });

    it("rejects a blank provisioning URL without a network call", async () => {
      const fetchImpl = vi.fn();
      const res = await enrollDevice({ provisioningUrl: "   ", deviceId: DEVICE_ID, fetchImpl });
      expect(res.ok).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(isEnrolled()).toBe(false);
    });

    it("surfaces a rejected enrollment code (403) and stays unenrolled", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(okJson({}, 403));
      const res = await enrollDevice({ provisioningUrl: "https://f.org", deviceId: DEVICE_ID, fetchImpl });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/enrollment code/i);
      expect(isEnrolled()).toBe(false);
      expect(getProvisionedConfig()).toEqual({});
    });

    it("fails safe on a network error, leaving config untouched", async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
      const res = await enrollDevice({ provisioningUrl: "https://f.org", deviceId: DEVICE_ID, fetchImpl });
      expect(res.ok).toBe(false);
      expect(isEnrolled()).toBe(false);
      expect(cfg.LOCATION_UUID).toBe(DEFAULT_CONFIG.locationUuid);
    });
  });

  describe("layer precedence", () => {
    it("admin overrides win over the fleet-pushed config", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(okJson({ config: { locationUuid: "loc-fleet" } }));
      await enrollDevice({ provisioningUrl: "https://f.org", deviceId: DEVICE_ID, fetchImpl });
      expect(cfg.LOCATION_UUID).toBe("loc-fleet");

      setAdminOverrides({ locationUuid: "loc-admin" });
      expect(cfg.LOCATION_UUID).toBe("loc-admin");

      // Removing the admin override falls back to the fleet-pushed value.
      clearAdminOverrides();
      expect(cfg.LOCATION_UUID).toBe("loc-fleet");
    });
  });

  describe("refreshDeviceConfig (config push)", () => {
    async function enroll(fetchImpl = vi.fn().mockResolvedValue(okJson({ token: "tok", label: "Medic-7", config: { locationUuid: "loc-1" } }))) {
      await enrollDevice({ provisioningUrl: "https://f.org", deviceId: DEVICE_ID, fetchImpl });
    }

    it("pulls and applies fresh config with the bearer token", async () => {
      await enroll();
      expect(cfg.LOCATION_UUID).toBe("loc-1");

      const fetchImpl = vi.fn().mockResolvedValue(okJson({ locationUuid: "loc-2", gcsConceptUuid: "gcs-2" }));
      const ok = await refreshDeviceConfig({ deviceId: DEVICE_ID, fetchImpl });
      expect(ok).toBe(true);

      const [calledUrl, init] = fetchImpl.mock.calls[0]!;
      expect(calledUrl).toBe(`https://f.org/config?deviceId=${DEVICE_ID}`);
      expect(init.headers.Authorization).toBe("Bearer tok");
      expect(cfg.LOCATION_UUID).toBe("loc-2");
      expect(cfg.GCS_CONCEPT_UUID).toBe("gcs-2");
      // The label from enrollment is preserved across a refresh.
      expect(getActiveConfig().deviceLabel).toBe("Medic-7");
    });

    it("is a no-op that keeps cached config when offline", async () => {
      await enroll();
      expect(cfg.LOCATION_UUID).toBe("loc-1");

      const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
      const ok = await refreshDeviceConfig({ deviceId: DEVICE_ID, fetchImpl });
      expect(ok).toBe(false);
      // The last-known provisioned config is still applied.
      expect(cfg.LOCATION_UUID).toBe("loc-1");
    });

    it("returns false and does not fetch when the device is not enrolled", async () => {
      const fetchImpl = vi.fn();
      const ok = await refreshDeviceConfig({ deviceId: DEVICE_ID, fetchImpl });
      expect(ok).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("unenrollDevice", () => {
    it("forgets the enrollment and drops the provisioned layer", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(okJson({ config: { locationUuid: "loc-fleet" } }));
      await enrollDevice({ provisioningUrl: "https://f.org", deviceId: DEVICE_ID, fetchImpl });
      expect(cfg.LOCATION_UUID).toBe("loc-fleet");

      unenrollDevice();
      expect(isEnrolled()).toBe(false);
      expect(getProvisionedConfig()).toEqual({});
      expect(cfg.LOCATION_UUID).toBe(DEFAULT_CONFIG.locationUuid);
    });

    it("leaves admin overrides intact", async () => {
      setAdminOverrides({ locationUuid: "loc-admin" });
      const fetchImpl = vi.fn().mockResolvedValue(okJson({ config: { gcsConceptUuid: "gcs-fleet" } }));
      await enrollDevice({ provisioningUrl: "https://f.org", deviceId: DEVICE_ID, fetchImpl });
      unenrollDevice();
      expect(cfg.LOCATION_UUID).toBe("loc-admin");
    });
  });
});
