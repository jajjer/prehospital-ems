/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
/**
 * Runtime configuration for the dispatch console (issue #14).
 *
 * Like the field app, the deployment-specific values are resolved at runtime so
 * one build serves many facilities. Resolution layers, lowest precedence first:
 *   1. Built-in defaults below.
 *   2. Build-time `VITE_` env (back-compat).
 *   3. A `/config.json` fetched from the app origin on boot — editable
 *      post-build (no rebuild) per deployment.
 *
 * The named exports are **live bindings** reassigned by `applyConfig()`; consumers
 * read them inside functions/components, so they observe the resolved values once
 * `loadRuntimeConfig()` has run (awaited in main.tsx before the first render).
 */

export interface DispatchConfig {
  openmrsBaseUrl: string;
  /** Optional fleet sync-health endpoint. When unset, the Fleet Health tab shows a hint. */
  syncTelemetryUrl?: string;
  /** RapidPro outbound SMS — all four must be set to enable "Alert responders". */
  rapidproApiUrl?: string;
  rapidproToken?: string;
  rapidproFlowUuid?: string;
  rapidproGroupUuid?: string;
  /** MapLibre tile style URL. */
  mapStyleUrl: string;
  /** Default map center [lng, lat]. */
  mapCenter: [number, number];
}

export const DEFAULT_CONFIG: DispatchConfig = {
  openmrsBaseUrl: "/openmrs",
  // OpenFreeMap Liberty — free, no API key required.
  mapStyleUrl: "https://tiles.openfreemap.org/styles/liberty",
  // Nairobi, Kenya.
  mapCenter: [36.8219, -1.2921],
};

const CONFIG_JSON_URL = "/config.json";
const CACHE_KEY = "ems_dispatch_config_cache";

function buildTimeOverrides(): Partial<DispatchConfig> {
  const env = import.meta.env;
  const out: Partial<DispatchConfig> = {};
  if (env.VITE_OPENMRS_BASE_URL) out.openmrsBaseUrl = env.VITE_OPENMRS_BASE_URL as string;
  if (env.VITE_SYNC_TELEMETRY_URL) out.syncTelemetryUrl = env.VITE_SYNC_TELEMETRY_URL as string;
  if (env.VITE_RAPIDPRO_API_URL) out.rapidproApiUrl = env.VITE_RAPIDPRO_API_URL as string;
  if (env.VITE_RAPIDPRO_TOKEN) out.rapidproToken = env.VITE_RAPIDPRO_TOKEN as string;
  if (env.VITE_RAPIDPRO_FLOW_UUID) out.rapidproFlowUuid = env.VITE_RAPIDPRO_FLOW_UUID as string;
  if (env.VITE_RAPIDPRO_GROUP_UUID) out.rapidproGroupUuid = env.VITE_RAPIDPRO_GROUP_UUID as string;
  if (env.VITE_MAP_STYLE_URL) out.mapStyleUrl = env.VITE_MAP_STYLE_URL as string;
  const lng = parseFloat(env.VITE_MAP_CENTER_LNG as string);
  const lat = parseFloat(env.VITE_MAP_CENTER_LAT as string);
  if (Number.isFinite(lng) && Number.isFinite(lat)) out.mapCenter = [lng, lat];
  return out;
}

const STRING_KEYS = [
  "openmrsBaseUrl",
  "syncTelemetryUrl",
  "rapidproApiUrl",
  "rapidproToken",
  "rapidproFlowUuid",
  "rapidproGroupUuid",
  "mapStyleUrl",
] as const;

/** Coerce parsed JSON into a clean partial config so malformed input can't crash boot. */
export function sanitizeConfig(raw: unknown): Partial<DispatchConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<DispatchConfig> = {};
  for (const k of STRING_KEYS) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  if (
    Array.isArray(r.mapCenter) && r.mapCenter.length === 2 &&
    typeof r.mapCenter[0] === "number" && typeof r.mapCenter[1] === "number"
  ) {
    out.mapCenter = [r.mapCenter[0], r.mapCenter[1]];
  }
  return out;
}

function readCache(): Partial<DispatchConfig> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return sanitizeConfig(JSON.parse(raw));
  } catch {
    return {};
  }
}

function resolve(...layers: Partial<DispatchConfig>[]): DispatchConfig {
  return Object.assign({}, DEFAULT_CONFIG, ...layers);
}

// ── Live bindings ──────────────────────────────────────────────────────────
export let config: DispatchConfig = DEFAULT_CONFIG;
export let OPENMRS_BASE = DEFAULT_CONFIG.openmrsBaseUrl;
export let FHIR_BASE = `${OPENMRS_BASE}/ws/fhir2/R4`;
export let REST_BASE = `${OPENMRS_BASE}/ws/rest/v1`;
export let SYNC_TELEMETRY_URL: string | undefined = DEFAULT_CONFIG.syncTelemetryUrl;
export let RAPIDPRO_API_URL: string | undefined = DEFAULT_CONFIG.rapidproApiUrl;
export let RAPIDPRO_TOKEN: string | undefined = DEFAULT_CONFIG.rapidproToken;
export let RAPIDPRO_FLOW_UUID: string | undefined = DEFAULT_CONFIG.rapidproFlowUuid;
export let RAPIDPRO_GROUP_UUID: string | undefined = DEFAULT_CONFIG.rapidproGroupUuid;
export let RAPIDPRO_ENABLED = false;
export let MAP_STYLE_URL = DEFAULT_CONFIG.mapStyleUrl;
export let MAP_CENTER: [number, number] = DEFAULT_CONFIG.mapCenter;

function applyConfig(c: DispatchConfig): void {
  const base = c.openmrsBaseUrl.replace(/\/+$/, "");
  config = { ...c, openmrsBaseUrl: base };
  OPENMRS_BASE = base;
  FHIR_BASE = `${base}/ws/fhir2/R4`;
  REST_BASE = `${base}/ws/rest/v1`;
  SYNC_TELEMETRY_URL = c.syncTelemetryUrl;
  RAPIDPRO_API_URL = c.rapidproApiUrl;
  RAPIDPRO_TOKEN = c.rapidproToken;
  RAPIDPRO_FLOW_UUID = c.rapidproFlowUuid;
  RAPIDPRO_GROUP_UUID = c.rapidproGroupUuid;
  RAPIDPRO_ENABLED = !!(c.rapidproApiUrl && c.rapidproToken && c.rapidproFlowUuid && c.rapidproGroupUuid);
  MAP_STYLE_URL = c.mapStyleUrl;
  MAP_CENTER = c.mapCenter;
}

function recompute(fetched?: Partial<DispatchConfig>): DispatchConfig {
  const cached = fetched ?? readCache();
  applyConfig(resolve(buildTimeOverrides(), cached));
  return config;
}

// Apply synchronously from cached layers so the module is usable before
// loadRuntimeConfig resolves (and in tests).
recompute();

/** Fetch and overlay `/config.json`. Call once on boot before rendering. */
export async function loadRuntimeConfig(): Promise<DispatchConfig> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    const res = await fetch(CONFIG_JSON_URL, { cache: "no-cache", signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`config.json ${res.status}`);
    const fetched = sanitizeConfig(await res.json());
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(fetched)); } catch { /* quota */ }
    return recompute(fetched);
  } catch {
    return config;
  }
}
