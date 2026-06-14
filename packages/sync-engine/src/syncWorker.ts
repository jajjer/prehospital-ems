/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { db, type WriteQueueItem } from "./db.js";
import { backoffDelay, shouldDeadLetter, BACKOFF } from "./backoff.js";

export interface SyncWorkerConfig {
  /** Base URL for the fhir2 endpoint, e.g. http://localhost:8069/openmrs/ws/fhir2/R4 */
  fhirBaseUrl: string;
  /** Basic auth header value, e.g. "Basic YWRtaW46QWRtaW4xMjM=" */
  authHeader: string;
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

/** Flush the write queue in order: Patient → Encounter → Observation. */
export async function flush(): Promise<void> {
  if (!config || flushing || !navigator.onLine) return;
  flushing = true;

  try {
    const ordered = await db.writeQueue
      .orderBy("enqueuedAt")
      .toArray();

    // Process in order — Patients first, Encounters second, then dependents
    const patients = ordered.filter((i) => i.resourceType === "Patient");
    const encounters = ordered.filter((i) => i.resourceType === "Encounter");
    const dependents = ordered.filter(
      (i) => i.resourceType === "Observation" || i.resourceType === "Condition"
    );

    for (const item of [...patients, ...encounters, ...dependents]) {
      const result = await processItem(item);
      if (result === "abort") break;
    }
  } finally {
    flushing = false;
  }
}

async function processItem(item: WriteQueueItem): Promise<"abort" | undefined> {
  if (!config) return;

  const { fhirBaseUrl, authHeader } = config;

  // On retry, search-before-create for Patient to handle force-close mid-flush
  if (item.resourceType === "Patient" && item.retryCount > 0) {
    const body = JSON.parse(item.body) as { identifier?: Array<{ value?: string }> };
    const provisionalId = body.identifier?.[0]?.value;
    if (provisionalId) {
      const serverUUID = await searchPatientByIdentifier(provisionalId, fhirBaseUrl, authHeader);
      if (serverUUID) {
        await db.identityMap.put({
          provisionalId,
          serverUUID,
          resourceType: "Patient",
          resolvedAt: Date.now(),
        });
        await db.writeQueue.delete(item.id);
        return;
      }
    }
  }

  // Resolve patient/encounter references from identity map before POST
  let body = item.body;
  if (item.resourceType === "Encounter" || item.resourceType === "Observation" || item.resourceType === "Condition") {
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

    // Conflict detection hook (log only in M1)
    const serverLastUpdated = resource.meta?.lastUpdated;
    if (serverLastUpdated && item.enqueuedAt) {
      const serverTs = new Date(serverLastUpdated).getTime();
      if (serverTs > item.enqueuedAt) {
        console.warn("[sync] potential conflict", {
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          localEnqueuedAt: item.enqueuedAt,
          serverLastUpdated,
        });
      }
    }

    await db.writeQueue.delete(item.id);
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
      body: item.body,
      failedAt: Date.now(),
    });
    await db.writeQueue.delete(item.id);
    return;
  }

  // Transient 5xx — increment retry and apply backoff
  await db.writeQueue.update(item.id, { retryCount: item.retryCount + 1 });
  await new Promise((r) => setTimeout(r, backoffDelay(item.retryCount)));
}

async function searchPatientByIdentifier(
  identifier: string,
  fhirBaseUrl: string,
  authHeader: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `${fhirBaseUrl}/Patient?identifier=${encodeURIComponent(identifier)}`,
      { headers: { Authorization: authHeader } }
    );
    if (!res.ok) return null;
    const bundle = await res.json() as { total?: number; entry?: Array<{ resource?: { id?: string } }> };
    if ((bundle.total ?? 0) > 0) {
      return bundle.entry?.[0]?.resource?.id ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveReferences(body: string): Promise<string> {
  const allEntries = await db.identityMap.toArray();
  let resolved = body;
  for (const entry of allEntries) {
    resolved = resolved.replaceAll(entry.provisionalId, entry.serverUUID);
  }
  return resolved;
}

export type FinalizeResult = "ok" | "not-synced" | "network-error" | "server-error";

/**
 * PATCHes the FHIR Encounter for this MRN to status "finished" with a period.end timestamp.
 * Returns "not-synced" if the encounter hasn't been uploaded yet (no identity map entry).
 * Requires the app to be online — this is a foreground, user-triggered action.
 */
export async function finalizeEncounter(mrn: string): Promise<FinalizeResult> {
  if (!config) return "not-synced";
  const { fhirBaseUrl, authHeader } = config;

  const captureEntry = await db.captureLog.get(mrn);
  if (!captureEntry?.encounterId) return "not-synced";

  // Joined calls store the server UUID directly; others require an identityMap lookup.
  const serverEncounterId = captureEntry.joined
    ? captureEntry.encounterId
    : (await db.identityMap.get(captureEntry.encounterId))?.serverUUID;
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

/** Enqueue a FHIR resource for sync. */
export async function enqueue(
  item: Omit<WriteQueueItem, "enqueuedAt" | "retryCount">
): Promise<void> {
  await db.writeQueue.put({
    ...item,
    enqueuedAt: Date.now(),
    retryCount: 0,
  });
}
