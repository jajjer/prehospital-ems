/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { db, type WriteQueueItem } from "./db.js";
import { backoffDelay, shouldDeadLetter, BACKOFF } from "./backoff.js";
import { encryptBody, decryptBody } from "./phiCrypto.js";
import { recordConflict } from "./conflictLog.js";
import { recordSyncSuccess, collectSyncHealth, reportSyncHealth } from "./syncTelemetry.js";
import { getDeviceId } from "./appLock.js";

export interface SyncWorkerConfig {
  /** Base URL for the fhir2 endpoint, e.g. http://localhost:8069/openmrs/ws/fhir2/R4 */
  fhirBaseUrl: string;
  /** Basic auth header value, e.g. "Basic YWRtaW46QWRtaW4xMjM=" */
  authHeader: string;
  /** Optional fleet sync-health telemetry endpoint. When set, a PHI-free health
   *  snapshot is POSTed after every flush so ops can see this device's sync state.
   *  Unset → telemetry is disabled (safe default, no backend required). */
  telemetryUrl?: string;
}

let config: SyncWorkerConfig | null = null;
let flushing = false;
let listenersRegistered = false;
let bgSyncFlushed = false;
let clockChecked = false;

export function initSyncWorker(cfg: SyncWorkerConfig): void {
  config = cfg;
  if (listenersRegistered) return;
  listenersRegistered = true;

  // Foreground flush on navigator.onLine event
  window.addEventListener("online", () => void flush());

  // Foreground flush on tab focus — covers budget Android OEMs where Background Sync
  // is killed by battery optimization (Tecno, Infinix, itel).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine) {
      void flush();
    }
  });

  // Receive FLUSH messages posted by the service worker's Background Sync handler.
  // The SW cannot access Dexie directly, so it delegates back to the window via postMessage.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if ((event.data as { type?: string } | null)?.type === "FLUSH") {
        bgSyncFlushed = true;
        void flush();
      }
    });
  }

  // Register Background Sync for Android Chrome (silently no-ops where unsupported)
  if ("serviceWorker" in navigator && "SyncManager" in window) {
    navigator.serviceWorker.ready
      .then((reg) => {
        // SyncManager is not in the standard DOM lib — cast to access it
        const syncReg = reg as unknown as {
          sync: { register(tag: string): Promise<void>; getTags(): Promise<string[]> };
        };
        return syncReg.sync.register("fhir-flush").then(() => {
          // Heuristic: if the tag disappears after 1.5 s without a SW FLUSH message,
          // Background Sync was likely suppressed by OEM battery optimization.
          setTimeout(() => {
            void syncReg.sync.getTags().then((tags) => {
              if (!bgSyncFlushed && !tags.includes("fhir-flush")) {
                window.dispatchEvent(new CustomEvent("ems:bg-sync-suppressed"));
              }
            }).catch(() => undefined);
          }, 1500);
        });
      })
      .catch(() => {
        // SyncManager.register rejected — not a problem; visibilitychange covers it
      });
  }
}

/** Resource types that depend on a Patient + Encounter and so flush last,
 *  after their references have been resolved via the identity map. */
const DEPENDENT_TYPES: ReadonlySet<WriteQueueItem["resourceType"]> = new Set([
  "Observation",
  "Condition",
  "MedicationAdministration",
  "Procedure",
]);

/** Flush the write queue in order: Patient → Encounter → dependents. */
export async function flush(): Promise<void> {
  if (!config || flushing || !navigator.onLine) return;
  flushing = true;

  try {
    const ordered = await db.writeQueue
      .orderBy("enqueuedAt")
      .toArray();

    // Decrypt PHI bodies after the read completes (outside the IDB transaction).
    for (const item of ordered) {
      item.body = await decryptBody(item.body);
    }

    // Process in order — Patients first, Encounters second, then dependents
    const patients = ordered.filter((i) => i.resourceType === "Patient");
    const encounters = ordered.filter((i) => i.resourceType === "Encounter");
    const dependents = ordered.filter((i) => DEPENDENT_TYPES.has(i.resourceType));

    for (const item of [...patients, ...encounters, ...dependents]) {
      const result = await processItem(item);
      if (result === "abort") break;
    }
  } finally {
    flushing = false;
  }

  // Publish a PHI-free health snapshot after the queue settles (best-effort).
  await reportTelemetry();
}

