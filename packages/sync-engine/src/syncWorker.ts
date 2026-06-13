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

  // Register Background Sync for Android Chrome (silently no-ops where unsupported)
  if ("serviceWorker" in navigator && "SyncManager" in window) {
    navigator.serviceWorker.ready
      .then((reg) => {
        // SyncManager is not in the standard DOM lib — cast to access it
        const syncReg = reg as unknown as { sync: { register(tag: string): Promise<void> } };
        return syncReg.sync.register("fhir-flush");
      })
      .catch(() => {
        // SyncManager.register rejected — not a problem; visibilitychange covers it
      });
  }

  // Receive FLUSH messages posted by the service worker's Background Sync handler.
  // The SW cannot access Dexie directly, so it delegates back to the window via postMessage.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if ((event.data as { type?: string } | null)?.type === "FLUSH") {
        void flush();
      }
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
      await processItem(item);
    }
  } finally {
    flushing = false;
  }
}

async function processItem(item: WriteQueueItem): Promise<void> {
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
