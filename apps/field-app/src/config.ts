/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
/**
 * Runtime configuration (issue #14).
 *
 * The deployment-specific values — the OpenMRS base URL and the per-facility
 * location / concept UUIDs — used to be baked at build time via `VITE_` env
 * vars, so every facility needed its own build. They are now resolved at
 * **runtime** so one build serves many facilities.
 *
 * Resolution layers, lowest precedence first:
 *   1. Built-in defaults (the reference-app values below).
 *   2. Build-time `VITE_` env (back-compat — existing single-facility builds
 *      keep working unchanged).
 *   3. A `/config.json` fetched from the app origin on boot. Editable
 *      post-build (no rebuild) and precached/cached for offline — this is the
 *      per-facility deployment knob.
 *   4. A per-device config pushed from the fleet provisioning service the device
 *      enrolled with (issue #15), cached for offline. This is the central
 *      fleet-management knob: ops update one device's config server-side and it
 *      pulls the change on the next boot. See {@link ./provisioning}.
 *   5. Admin-entered overrides typed into the in-app Settings screen and
 *      persisted to localStorage on the device. Highest precedence so a single
 *      device can still be re-pointed by hand in the field, even when managed.
 *
 * The resolved config is applied synchronously at module load from the cached
 * layers (so the module is usable before `loadRuntimeConfig()` resolves and in
 * tests), then `loadRuntimeConfig()` overlays the freshly-fetched `/config.json`
 * before React renders. The named exports below are **live bindings**: consumers
 * that read them inside functions/components observe the resolved values.
 */

export interface RuntimeConfig {
  /** Absolute URL to OpenMRS, or a same-origin path proxied to it (default). */
  openmrsBaseUrl: string;
  /** Location associated with patients and encounters at capture time — the
   *  EMS service / dispatch origin, NOT the receiving facility (which is
   *  typically unknown when the crew first captures). */
  locationUuid: string;
  /** UUID of the GCS Total concept (CIEL 162643 — deployment-specific). */
  gcsConceptUuid: string;
  /** Minutes of inactivity before the app re-locks. */
  idleLockMinutes: number;
  /** Optional admin endpoint for remote wipe. When unset, remote wipe is off. */
  wipeCheckUrl?: string;
  /** Optional fleet sync-health endpoint. When unset, telemetry is off. */
  syncTelemetryUrl?: string;
  /** Candidate receiving facilities, offered when the destination becomes known
   *  (at handoff). Optional and may be empty — capture never blocks on it, since
   *  the receiving location is frequently unknown at capture time. */
  receivingLocations: { uuid: string; name: string }[];
  /** Base URL of the fleet provisioning service this device enrolled with (issue
   *  #15). Optional — unset means the device is unmanaged and configured by hand.
   *  May be seeded via `config.json` to bootstrap enrollment for a deployment. */
  provisioningUrl?: string;
  /** Human-readable device name assigned at enrollment (e.g. "Medic-7"). Shown in
   *  the fleet sync-health dashboard and remote-wipe console next to the opaque
   *  `deviceId`, tying the managed identity to the telemetry/wipe address. */
  deviceLabel?: string;
  /** Fleet / agency this device belongs to, for grouping in fleet management. */
  fleetId?: string;
}

/** Built-in defaults — the OpenMRS 3 reference-application values. */
export const DEFAULT_CONFIG: RuntimeConfig = {
  // In dev without an override, a relative path lets the Vite dev-server proxy
  // handle OpenMRS (avoids CORS). In production, point this at your instance —
  // ideally a same-origin reverse proxy so the strict CSP needs no changes.
  openmrsBaseUrl: "/openmrs",
  // "Outpatient Clinic" in the reference app.
  locationUuid: "44c3efb0-2583-4c80-a79e-1f756a03c0a1",
  // Created manually in the reference instance; override if the full CIEL
  // dictionary is loaded (CIEL 162643).
  gcsConceptUuid: "8a7ff9be-79af-4485-9499-094597f01335",
  idleLockMinutes: 5,
  receivingLocations: [],
};

/** Keys of {@link RuntimeConfig} an admin may override locally / via config.json. */
const STRING_KEYS = [
  "openmrsBaseUrl",
  "locationUuid",
  "gcsConceptUuid",
  "wipeCheckUrl",
  "syncTelemetryUrl",
  "provisioningUrl",
  "deviceLabel",
  "fleetId",
] as const;

