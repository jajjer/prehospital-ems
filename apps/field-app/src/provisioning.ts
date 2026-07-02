/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
/**
 * Device provisioning / fleet management (issue #15).
 *
 * A device used to be configured entirely by hand. This adds an **enrollment**
 * flow so a device registers itself with a fleet provisioning service and pulls
 * its configuration, and a **config-push** path so ops can update that config
 * centrally — the device refreshes it on every boot (network-first, cached for
 * offline).
 *
 * It builds directly on runtime configuration (issue #14): the config the server
 * hands back becomes a resolution layer (`setProvisionedConfig`) that sits above
 * the deployment's `/config.json` and below on-device admin overrides. So a
 * managed device gets its OpenMRS base, location/concept UUIDs — and crucially
 * its remote-wipe and sync-telemetry endpoints — pushed from one place, while a
 * paramedic can still re-point a single device by hand in an emergency.
 *
 * Identity tie-in: enrollment registers the **same** opaque `deviceId` that fleet
 * sync-health telemetry (issue #10) and remote wipe (issue #2) already use, plus
 * a human label, so the dashboard and the wipe console can show "Medic-7" next to
 * the otherwise-opaque id.
 *
 * Server contract (deliberately minimal, like remote wipe / telemetry — any
 * backend can implement it):
 *
 *   POST {provisioningUrl}/enroll
 *     body → { deviceId, enrollmentCode?, label? }
 *     200  ← { token?, label?, fleetId?, config? }   // config = Partial<RuntimeConfig>
 *
 *   GET  {provisioningUrl}/config?deviceId=…          // Authorization: Bearer <token>
 *     200  ← Partial<RuntimeConfig>
 *
 * Both are optional; an unmanaged deployment simply never enrolls.
 */
import {
  sanitizeConfig,
  setProvisionedConfig,
  clearProvisionedConfig,
  getActiveConfig,
  type RuntimeConfig,
} from "./config.js";

/** localStorage key for this device's enrollment record. */
const ENROLLMENT_KEY = "ems_device_enrollment";
/** Provisioning requests must not hang boot — bound them like the config fetch. */
const REQUEST_TIMEOUT_MS = 8_000;

/** What this device remembers about the fleet it enrolled with. */
export interface Enrollment {
  /** Base URL of the provisioning service this device is enrolled with. */
  provisioningUrl: string;
  /** Human-readable device name (e.g. "Medic-7"). */
  deviceLabel?: string;
  /** Fleet / agency grouping. */
  fleetId?: string;
  /** Bearer token returned by the service, sent on later config pulls. */
  token?: string;
  /** When this device enrolled (Unix ms). */
  enrolledAt: number;
}

export interface EnrollOptions {
  /** Base URL of the provisioning service (trailing slashes are trimmed). */
  provisioningUrl: string;
  /** One-time code the admin enters, if the service gates enrollment. */
  enrollmentCode?: string;
  /** Human-readable name to request for this device. */
  label?: string;
  /** This device's opaque id (sync-engine `getDeviceId`) — the enrollment key
   *  that also addresses the device for telemetry and remote wipe. */
  deviceId: string;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. Defaults to `Date.now()`. */
  now?: number;
}

export interface EnrollResult {
  ok: boolean;
  /** Human-readable failure reason, present only when `ok` is false. */
  error?: string;
  /** The provisioned config layer that was applied, present only when `ok`. */
  config?: Partial<RuntimeConfig>;
}

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** The persisted enrollment record, or null if this device isn't enrolled. */
export function getEnrollment(): Enrollment | null {
  try {
    const raw = localStorage.getItem(ENROLLMENT_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.provisioningUrl !== "string" || !p.provisioningUrl) return null;
    const e: Enrollment = {
      provisioningUrl: p.provisioningUrl,
      enrolledAt: typeof p.enrolledAt === "number" ? p.enrolledAt : 0,
    };
    if (typeof p.deviceLabel === "string") e.deviceLabel = p.deviceLabel;
    if (typeof p.fleetId === "string") e.fleetId = p.fleetId;
    if (typeof p.token === "string") e.token = p.token;
    return e;
  } catch {
    return null;
  }
}

/** Whether this device is enrolled with a fleet provisioning service. */
export function isEnrolled(): boolean {
  return getEnrollment() !== null;
}

function persistEnrollment(e: Enrollment): void {
  try { localStorage.setItem(ENROLLMENT_KEY, JSON.stringify(e)); } catch { /* quota */ }
}

async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Merge the service's config with the enrollment identity fields into the layer
 *  that {@link setProvisionedConfig} persists. Identity fields are pinned from
 *  the enrollment so a device never silently loses its label on a config refresh. */
function toProvisionedLayer(
  rawConfig: unknown,
  identity: { provisioningUrl: string; deviceLabel?: string; fleetId?: string },
): Partial<RuntimeConfig> {
  const provisioned = sanitizeConfig(rawConfig ?? {});
  provisioned.provisioningUrl = identity.provisioningUrl;
  if (identity.deviceLabel) provisioned.deviceLabel = identity.deviceLabel;
  if (identity.fleetId) provisioned.fleetId = identity.fleetId;
  return provisioned;
}

