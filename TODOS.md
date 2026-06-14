# TODOS

## General

### TODO-1 / M2-2: Battery optimization detection + prompt (M2)
**What:** On first launch, detect if Chrome is battery-optimized on Android (heuristic: check if SyncManager.getTags() is consistently empty after a flush attempt) and prompt the responder to whitelist Chrome in battery settings.
**Why:** Budget Android OEMs (Tecno, Infinix, itel) aggressively kill Background Sync. Without detection, a misconfigured device silently fails to sync in the background.
**Cons:** Battery API is deprecated; heuristic detection adds complexity. Best deferred until field pilots surface actual deployment patterns.

---

## Production Blockers — must fix before any field deployment

### BLOCK-5: Validate on a real budget Android device
**What:** Run the full offline → capture → reconnect → sync flow on a Tecno, Infinix, or itel device running Android 10–12.
**Why:** Emulators don't reproduce OEM battery-kill behavior, IndexedDB storage limits, or Chrome's actual Background Sync scheduler on constrained hardware.
**Fix:** Manual QA session. Specifically verify: PWA installability, offline capture, Background Sync firing on reconnect, visibilitychange fallback when Background Sync is killed, dead-letter UX.

---

## OpenMRS Contribution Requirements — must complete before submitting a PR

### CONTRIB-3: Post on OpenMRS Talk — DRAFT READY (see TALK_POST_DRAFT.md)
**What:** Post at talk.openmrs.org. Include: problem statement, technical approach, target deployments, FHIR resource mapping, open questions.
**Why:** Community buy-in and early design feedback are required by the OpenMRS governance process. PRs submitted without a Talk post are typically closed.

---

## LMIC Hardening — important for real-world field deployment

### LMIC-1: Clock skew detection and warning
**What:** Detect if the device clock is more than ~5 minutes off from the server (`meta.lastUpdated` on the first successful FHIR response vs. `Date.now()`). Warn the responder to fix the device time.
**Why:** LMIC Android devices frequently have wrong system clocks, especially after battery-out events. `effectiveDateTime` on vitals observations would be wrong, making the chart clinically misleading.

### LMIC-2: IndexedDB storage quota warning
**What:** Use `navigator.storage.estimate()` on app load to check available storage. Warn if usage exceeds 80% of quota.
**Why:** Budget Android phones often have very limited storage (8–16 GB shared with the OS). If the device is offline for multiple days, the writeQueue could grow large enough to exhaust IndexedDB quota, causing silent write failures.

### LMIC-3: CaptureLog retention policy
**What:** Automatically prune `captureLog` entries older than 30 days (or a configurable window). Dead-letter and writeQueue entries for resolved MRNs should also be cleaned up after successful sync.
**Why:** Without pruning, IndexedDB grows unboundedly. On a shared device used for months, this will eventually hit the storage quota (LMIC-2).

### LMIC-4: Encounter finalization — mark "finished" on handoff
**What:** Add a "Hand off patient" action in the field app that PATCHes the FHIR Encounter status from `in-progress` to `finished` with a period.end timestamp.
**Why:** OpenMRS displays encounter status in the patient chart. An encounter that remains `in-progress` indefinitely is clinically misleading. Receiving hospital staff need to see a clear handoff time.
**Depends on:** Requires the identity map to have resolved the encounter UUID before the action can be taken.

### LMIC-5: Multi-responder deduplication
**What:** If two paramedics in the same vehicle both capture the same patient, there is no deduplication mechanism — two separate patients are created in OpenMRS.
**Why:** This will happen in real deployments. The current architecture has no concept of a shared "active call" that multiple devices contribute to.
**Note:** Full fix requires the dispatch app (M2). Interim: document the limitation and recommend single-device capture per call until M2.

---

## M2 Features

### M2-1: CIEL concept caching
**What:** Cache a subset of CIEL concepts in the `concepts` Dexie table (v4 migration already prepared) so the field app can validate and display concept names offline.
**Depends on:** Resolution of open question #2 — which CIEL concepts to include in the offline bundle.

### M2-3: Dispatch app — Postgres, MapLibre, RapidPro
**What:** Implement the `apps/dispatch` stub. A browser-based dispatch console showing active calls on a map, linked to the field captures via the sync engine.
**Note:** Currently a stub. No scope defined beyond the M1 placeholder.

### M2-4: OAuth2 / OIDC authentication
**What:** Replace Basic auth with OpenMRS's OAuth2/OIDC support for deployments that have it configured. Basic auth over HTTPS is acceptable for M1 LMIC deployments where the OpenMRS instance is simple, but larger deployments will require proper token-based auth.
**Why:** Basic auth stores the raw password (base64, not encrypted) in sessionStorage. Token-based auth scopes permissions and supports session revocation.
