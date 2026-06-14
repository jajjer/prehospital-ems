# TODOS

## From /plan-eng-review — 2026-06-11

### TODO-1: Battery optimization detection + prompt (M2)
**What:** On first launch, detect if Chrome is battery-optimized on Android (heuristic: check if SyncManager.getTags() is consistently empty after a flush attempt) and prompt the responder to whitelist Chrome in battery settings.
**Why:** Budget Android OEMs (Tecno, Infinix, itel) aggressively kill Background Sync. Without detection, a misconfigured device silently fails to sync in the background.
**Pros:** Eliminates a silent deployment failure; user gets an actionable prompt instead of discovering the issue from a missing chart in OpenMRS.
**Cons:** Battery API is deprecated; heuristic detection adds complexity. Best deferred until field pilots surface actual deployment patterns.
**Context:** D10 in the eng review. The design doc now documents the OEM battery optimization caveat. This TODO captures the fuller detection UX for M2.
**Depends on:** D10 documentation fix (already applied). M2 field-app UX milestone.

### ~~TODO-2: Bundle Dexie v2 migration to include concepts table (M2)~~ DONE

---

## Production Blockers — must fix before any field deployment

### ~~BLOCK-1: Handle 401 during sync instead of dead-lettering~~ DONE
### ~~BLOCK-2: Cap chief complaint length to OpenMRS field limit~~ DONE
### ~~BLOCK-3: Prevent duplicate submission on force-close + reopen~~ DONE
### ~~BLOCK-4: Service worker update flow — don't interrupt in-flight captures~~ DONE

### BLOCK-5: Validate on a real budget Android device
**What:** Run the full offline → capture → reconnect → sync flow on a Tecno, Infinix, or itel device running Android 10–12.
**Why:** Emulators don't reproduce OEM battery-kill behavior, IndexedDB storage limits, or Chrome's actual Background Sync scheduler on constrained hardware.
**Fix:** Manual QA session. Specifically verify: PWA installability, offline capture, Background Sync firing on reconnect, visibilitychange fallback when Background Sync is killed, dead-letter UX.

---

## OpenMRS Contribution Requirements — must complete before submitting a PR

### CONTRIB-1: Add MPL 2.0 LICENSE file and source headers
**What:** OpenMRS requires all contributed code to be licensed under MPL 2.0. Every `.ts` / `.tsx` source file needs a license header block.
**Why:** Required by the OpenMRS contribution guidelines without exception.
**Fix:** Add `LICENSE` (MPL 2.0 text) to repo root. Add the standard OpenMRS header comment to each source file in `src/`:
```
/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
```

### CONTRIB-2: Write a README.md
**What:** A README covering: what the project is and why it exists, architecture diagram (field-app → sync-engine → fhir2 → OpenMRS), requirements (OpenMRS 3.x, fhir2 module ≥ 2.x, Chrome/Edge on Android), deployment steps (env vars, HTTPS requirement, location UUID, GCS concept UUID), dev setup (`pnpm install && pnpm dev`), known limitations (CIEL subset, GCS UUID, budget OEM battery behavior).
**Why:** Required for any OpenMRS GitHub project. Reviewers will not engage with a project that has no README.

### CONTRIB-3: Post on OpenMRS Talk before submitting
**What:** OpenMRS requires a design/proposal post on talk.openmrs.org before a new project is submitted to the OpenMRS GitHub organization. Include: problem statement, technical approach, target deployments, FHIR resource mapping, open questions.
**Why:** Community buy-in and early design feedback are required by the OpenMRS governance process. PRs submitted without a Talk post are typically closed.

### CONTRIB-4: Document which OpenMRS + fhir2 versions are supported
**What:** Add a compatibility table to the README specifying which OpenMRS Platform version, Reference Application version, and fhir2 module version the app has been tested against.
**Why:** fhir2 behavior (especially visit-type encounter mapping, identifier location extension, Condition category handling) has changed across versions. OpenMRS reviewers will ask about this.
**Context:** Currently tested against OpenMRS 3 Reference Application (qa tag), fhir2 as bundled. The exact fhir2 module version should be pinned in the README.

### CONTRIB-5: Add CONTRIBUTING.md
**What:** Short document covering: how to set up the dev environment, how to run tests, how to run the Docker stack, PR process, code style.
**Why:** Standard OpenMRS project requirement.

### CONTRIB-6: Fix package.json metadata
**What:** Add `"license": "MPL-2.0"`, `"repository"`, and `"description"` fields to root `package.json` and each package's `package.json`.
**Why:** Required for npm/OpenMRS registry publication and for OSPO license scanning tools used by OpenMRS.

### CONTRIB-7: Pass `tsc --noEmit` with strict mode across all packages
**What:** Verify `pnpm typecheck` exits clean. Add `"strict": true` to `tsconfig.base.json` if not already set.
**Why:** OpenMRS frontend projects require TypeScript strict mode. Reviewers will run the typecheck as part of their review.

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
**What:** If two paramedics in the same vehicle both capture the same patient (e.g., one capturing vitals, one capturing the complaint), there is no deduplication mechanism — two separate patients are created in OpenMRS.
**Why:** This will happen in real deployments. The current architecture has no concept of a shared "active call" that multiple devices contribute to.
**Note:** Full fix requires the dispatch app (M2). Interim: document the limitation and recommend single-device capture per call until M2.

---

## M2 Features

### M2-1: CIEL concept caching (open question #2)
**What:** Cache a subset of CIEL concepts in the `concepts` Dexie table (v4 migration already prepared) so the field app can validate and display concept names offline.
**Depends on:** Resolution of open question #2 — which CIEL concepts to include in the offline bundle.

### M2-2: Battery optimization detection + prompt (TODO-1 above)

### M2-3: Dispatch app — Postgres, MapLibre, RapidPro
**What:** Implement the `apps/dispatch` stub. A browser-based dispatch console showing active calls on a map, linked to the field captures via the sync engine.
**Note:** Currently a stub. No scope defined beyond the M1 placeholder.

### M2-4: OAuth2 / OIDC authentication
**What:** Replace Basic auth with OpenMRS's OAuth2/OIDC support for deployments that have it configured. Basic auth over HTTPS is acceptable for M1 LMIC deployments where the OpenMRS instance is simple, but larger deployments will require proper token-based auth.
**Why:** Basic auth stores the raw password (base64, not encrypted) in sessionStorage. Token-based auth scopes permissions and supports session revocation.