/**
 * Enroll this device with a fleet provisioning service: register its opaque id
 * (plus an optional label / enrollment code) and apply the configuration the
 * service returns. On success the device is persisted as enrolled and its config
 * layer updates immediately — no reload needed.
 *
 * Fail-safe: any network error, non-OK response, or malformed body resolves to
 * `{ ok: false, error }` and leaves any existing enrollment/config untouched —
 * enrollment never throws.
 */
export async function enrollDevice(opts: EnrollOptions): Promise<EnrollResult> {
  const base = trimBase(opts.provisioningUrl);
  if (!base) return { ok: false, error: "Enter a provisioning URL." };
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? Date.now();

  const body: Record<string, string> = { deviceId: opts.deviceId };
  if (opts.enrollmentCode?.trim()) body.enrollmentCode = opts.enrollmentCode.trim();
  if (opts.label?.trim()) body.label = opts.label.trim();

  let res: Response;
  try {
    res = await fetchWithTimeout(doFetch, `${base}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "Could not reach the provisioning service. Check the URL and network." };
  }
  if (!res.ok) {
    const rejected = res.status === 401 || res.status === 403;
    return {
      ok: false,
      error: rejected
        ? "Enrollment was rejected — check the enrollment code."
        : `Provisioning service returned ${res.status}.`,
    };
  }

  let payload: { token?: unknown; label?: unknown; fleetId?: unknown; config?: unknown };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    return { ok: false, error: "Provisioning service returned an invalid response." };
  }

  const label = typeof payload.label === "string" && payload.label.trim()
    ? payload.label.trim()
    : opts.label?.trim();
  const fleetId = typeof payload.fleetId === "string" && payload.fleetId.trim()
    ? payload.fleetId.trim()
    : undefined;
  const token = typeof payload.token === "string" ? payload.token : undefined;

  const identity: { provisioningUrl: string; deviceLabel?: string; fleetId?: string } = {
    provisioningUrl: base,
  };
  if (label) identity.deviceLabel = label;
  if (fleetId) identity.fleetId = fleetId;

  const provisioned = toProvisionedLayer(payload.config, identity);
  setProvisionedConfig(provisioned);

  const enrollment: Enrollment = { provisioningUrl: base, enrolledAt: now };
  if (label) enrollment.deviceLabel = label;
  if (fleetId) enrollment.fleetId = fleetId;
  if (token) enrollment.token = token;
  persistEnrollment(enrollment);

  return { ok: true, config: provisioned };
}

export interface RefreshOptions {
  /** This device's opaque id (sync-engine `getDeviceId`). */
  deviceId: string;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Pull the latest config for this device from the provisioning service and apply
 * it — the fleet config-push path. Call on boot. Network-first: offline or on any
 * error it's a no-op and the cached provisioned layer already applied at module
 * load stays in effect, so a managed device still boots with its last-known
 * config. Returns true only when fresh config was fetched and applied.
 */
export async function refreshDeviceConfig(opts: RefreshOptions): Promise<boolean> {
  const enrollment = getEnrollment();
  if (!enrollment) return false;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const base = trimBase(enrollment.provisioningUrl);
  const url = new URL(`${base}/config`, globalThis.location?.href);
  url.searchParams.set("deviceId", opts.deviceId);

  try {
    const init: RequestInit = { cache: "no-cache" };
    if (enrollment.token) init.headers = { Authorization: `Bearer ${enrollment.token}` };
    const res = await fetchWithTimeout(doFetch, url.toString(), init);
    if (!res.ok) return false;
    const identity: { provisioningUrl: string; deviceLabel?: string; fleetId?: string } = { provisioningUrl: base };
    if (enrollment.deviceLabel) identity.deviceLabel = enrollment.deviceLabel;
    if (enrollment.fleetId) identity.fleetId = enrollment.fleetId;
    setProvisionedConfig(toProvisionedLayer(await res.json(), identity));
    return true;
  } catch {
    return false;
  }
}

/** Forget this device's enrollment and drop the fleet-provisioned config layer,
 *  falling back to `/config.json` / build-time / defaults. Admin overrides (if
 *  any) are left untouched. */
export function unenrollDevice(): void {
  try { localStorage.removeItem(ENROLLMENT_KEY); } catch { /* ignore */ }
  clearProvisionedConfig();
}

/** The fleet identity currently in effect (label / fleet / provisioning URL),
 *  read from the fully-resolved config. */
export function getFleetIdentity(): { deviceLabel?: string; fleetId?: string; provisioningUrl?: string } {
  const c = getActiveConfig();
  const out: { deviceLabel?: string; fleetId?: string; provisioningUrl?: string } = {};
  if (c.deviceLabel) out.deviceLabel = c.deviceLabel;
  if (c.fleetId) out.fleetId = c.fleetId;
  if (c.provisioningUrl) out.provisioningUrl = c.provisioningUrl;
  return out;
}
