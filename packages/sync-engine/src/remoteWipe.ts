/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */

/**
 * Remote wipe (issue #2).
 *
 * When a device is reported lost, an administrator flags it server-side. On its
 * next launch or sync, the field app asks whether this device has been flagged
 * and, if so, wipes all local data.
 *
 * The server contract is deliberately minimal so any backend can implement it:
 * a GET to a configured URL with a `deviceId` query parameter that returns JSON
 * `{ "wipe": true }` when the device should be wiped. The endpoint is optional;
 * deployments without it simply skip the check.
 */

export interface RemoteWipeOptions {
  /** Endpoint that reports whether a device should be wiped. */
  url: string;
  /** This device's opaque identifier (see appLock.getDeviceId). */
  deviceId: string;
  /** Authorization header to send, if the endpoint requires auth. */
  authHeader?: string;
  /** Injectable fetch for testing. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Ask the server whether this device has been flagged for wipe.
 *
 * Fails safe: any network error, non-OK response, or unparseable body returns
 * `false`. A transient outage must never trigger a destructive wipe — only an
 * explicit `{ wipe: true }` does.
 */
export async function isRemoteWipeRequested(opts: RemoteWipeOptions): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  try {
    const url = new URL(opts.url, globalThis.location?.href);
    url.searchParams.set("deviceId", opts.deviceId);
    const init: RequestInit = {};
    if (opts.authHeader) init.headers = { Authorization: opts.authHeader };
    const res = await doFetch(url.toString(), init);
    if (!res.ok) return false;
    const data = (await res.json()) as { wipe?: unknown };
    return data?.wipe === true;
  } catch {
    return false;
  }
}
