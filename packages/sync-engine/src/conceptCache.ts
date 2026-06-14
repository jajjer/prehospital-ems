/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { db, type ConceptCacheEntry } from "./db.js";

// OpenMRS convention for CIEL-sourced concepts: pad CIEL numeric ID with 'A's to 36 chars.
function cielUuid(cielId: number): string {
  const id = String(cielId);
  return id + "A".repeat(36 - id.length);
}

// Static bundle — offline fallback for first launch. Covers the 7 vitals the
// field app already captures plus common EMS additions (pain, glucose, GCS
// components, pupils). cachedAt=0 marks these as not yet confirmed from the API.
const STATIC_BUNDLE: ConceptCacheEntry[] = [
  { uuid: cielUuid(5087),   cielId: "5087",   display: "Pulse",                              unit: "/min",    cachedAt: 0 },
  { uuid: cielUuid(5242),   cielId: "5242",   display: "Respiratory rate",                   unit: "/min",    cachedAt: 0 },
  { uuid: cielUuid(5085),   cielId: "5085",   display: "Systolic blood pressure",            unit: "mm[Hg]",  cachedAt: 0 },
  { uuid: cielUuid(5086),   cielId: "5086",   display: "Diastolic blood pressure",           unit: "mm[Hg]",  cachedAt: 0 },
  { uuid: cielUuid(5088),   cielId: "5088",   display: "Temperature (C)",                    unit: "Cel",     cachedAt: 0 },
  { uuid: cielUuid(5092),   cielId: "5092",   display: "Arterial blood oxygen saturation",   unit: "%",       cachedAt: 0 },
  { uuid: cielUuid(162643), cielId: "162643", display: "Glasgow coma score",                 unit: "{score}", cachedAt: 0 },
  { uuid: cielUuid(166),    cielId: "166",    display: "Pain (numeric)",                     unit: "{score}", cachedAt: 0 },
  { uuid: cielUuid(887),    cielId: "887",    display: "Serum glucose",                      unit: "mg/dL",   cachedAt: 0 },
  { uuid: cielUuid(162600), cielId: "162600", display: "Glasgow coma score, eye opening",    unit: "{score}", cachedAt: 0 },
  { uuid: cielUuid(162602), cielId: "162602", display: "Glasgow coma score, verbal",         unit: "{score}", cachedAt: 0 },
  { uuid: cielUuid(162598), cielId: "162598", display: "Glasgow coma score, motor",          unit: "{score}", cachedAt: 0 },
  { uuid: cielUuid(162702), cielId: "162702", display: "Pupils equal and reactive to light", cachedAt: 0 },
];

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * Ensure the concepts table is populated. Writes the static bundle immediately
 * for offline first-launch, then refreshes from the OpenMRS REST API (throttled
 * to once per 24h). Safe to call on every login — no-ops if data is fresh.
 */
export async function seedConcepts(restBaseUrl: string, authHeader: string): Promise<void> {
  // Seed static bundle if the table is empty
  const count = await db.concepts.count();
  if (count === 0) {
    await db.concepts.bulkPut(STATIC_BUNDLE);
  }

  // Use the first entry as a freshness sentinel
  const sentinelUuid = STATIC_BUNDLE[0]!.uuid;
  const sentinel = await db.concepts.get(sentinelUuid);
  if (sentinel && sentinel.cachedAt > 0 && Date.now() - sentinel.cachedAt < REFRESH_INTERVAL_MS) return;

  // Refresh from REST API — silently skips any concepts not in this OpenMRS instance's dictionary
  const now = Date.now();
  for (const entry of STATIC_BUNDLE) {
    try {
      const res = await fetch(
        `${restBaseUrl}/concept/${entry.uuid}?v=custom:(uuid,display,units)`,
        { headers: { Authorization: authHeader } }
      );
      if (!res.ok) continue;
      const data = await res.json() as { uuid?: string; display?: string; units?: string };
      if (data.uuid && data.display) {
        const unit = data.units ?? entry.unit;
        await db.concepts.put({
          ...entry,
          display: data.display,
          cachedAt: now,
          ...(unit !== undefined ? { unit } : {}),
        });
      }
    } catch {
      // Offline or concept absent — keep existing entry
    }
  }
}

/** Look up a concept by its OpenMRS UUID. Returns undefined if not in the bundle. */
export async function getConceptByUUID(uuid: string): Promise<ConceptCacheEntry | undefined> {
  return db.concepts.get(uuid);
}

/** Look up a concept by CIEL numeric ID. Returns undefined if not in the bundle. */
export async function getConceptByCielId(cielId: string): Promise<ConceptCacheEntry | undefined> {
  return db.concepts.where("cielId").equals(cielId).first();
}
