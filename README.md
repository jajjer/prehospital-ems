# OpenMRS Prehospital EMS

Offline-first PWA for prehospital emergency medical services (EMS) patient capture in low-resource settings. Paramedics capture patient vitals, chief complaint, and demographics on a budget Android device in the field — without network connectivity. Data syncs automatically to OpenMRS via the FHIR2 module when connectivity is restored.

## Problem

Prehospital EMS in LMIC settings relies on paper capture because Android devices on the way to hospital have intermittent or no connectivity. This creates a gap in the care record: the receiving hospital sees no prehospital data in OpenMRS until someone transcribes paper forms, often hours later or not at all.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Field Device (Android Chrome)                          │
│                                                         │
│  ┌─────────────┐    ┌──────────────────────────────┐   │
│  │  Field App  │───▶│  Sync Engine                 │   │
│  │  (React PWA)│    │  • IndexedDB write queue     │   │
│  └─────────────┘    │  • Background Sync / SW      │   │
│                     │  • visibilitychange fallback  │   │
│                     │  • Exponential backoff        │   │
│                     │  • Dead-letter queue          │   │
│                     └──────────────┬───────────────┘   │
└────────────────────────────────────┼────────────────────┘
                                     │ HTTPS / FHIR R4
                                     ▼
                         ┌──────────────────────┐
                         │  OpenMRS Backend      │
                         │  fhir2 module ≥ 2.x  │
                         │  Reference App 3.x   │
                         └──────────────────────┘