let deviceIdPromise: Promise<string> | null = null;
function cachedDeviceId(): Promise<string> {
  if (!deviceIdPromise) deviceIdPromise = getDeviceId();
  return deviceIdPromise;
}

/** Emit a fleet sync-health snapshot if a telemetry endpoint is configured.
 *  Never throws — telemetry must not disrupt the sync path. */
async function reportTelemetry(): Promise<void> {
  const telemetryUrl = config?.telemetryUrl;
  if (!telemetryUrl) return;
  try {
    const deviceId = await cachedDeviceId();
    const snapshot = await collectSyncHealth({ deviceId });
    await reportSyncHealth({ url: telemetryUrl, snapshot, authHeader: config!.authHeader });
  } catch {
    /* best-effort */
  }
}

async function processItem(item: WriteQueueItem): Promise<"abort" | undefined> {
  if (!config) return;

  const { fhirBaseUrl, authHeader } = config;

  // Search-before-create for Patient: never POST a duplicate when a record with
  // this identifier already exists server-side. A match means one of two things:
  //   - retryCount > 0: our own prior attempt landed before a force-close / network
  //     drop — idempotent recovery, reconcile silently (no conflict).
  //   - retryCount === 0: we have never POSTed this Patient, so the server copy was
  //     created/edited concurrently by another responder or the receiving facility.
  //     Reconcile to the server UUID (so dependent resources still attach) but record
  //     the conflict and surface it — this device's demographics were NOT applied, and
  //     we never silently overwrite clinical PHI.
  if (item.resourceType === "Patient") {
    const parsed = JSON.parse(item.body) as { identifier?: Array<{ value?: string }> };
    const provisionalId = parsed.identifier?.[0]?.value;
    if (provisionalId) {
      const existing = await searchExistingPatient(provisionalId, fhirBaseUrl, authHeader);
      if (existing) {
        await db.identityMap.put({
          provisionalId,
          serverUUID: existing.id,
          resourceType: "Patient",
          resolvedAt: Date.now(),
        });
        if (item.retryCount === 0) {
          await recordConflict({
            id: item.id,
            resourceType: item.resourceType,
            resourceId: item.resourceId,
            mrn: item.patientId ?? item.resourceId,
            serverUUID: existing.id,
            localEnqueuedAt: item.enqueuedAt,
            serverLastUpdated: existing.lastUpdated,
            localBody: item.body,
          });
        }
        await db.writeQueue.delete(item.id);
        recordSyncSuccess();
        return;
      }
    }
  }

  // Resolve patient/encounter references from identity map before POST
  let body = item.body;
  if (item.resourceType === "Encounter" || DEPENDENT_TYPES.has(item.resourceType)) {
    body = await resolveReferences(body);
  }

  let response: Response;
  try {
    response = await fetch(`${fhirBaseUrl}/${item.resourceType}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/fhir+json",
        "Authorization": authHeader,
      },
      body,
    });
  } catch {
    // Network error — will retry
    await db.writeQueue.update(item.id, { retryCount: item.retryCount + 1 });
    await new Promise((r) => setTimeout(r, backoffDelay(item.retryCount)));
    return;
  }

  if (response.ok) {
    const resource = await response.json() as { id?: string; meta?: { lastUpdated?: string } };
    const serverUUID = resource.id;

    // Clock skew detection — fires once per session on first successful FHIR response
    if (!clockChecked && resource.meta?.lastUpdated) {
      clockChecked = true;
      const skewMs = Math.abs(Date.now() - new Date(resource.meta.lastUpdated).getTime());
      if (skewMs > 5 * 60 * 1000) {
        window.dispatchEvent(
          new CustomEvent("ems:clock-skew", { detail: { skewMinutes: Math.round(skewMs / 60_000) } })
        );
      }
    }

    // Store identity map entry for Patients and Encounters
    if (serverUUID && (item.resourceType === "Patient" || item.resourceType === "Encounter")) {
      const parsed = JSON.parse(item.body) as { identifier?: Array<{ value?: string }>; id?: string };
      const provisionalId = item.resourceType === "Patient"
        ? parsed.identifier?.[0]?.value
        : parsed.id;
      if (provisionalId) {
        await db.identityMap.put({
          provisionalId,
          serverUUID,
          resourceType: item.resourceType,
          resolvedAt: Date.now(),
        });
      }
    }

    // Conflict detection happens before the POST via search-before-create (see the
    // Patient block above): a successful create here means no server copy pre-existed,
    // so there is nothing to conflict with.
    await db.writeQueue.delete(item.id);
    recordSyncSuccess();
    return;
  }

  const statusCode = response.status;

  // Session expired — don't dead-letter. Notify the app to prompt re-auth,
  // then abort the flush so remaining items aren't tried with a stale token.
  if (statusCode === 401) {
    window.dispatchEvent(new CustomEvent("ems:auth-expired"));
    return "abort";
  }

  if (shouldDeadLetter(item.retryCount, statusCode)) {
    await db.deadLetter.put({
      id: item.id,
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      patientId: item.patientId ?? undefined,
      encounterId: item.encounterId ?? undefined,
      statusCode,
      // item.body is plaintext here (decrypted in flush) — re-encrypt at rest.
      body: await encryptBody(item.body),
      failedAt: Date.now(),
    });
    await db.writeQueue.delete(item.id);
    return;
  }

  // Transient 5xx — increment retry and apply backoff
  await db.writeQueue.update(item.id, { retryCount: item.retryCount + 1 });
  await new Promise((r) => setTimeout(r, backoffDelay(item.retryCount)));
}

/** A pre-existing server Patient found by identifier search. */
interface ExistingPatient {
  id: string;
  /** meta.lastUpdated as Unix ms, if the server provided it. */
  lastUpdated: number | undefined;
}

async function searchExistingPatient(
  identifier: string,
  fhirBaseUrl: string,
  authHeader: string
): Promise<ExistingPatient | null> {
  try {
    const res = await fetch(
      `${fhirBaseUrl}/Patient?identifier=${encodeURIComponent(identifier)}`,
      { headers: { Authorization: authHeader } }
    );
    if (!res.ok) return null;
    const bundle = await res.json() as {
      total?: number;
      entry?: Array<{ resource?: { id?: string; meta?: { lastUpdated?: string } } }>;
    };
    if ((bundle.total ?? 0) > 0) {
      const resource = bundle.entry?.[0]?.resource;
      if (!resource?.id) return null;
      const lu = resource.meta?.lastUpdated;
      return { id: resource.id, lastUpdated: lu ? new Date(lu).getTime() : undefined };
    }
    return null;
  } catch {
    return null;
  }
}

/** A FHIR reference field whose value we may need to rewrite, captured during
 *  the resource walk so we can resolve all ids with a single keyed lookup. */
interface RefSite {
  /** The object holding the `reference` property, mutated in place. */
  obj: { reference: string };
  /** Resource type segment of "Type/id" — preserved on rewrite. */
  type: string;
  /** Id segment — looked up against the identity map (its primary key). */
  id: string;
}

/** Collect every `{ reference: "Type/id" }` node in a parsed FHIR resource. */
function collectReferenceSites(node: unknown, sites: RefSite[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectReferenceSites(child, sites);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const obj = node as Record<string, unknown>;
  const ref = obj.reference;
  if (typeof ref === "string") {
    // Only relative references of the form "ResourceType/id" carry provisional
    // ids; absolute URLs and contained "#id" references are left untouched.
    const slash = ref.indexOf("/");
    if (slash > 0 && slash < ref.length - 1 && !ref.includes("://")) {
      sites.push({
        obj: obj as { reference: string },
        type: ref.slice(0, slash),
        id: ref.slice(slash + 1),
      });
    }
  }
  for (const value of Object.values(obj)) collectReferenceSites(value, sites);
}

/**
 * Rewrite provisional ids in a resource's reference fields to their server
 * UUIDs. Parses the FHIR JSON and rewrites only the id segment of each
 * `reference` field via a keyed lookup against the identity map — never a blind
 * `String.replaceAll` over the whole body, which was O(n×m) and could corrupt a
 * value that happened to contain a provisional id as a substring.
 */
async function resolveReferences(body: string): Promise<string> {
  const resource = JSON.parse(body) as unknown;

  const sites: RefSite[] = [];
  collectReferenceSites(resource, sites);
  if (sites.length === 0) return body;

  // One keyed lookup per distinct id (primary key = provisionalId), instead of
  // scanning the whole identity map for every resource.
  const ids = [...new Set(sites.map((s) => s.id))];
  const entries = await db.identityMap.bulkGet(ids);
  const serverById = new Map<string, string>();
  ids.forEach((id, i) => {
    const entry = entries[i];
    if (entry) serverById.set(id, entry.serverUUID);
  });

  let rewrote = false;
  for (const site of sites) {
    const serverUUID = serverById.get(site.id);
    if (serverUUID !== undefined) {
      site.obj.reference = `${site.type}/${serverUUID}`;
      rewrote = true;
    }
  }

  return rewrote ? JSON.stringify(resource) : body;
}

export type FinalizeResult = "ok" | "not-synced" | "network-error" | "server-error";

/**
 * Resolves the MRN of a capture to its server-side FHIR Encounter UUID, or
 * undefined if the encounter hasn't synced yet (still queued / never captured).
 * Joined calls hold the server UUID directly; own captures resolve their
 * provisional ENC id through the identity map once the upload completes. The
 * handoff summary uses this to build the QR deep-link, and finalizeEncounter to
 * target the PATCH — keeping the two on one source of truth.
 */
export async function getServerEncounterId(mrn: string): Promise<string | undefined> {
  const captureEntry = await db.captureLog.get(mrn);
  if (!captureEntry?.encounterId) return undefined;
  return captureEntry.joined
    ? captureEntry.encounterId
    : (await db.identityMap.get(captureEntry.encounterId))?.serverUUID;
}

/**
 * PATCHes the FHIR Encounter for this MRN to status "finished" with a period.end timestamp.
 * Returns "not-synced" if the encounter hasn't been uploaded yet (no identity map entry).
 * Requires the app to be online — this is a foreground, user-triggered action.
 */
export async function finalizeEncounter(mrn: string): Promise<FinalizeResult> {
  if (!config) return "not-synced";
  const { fhirBaseUrl, authHeader } = config;

  const serverEncounterId = await getServerEncounterId(mrn);
  if (!serverEncounterId) return "not-synced";

  const patches = [
    { op: "replace", path: "/status", value: "finished" },
    { op: "add", path: "/period/end", value: new Date().toISOString() },
  ];

  let response: Response;
  try {
    response = await fetch(`${fhirBaseUrl}/Encounter/${serverEncounterId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json-patch+json",
        "Authorization": authHeader,
      },
      body: JSON.stringify(patches),
    });
  } catch {
    return "network-error";
  }

  if (!response.ok) return "server-error";

  await db.captureLog.update(mrn, { handoffAt: Date.now() });
  return "ok";
}

/** Enqueue a FHIR resource for sync. The PHI body is encrypted at rest. */
export async function enqueue(
  item: Omit<WriteQueueItem, "enqueuedAt" | "retryCount">
): Promise<void> {
  await db.writeQueue.put({
    ...item,
    body: await encryptBody(item.body),
    enqueuedAt: Date.now(),
    retryCount: 0,
  });
}
