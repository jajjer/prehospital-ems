/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import type { SyncHealthSnapshot } from "@prehospital-ems/sync-engine";

/**
 * Fetch the latest per-device sync-health snapshots from the telemetry endpoint.
 *
 * Field devices POST snapshots to this same URL (see sync-engine reportSyncHealth);
 * the collector is expected to keep the most recent snapshot per device and return
 * them on GET. The contract is deliberately loose so any backend can implement it:
 * either a bare array of snapshots or `{ devices: [...] }` is accepted.
 */
export async function fetchFleetHealth(
  url: string,
  authHeader: string,
): Promise<SyncHealthSnapshot[]> {
  const res = await fetch(url, { headers: { Authorization: authHeader } });
  if (!res.ok) throw new Error(`Telemetry ${res.status}`);
  const data = (await res.json()) as SyncHealthSnapshot[] | { devices?: SyncHealthSnapshot[] };
  return Array.isArray(data) ? data : (data.devices ?? []);
}