const CONFIG_JSON_URL = "/config.json";
// localStorage keys. The cache lets the device boot offline with the last good
// config.json; the provisioned layer holds the per-device config pushed by the
// fleet service; overrides hold admin-entered values that win over everything.
const CACHE_KEY = "ems_runtime_config_cache";
const PROVISIONED_KEY = "ems_runtime_config_provisioned";
const OVERRIDES_KEY = "ems_runtime_config_overrides";

/** Build-time `VITE_` env, kept for back-compat with existing single-facility builds. */
function buildTimeOverrides(): Partial<RuntimeConfig> {
  const env = import.meta.env;
  const out: Partial<RuntimeConfig> = {};
  if (env.VITE_OPENMRS_BASE_URL) out.openmrsBaseUrl = env.VITE_OPENMRS_BASE_URL as string;
  if (env.VITE_LOCATION_UUID) out.locationUuid = env.VITE_LOCATION_UUID as string;
  if (env.VITE_GCS_CONCEPT_UUID) out.gcsConceptUuid = env.VITE_GCS_CONCEPT_UUID as string;
  if (env.VITE_IDLE_LOCK_MINUTES) out.idleLockMinutes = Number(env.VITE_IDLE_LOCK_MINUTES);
  if (env.VITE_WIPE_CHECK_URL) out.wipeCheckUrl = env.VITE_WIPE_CHECK_URL as string;
  if (env.VITE_SYNC_TELEMETRY_URL) out.syncTelemetryUrl = env.VITE_SYNC_TELEMETRY_URL as string;
  return out;
}

/** Coerce arbitrary parsed JSON into a clean partial config — ignore junk keys
 *  and wrong types so a malformed config.json can never crash boot. */
export function sanitizeConfig(raw: unknown): Partial<RuntimeConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<RuntimeConfig> = {};
  for (const k of STRING_KEYS) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  if (typeof r.idleLockMinutes === "number" && r.idleLockMinutes > 0) {
    out.idleLockMinutes = r.idleLockMinutes;
  }
  if (Array.isArray(r.receivingLocations)) {
    const locs = r.receivingLocations
      .filter((l): l is { uuid: string; name: string } =>
        !!l && typeof l === "object" &&
        typeof (l as Record<string, unknown>).uuid === "string" &&
        typeof (l as Record<string, unknown>).name === "string")
      .map((l) => ({ uuid: l.uuid, name: l.name }));
    out.receivingLocations = locs;
  }
  return out;
}