```

**Packages:**

| Package | Description |
|---|---|
| `apps/field-app` | React PWA — login, capture form, records screen, service worker |
| `packages/sync-engine` | IndexedDB (Dexie) write queue, flush loop, identity map, dead-letter handling |
| `packages/fhir-contracts` | FHIR R4 builders (Patient, Encounter, Observation, Condition) and validators |
| `apps/dispatch` | Dispatch console — milestone 2 stub, not yet implemented |

**Offline sync flow:**

1. Paramedic captures patient data on the field app (offline-capable).
2. FHIR resources are written to an IndexedDB write queue immediately.
3. On reconnect, Background Sync fires (`fhir-flush` tag) → service worker notifies the window → flush loop POSTs resources in order: Patient → Encounter → Observations/Conditions.
4. Server-assigned UUIDs are stored in an identity map; provisional IDs in queued resources are rewritten before each POST.
5. 4xx responses dead-letter the item. 5xx retries with exponential backoff (8 attempts, max 10 min delay). 401 aborts the flush and prompts re-auth.

**OEM battery optimization note:** Budget Android OEMs (Tecno, Infinix, itel) aggressively kill Background Sync. The sync engine registers a `visibilitychange` listener as a fallback so the queue flushes when the paramedic returns to the app.

## Patient handoff

The core value is the receiving facility reading what the field team captured. From the **Records** tab, **Hand off patient** opens a clean, printable handoff summary for an encounter: demographics, chief complaint, the full vitals trend (serial sets), GCS with its E/V/M breakdown, interventions/treatments, and the expanded assessment. The sheet renders as a light "document" — `window.print()` isolates it, so it prints or saves to PDF without the dark app chrome.

Each summary carries a **QR code** that deep-links to the FHIR `Encounter` (`{FHIR_BASE}/Encounter/{uuid}`), so the facility can scan straight to the record. The QR is generated entirely on-device (a vendored, dependency-free [Nayuki QR generator](https://www.nayuki.io/page/qr-code-generator-library) rendered to inline SVG) — no external service, which matters for an offline PHI-handling PWA. **Share** hands a plain-text summary (plus the link) to the OS share sheet or clipboard.

**Confirm handoff** finalizes the encounter in OpenMRS — PATCHes status to `finished` and sets `period.end` — and records the local handoff time. It requires connectivity (a foreground, user-triggered action) and reports network/server errors inline. A finalized record stays viewable so the summary can be re-opened or re-printed at the facility.

## Patient reconciliation (MPI matching)

Field captures begin as a provisional `Unknown Patient` with a `PROV-{uuid8}` identifier. When the real identity is established — typically at or after handoff — **Reconcile identity** on a synced record searches the OpenMRS MPI by name and links the record to the confirmed patient. The workflow is lossless and audited:

- **Pre-sync** (the provisional `Patient` is still queued): its POST is dropped so no orphan is ever created, and the provisional id is mapped straight to the confirmed UUID — the `Encounter` and `Observation`s resolve to the confirmed patient on the next flush via the existing identity map.
- **Post-sync** (the provisional `Patient` already reached the server): the `Encounter`'s `subject` is re-pointed to the confirmed patient, then every dependent `Observation`/`Condition`/`Procedure`/`MedicationAdministration` for that encounter is re-pointed too. Future resources (e.g. serial vitals) follow via the updated map.

The provisional identifier is preserved (it stays the record's key), confirmed demographics are never overwritten, and each reconciliation is written to a `reconciliationLog` audit record (the confirmed name encrypted at rest). The Records card and handoff summary then show the confirmed name.

## FHIR Resource Mapping

| Clinical concept | FHIR resource | Notes |
|---|---|---|
| Patient | `Patient` | Provisional MRN (`PROV-{uuid8}`), "Old Identification Number" type (no Luhn validator). Name set to `Unknown Patient` until confirmed at hospital. |
| Encounter | `Encounter` | Class `EMER`, type "Facility Visit" via `fhir.openmrs.org/code-system/visit-type`. Status `in-progress`. |
| Heart rate, resp. rate, BP, SpO₂, temp | `Observation` | CIEL codes via `https://cielterminology.org` + LOINC for interoperability. |
| GCS total | `Observation` | CIEL 162643. UUID may differ per deployment (see `gcsConceptUuid` in [Configuration](#configuration)). |
| Chief complaint | `Condition` | Category `encounter-diagnosis`, clinical status `active`. |

## Requirements

- OpenMRS 3.x Reference Application
- fhir2 module ≥ 2.x (bundled with the Reference Application `qa` tag)
- HTTPS — required for service worker registration and PWA install
- Chrome or Edge on Android (Firefox does not support Background Sync)
- Node.js ≥ 20, pnpm ≥ 10

## Compatibility

| OpenMRS Ref App | fhir2 module | Tested |
|---|---|---|
| 3.x (`qa` tag, Docker) | bundled with backend image | Yes |

The app has been validated against the `qa`-tagged Docker images in `infra/openmrs/docker-compose.yml`. Pinning to a specific Reference Application release is recommended for production. fhir2 behavior (especially visit-type encounter mapping, identifier location extension, and Condition category handling) has changed across versions — test against your target version before deploying.

## Configuration

The deployment-specific values (OpenMRS base URL, per-facility location/concept UUIDs, optional endpoints) are resolved **at runtime**, so **one build serves many facilities** — you no longer need a separate build per facility (issue #14). Configuration resolves through five layers, lowest precedence first:

1. **Built-in defaults** — the OpenMRS 3 reference-application values.
2. **Build-time `VITE_` env** — back-compat; existing single-facility builds keep working unchanged.
3. **`/config.json`** — a static file served from the app origin, read on boot. **Edit it on the host to re-point a deployment without rebuilding.** It is served network-first with a cache fallback, so changes take effect on the next online boot and the last-known-good copy keeps the app working **offline**.
4. **Fleet-provisioned config** — the per-device config a device pulls from the provisioning service it enrolled with (issue #15). This is the central fleet-management knob: update a device's config server-side and it applies on the next boot. Cached for offline. See [Device provisioning](#device-provisioning--fleet-management).
5. **In-app Device settings** — admin-entered overrides typed into the field app's **Settings** tab (also reachable pre-login via the *Device settings* link), persisted on the device. Highest precedence, so a single device can be re-pointed by hand in the field even when managed. Works fully offline.

### `config.json`

Ships at `apps/field-app/public/config.json` (and `apps/dispatch/public/config.json`). Replace it per facility on the host — no rebuild. Unknown keys are ignored; remove a key to fall back to its default.

```json
{
  "openmrsBaseUrl": "/openmrs",
  "locationUuid": "44c3efb0-2583-4c80-a79e-1f756a03c0a1",
  "gcsConceptUuid": "8a7ff9be-79af-4485-9499-094597f01335",
  "idleLockMinutes": 5,
  "receivingLocations": []
}
```

| Key | `VITE_` equivalent | Default | Description |
|---|---|---|---|
| `openmrsBaseUrl` | `VITE_OPENMRS_BASE_URL` | `/openmrs` (proxied) | OpenMRS base URL. A same-origin path (e.g. a reverse-proxy `/openmrs`) is recommended — see the CSP note below. |
| `locationUuid` | `VITE_LOCATION_UUID` | `44c3efb0-…` | Service / capture location for patients and encounters — the EMS origin, **not** the receiving facility. Default is "Outpatient Clinic" in the reference app. |
| `gcsConceptUuid` | `VITE_GCS_CONCEPT_UUID` | `8a7ff9be-…` | GCS Total concept UUID. The default was created manually in the reference instance; with the full CIEL dictionary use the CIEL 162643 UUID from your instance. |
| `idleLockMinutes` | `VITE_IDLE_LOCK_MINUTES` | `5` | Minutes of inactivity before the app re-locks. The offline queue is never dropped on lock. See [SECURITY.md](SECURITY.md#app-lock-session-timeout--remote-wipe). |
| `wipeCheckUrl` | `VITE_WIPE_CHECK_URL` | _(unset)_ | Optional remote-wipe endpoint, GET with a `deviceId` query param; a `{ "wipe": true }` response erases all local data. Unset → disabled. |
| `syncTelemetryUrl` | `VITE_SYNC_TELEMETRY_URL` | _(unset)_ | Optional fleet sync-health endpoint (shared by field app and dispatch). Unset → telemetry disabled and the dashboard shows a hint. See [Fleet sync health](#fleet-sync-health). |
| `receivingLocations` | — | `[]` | Candidate receiving facilities (`{ "uuid", "name" }[]`), selected at handoff. Optional — capture never blocks on a receiving location, since the destination is frequently unknown at capture time (see below). |

**Receiving location unknown at capture time.** The crew often doesn't know which facility will receive the patient when they first capture. Capture therefore uses only the service `locationUuid` and never requires a destination; the receiving facility is a downstream concern selected at handoff, populated from the optional `receivingLocations` list. This resolves one of the OpenMRS Talk open questions.

**CSP note.** The OpenMRS base URL is resolved at runtime, so a cross-origin absolute URL set only via `config.json` / Device settings is **not** in the build-time `connect-src` CSP `<meta>`. The recommended multi-facility deployment puts OpenMRS behind a **same-origin reverse proxy** (base path `/openmrs`), which `'self'` already covers. If a facility instead points at a cross-origin absolute URL, add that origin to `connect-src` via the host/CDN CSP response header (see [SECURITY.md](SECURITY.md)).

In production, the OpenMRS endpoint must be HTTPS. The field app uses Basic auth over HTTPS; OAuth2/OIDC is a milestone 2 target.

### Fleet sync health

A dead-lettered record fails silently on one paramedic's phone, and a device sitting on un-synced records for days is invisible to operations. When `syncTelemetryUrl` is set (in `config.json` or the legacy `VITE_SYNC_TELEMETRY_URL`), each field device publishes its sync health and the dispatch **Fleet health** tab surfaces stuck devices with alert thresholds.

**Snapshot contract (PHI-free — counts and metadata only, never patient content):**

```jsonc
// Field app → POST {syncTelemetryUrl}
{
  "deviceId": "…",              // opaque per-device id, no PHI
  "queueDepth": 3,              // items waiting in the write queue
  "deadLetterCount": 0,         // permanently failed (4xx) items
  "unresolvedConflictCount": 0, // conflicts awaiting human review
  "oldestQueuedAt": 1700000000000,   // Unix ms, or null
  "oldestDeadLetterAt": null,        // Unix ms, or null
  "lastSyncAt": 1700000000000,       // Unix ms, or null if never synced
  "reportedAt": 1700000000000        // when the snapshot was taken
}
```

The collector (deployment-provided, like the remote-wipe backend) keeps the latest snapshot per device and returns them on `GET` as a bare array or `{ "devices": [...] }`. The dispatch dashboard flags a device as **Alert** when it has dead-lettered records, when its oldest unsynced record exceeds one hour, or when it stops checking in while holding pending work; **Warning** when a record has aged past 15 minutes or a conflict is unresolved.

### Device provisioning / fleet management

Without provisioning, every device is configured by hand and there's no way to push a config change across a fleet. Device provisioning (issue #15) adds a self-service **enrollment** flow and a central **config-push** path, built on the runtime-config layers above.

From the field app's **Settings** → *Fleet enrollment* (reachable pre-login, so a brand-new device can be set up before it can even sign in), an admin enters a **provisioning service URL**, an optional **enrollment code**, and an optional **device label**. On enroll, the device registers its opaque `deviceId` and receives back its configuration, which is applied immediately as the fleet-provisioned layer — including its OpenMRS base, location/concept UUIDs, and its `wipeCheckUrl` / `syncTelemetryUrl`, so **remote wipe and sync-health telemetry are wired up centrally instead of typed on each device.** After enrollment, the device pulls its latest config on **every boot** (network-first, cached for offline), so ops can re-point the whole fleet from one place. A device can still be un-enrolled, or re-pointed by hand — admin overrides win over the fleet-pushed config.

**Identity tie-in.** Enrollment registers the **same** opaque `deviceId` that [remote wipe](SECURITY.md#app-lock-session-timeout--remote-wipe) and [fleet sync health](#fleet-sync-health) already key on, alongside a human `label`, so the provisioning service's roster maps `deviceId → "Medic-7"` for the sync-health dashboard and the wipe console — no PHI, and the telemetry snapshot contract is unchanged.

**Server contract** (deliberately minimal — like remote wipe / telemetry, any backend can implement it):

```jsonc
// Enroll a device
POST {provisioningUrl}/enroll
  → { "deviceId": "…", "enrollmentCode": "…", "label": "Medic-7" }
  ← { "token": "…", "label": "Medic-7", "fleetId": "…", "config": { /* Partial runtime config */ } }

// Pull this device's latest config (config push), sent on every boot
GET  {provisioningUrl}/config?deviceId=…      // Authorization: Bearer <token>
  ← { /* Partial runtime config */ }
```

Both endpoints are optional; a deployment that doesn't run a provisioning service simply never enrolls, and per-device config keeps coming from `config.json` and Device settings.

## Dev Setup

**Prerequisites:** Node.js ≥ 20, pnpm ≥ 10, Docker + Docker Compose.

```sh
# Clone and install
git clone https://github.com/openmrs/openmrs-ems-prehospital
cd openmrs-ems-prehospital
pnpm install

# Start OpenMRS (first run takes several minutes to initialize)
docker compose -f infra/openmrs/docker-compose.yml up -d

# Start the field app dev server (proxies /openmrs to localhost:8069)
pnpm dev
# → http://localhost:3000
# Default credentials: admin / Admin123
```

OpenMRS admin UI: http://localhost:8069/openmrs

**Commands:**

```sh
pnpm build       # Build all packages
pnpm typecheck   # TypeScript strict check across all packages
pnpm test        # Run unit + integration tests
pnpm lint        # Lint all packages
```

## Deployment

1. Build the field app **once** — the same artifact serves every facility (see [Configuration](#configuration)):
   ```sh
   cd apps/field-app
   pnpm build
   # Output in apps/field-app/dist — serve as a static site
   ```
2. Serve `dist/` over HTTPS. Any static host works (nginx, Caddy, S3 + CloudFront).
3. **Per facility, edit `dist/config.json`** with that facility's OpenMRS URL and location/concept UUIDs — no rebuild. It is fetched on boot (network-first, cached for offline). A device admin can further override values on-device via the field app's **Settings** tab. Build-time `VITE_` env still works for single-facility deployments that prefer it.
4. The app must be served from the same origin as OpenMRS, or CORS must be configured on the OpenMRS backend to allow the field-app origin. A same-origin reverse proxy (base path `/openmrs`) is recommended so the strict CSP needs no per-facility changes.

## Known Limitations

- **GCS UUID is deployment-specific.** The default UUID (`8a7ff9be-...`) was created manually in the reference instance. Deployments with the full CIEL dictionary must set `gcsConceptUuid` (in `config.json` / Device settings, or the legacy `VITE_GCS_CONCEPT_UUID`) to the CIEL 162643 UUID from their instance.
- **Basic auth only.** Credentials are stored in `sessionStorage` for the life of the browser tab. OAuth2/OIDC is a milestone 2 target.
- **Budget OEM battery optimization.** Background Sync is killed on Tecno, Infinix, and itel devices without manual whitelisting in Android battery settings. The `visibilitychange` fallback mitigates this but does not eliminate it. Detection and user prompt for battery whitelisting is a milestone 2 feature.
- **Single-device capture only.** No multi-responder deduplication in milestone 1. If two paramedics capture the same patient independently, two separate OpenMRS patients are created.
- **CIEL concept subset.** Offline concept validation and display name lookup are not yet implemented. Milestone 2 will cache a CIEL subset in IndexedDB.
- **PHI at-rest encryption is gated on a device key, not yet a user PIN.** Patient data in IndexedDB is encrypted with AES-256-GCM (so a forensic disk dump yields only ciphertext), but until app lock lands the key is a non-extractable device key recoverable by code in the app origin. The PIN-derived key fully closes the unlocked-stolen-device threat. See [SECURITY.md](SECURITY.md) for the threat model and key lifecycle.

## License

Mozilla Public License 2.0 — see [LICENSE](LICENSE).

This project also follows the [OpenMRS Healthcare Disclaimer](http://openmrs.org/license).
