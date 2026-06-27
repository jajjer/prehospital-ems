/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  sanitizeConfig,
  getActiveConfig,
  getAdminOverrides,
  setAdminOverrides,
  clearAdminOverrides,
  loadRuntimeConfig,
} from "../config.js";
import * as cfg from "../config.js";

/** Minimal in-memory localStorage so the override/cache layers are exercised
 *  (the Node test env has none; config.ts guards with try/catch). */
function installLocalStorage() {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
  vi.stubGlobal("localStorage", ls);
  return store;
}

describe("runtime config (issue #14)", () => {
  beforeEach(() => {
    installLocalStorage();
    clearAdminOverrides();
  });
  afterEach(() => {
    clearAdminOverrides();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("sanitizeConfig", () => {
    it("keeps known string keys and trims them", () => {
      expect(sanitizeConfig({ openmrsBaseUrl: "  https://a.org/openmrs  " }))
        .toEqual({ openmrsBaseUrl: "https://a.org/openmrs" });
    });

    it("ignores unknown keys and wrong types", () => {
      expect(sanitizeConfig({ bogus: 1, locationUuid: 42, idleLockMinutes: "10" })).toEqual({});
    });

    it("accepts a positive idleLockMinutes only", () => {
      expect(sanitizeConfig({ idleLockMinutes: 7 })).toEqual({ idleLockMinutes: 7 });
      expect(sanitizeConfig({ idleLockMinutes: 0 })).toEqual({});
      expect(sanitizeConfig({ idleLockMinutes: -3 })).toEqual({});
    });

    it("filters receivingLocations to well-formed entries", () => {
      const out = sanitizeConfig({
        receivingLocations: [
          { uuid: "u1", name: "Kenyatta" },
          { uuid: 5, name: "bad" },
          { name: "no-uuid" },
          "nope",
        ],
      });
      expect(out.receivingLocations).toEqual([{ uuid: "u1", name: "Kenyatta" }]);
    });

    it("returns empty for non-objects", () => {
      expect(sanitizeConfig(null)).toEqual({});
      expect(sanitizeConfig("x")).toEqual({});
    });
  });

  describe("admin overrides", () => {
    it("defaults are active with no overrides", () => {
      expect(getActiveConfig().locationUuid).toBe(DEFAULT_CONFIG.locationUuid);
      expect(cfg.FHIR_BASE).toBe(`${DEFAULT_CONFIG.openmrsBaseUrl}/ws/fhir2/R4`);
    });

    it("override the base URL and the derived FHIR/REST bases update (live bindings)", () => {
      setAdminOverrides({ openmrsBaseUrl: "https://facility-a.org/openmrs/" });
      // trailing slash is trimmed before deriving the FHIR/REST paths
      expect(cfg.OPENMRS_BASE).toBe("https://facility-a.org/openmrs");
      expect(cfg.FHIR_BASE).toBe("https://facility-a.org/openmrs/ws/fhir2/R4");
      expect(cfg.REST_BASE).toBe("https://facility-a.org/openmrs/ws/rest/v1");
    });

    it("override per-facility UUIDs and idle lock", () => {
      setAdminOverrides({ locationUuid: "loc-123", gcsConceptUuid: "gcs-456", idleLockMinutes: 12 });
      expect(cfg.LOCATION_UUID).toBe("loc-123");
      expect(cfg.GCS_CONCEPT_UUID).toBe("gcs-456");
      expect(cfg.IDLE_LOCK_MS).toBe(12 * 60_000);
    });

    it("persists overrides so they survive a reload", () => {
      setAdminOverrides({ locationUuid: "loc-persist" });
      expect(getAdminOverrides()).toEqual({ locationUuid: "loc-persist" });
    });

    it("clearAdminOverrides falls back to defaults", () => {
      setAdminOverrides({ locationUuid: "loc-temp" });
      expect(cfg.LOCATION_UUID).toBe("loc-temp");
      clearAdminOverrides();
      expect(cfg.LOCATION_UUID).toBe(DEFAULT_CONFIG.locationUuid);
      expect(getAdminOverrides()).toEqual({});
    });
  });

  describe("loadRuntimeConfig", () => {
    it("overlays a fetched config.json onto the defaults", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ locationUuid: "loc-from-json", gcsConceptUuid: "gcs-from-json" }),
      }));
      const resolved = await loadRuntimeConfig();
      expect(resolved.locationUuid).toBe("loc-from-json");
      expect(cfg.GCS_CONCEPT_UUID).toBe("gcs-from-json");
    });

    it("admin overrides win over config.json", async () => {
      setAdminOverrides({ locationUuid: "loc-admin" });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ locationUuid: "loc-from-json" }),
      }));
      await loadRuntimeConfig();
      expect(cfg.LOCATION_UUID).toBe("loc-admin");
    });

    it("falls back to the cached config when the fetch fails (offline)", async () => {
      // First load caches a good config.json…
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ locationUuid: "loc-cached" }),
      }));
      await loadRuntimeConfig();
      expect(cfg.LOCATION_UUID).toBe("loc-cached");

      // …then a later (offline) boot whose fetch rejects keeps the cached value.
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      const resolved = await loadRuntimeConfig();
      expect(resolved.locationUuid).toBe("loc-cached");
    });

    it("ignores a malformed config.json without crashing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve("not an object"),
      }));
      const resolved = await loadRuntimeConfig();
      expect(resolved.locationUuid).toBe(DEFAULT_CONFIG.locationUuid);
    });
  });
});