function readStored(key: string): Partial<RuntimeConfig> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    return sanitizeConfig(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Merge the layers into a complete config. Later layers win. */
function resolve(...layers: Partial<RuntimeConfig>[]): RuntimeConfig {
  return Object.assign({}, DEFAULT_CONFIG, ...layers);
}

// ── Live bindings ──────────────────────────────────────────────────────────
// Reassigned by applyConfig(). Read inside functions/components (never captured
// at module-init time elsewhere) so they reflect the resolved runtime config.
export let config: RuntimeConfig = DEFAULT_CONFIG;
export let OPENMRS_BASE = DEFAULT_CONFIG.openmrsBaseUrl;
export let FHIR_BASE = `${OPENMRS_BASE}/ws/fhir2/R4`;
export let REST_BASE = `${OPENMRS_BASE}/ws/rest/v1`;
export let LOCATION_UUID = DEFAULT_CONFIG.locationUuid;
export let GCS_CONCEPT_UUID = DEFAULT_CONFIG.gcsConceptUuid;
export let IDLE_LOCK_MS = DEFAULT_CONFIG.idleLockMinutes * 60_000;
export let WIPE_CHECK_URL: string | undefined = DEFAULT_CONFIG.wipeCheckUrl;
export let SYNC_TELEMETRY_URL: string | undefined = DEFAULT_CONFIG.syncTelemetryUrl;
export let RECEIVING_LOCATIONS: { uuid: string; name: string }[] = DEFAULT_CONFIG.receivingLocations;

function applyConfig(c: RuntimeConfig): void {
  // Trim any trailing slash so the derived FHIR/REST paths don't double up.
  const base = c.openmrsBaseUrl.replace(/\/+$/, "");
  config = { ...c, openmrsBaseUrl: base };
  OPENMRS_BASE = base;
  FHIR_BASE = `${base}/ws/fhir2/R4`;
  REST_BASE = `${base}/ws/rest/v1`;
  LOCATION_UUID = c.locationUuid;
  GCS_CONCEPT_UUID = c.gcsConceptUuid;
  IDLE_LOCK_MS = c.idleLockMinutes * 60_000;
  WIPE_CHECK_URL = c.wipeCheckUrl;
  SYNC_TELEMETRY_URL = c.syncTelemetryUrl;
  RECEIVING_LOCATIONS = c.receivingLocations;
}

/** Recompute the resolved config from all currently-known layers and apply it.
 *  `fetched` is the just-loaded /config.json (omitted → use the cached copy). */
function recompute(fetched?: Partial<RuntimeConfig>): RuntimeConfig {
  const cached = fetched ?? readStored(CACHE_KEY);
  const resolved = resolve(
    buildTimeOverrides(),
    cached,
    readStored(PROVISIONED_KEY),
    readStored(OVERRIDES_KEY),
  );
  applyConfig(resolved);
  return config;
}

// Apply synchronously from cached layers so the module is immediately usable
// (before loadRuntimeConfig resolves, and in unit tests that never call it).
recompute();

/**
 * Fetch `/config.json` from the app origin and overlay it. Call once on boot,
 * before rendering. Offline (or when the file is absent) this is a no-op beyond
 * the synchronous cached-layer resolution already applied at module load, so the
 * app still boots with the last-known-good config — that's the offline path.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    const res = await fetch(CONFIG_JSON_URL, {
      cache: "no-cache",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`config.json ${res.status}`);
    const fetched = sanitizeConfig(await res.json());
    // Persist for the next (possibly offline) boot, then apply.
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(fetched)); } catch { /* quota — keep using in-memory */ }
    return recompute(fetched);
  } catch {
    // Offline / missing / malformed → keep the cached-layer config already applied.
    return config;
  }
}

// ── Admin overrides (Settings screen) ────────────────────────────────────────

/** The admin-entered overrides currently persisted on this device. */
export function getAdminOverrides(): Partial<RuntimeConfig> {
  return readStored(OVERRIDES_KEY);
}

/** Persist admin-entered overrides and apply them immediately (live bindings
 *  update in place; a reload isn't required for new captures). */
export function setAdminOverrides(overrides: Partial<RuntimeConfig>): RuntimeConfig {
  const clean = sanitizeConfig(overrides);
  try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(clean)); } catch { /* quota */ }
  return recompute();
}

/** Drop all admin overrides, falling back to provisioned / config.json / build-time / defaults. */
export function clearAdminOverrides(): RuntimeConfig {
  try { localStorage.removeItem(OVERRIDES_KEY); } catch { /* ignore */ }
  return recompute();
}

// ── Fleet-provisioned config (enrollment, issue #15) ─────────────────────────
// The per-device config the fleet provisioning service pushed to this device,
// cached so a managed device boots with its last-known config offline. Sits above
// /config.json (the per-deployment file) and below admin overrides (so a device
// can still be re-pointed by hand). Written by {@link ./provisioning}.

/** The fleet-provisioned config layer currently cached on this device. */
export function getProvisionedConfig(): Partial<RuntimeConfig> {
  return readStored(PROVISIONED_KEY);
}

/** Replace the fleet-provisioned layer and apply it immediately (live bindings
 *  update in place — no reload needed). */
export function setProvisionedConfig(provisioned: Partial<RuntimeConfig>): RuntimeConfig {
  const clean = sanitizeConfig(provisioned);
  try { localStorage.setItem(PROVISIONED_KEY, JSON.stringify(clean)); } catch { /* quota */ }
  return recompute();
}

/** Drop the fleet-provisioned layer (e.g. on un-enrollment), falling back to
 *  config.json / build-time / defaults. Admin overrides are left untouched. */
export function clearProvisionedConfig(): RuntimeConfig {
  try { localStorage.removeItem(PROVISIONED_KEY); } catch { /* ignore */ }
  return recompute();
}

/** The fully-resolved active config (snapshot). */
export function getActiveConfig(): RuntimeConfig {
  return config;
}
