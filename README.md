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

## FHIR Resource Mapping

| Clinical concept | FHIR resource | Notes |
|---|---|---|
| Patient | `Patient` | Provisional MRN (`PROV-{uuid8}`), "Old Identification Number" type (no Luhn validator). Name set to `Unknown Patient` until confirmed at hospital. |
| Encounter | `Encounter` | Class `EMER`, type "Facility Visit" via `fhir.openmrs.org/code-system/visit-type`. Status `in-progress`. |
| Heart rate, resp. rate, BP, SpO₂, temp | `Observation` | CIEL codes via `https://cielterminology.org` + LOINC for interoperability. |
| GCS total | `Observation` | CIEL 162643. UUID may differ per deployment (see `VITE_GCS_CONCEPT_UUID`). |
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

All configuration is via Vite environment variables (prefix `VITE_`). Set them in `.env.local` for development or in your deployment environment for production.

| Variable | Default | Description |
|---|---|---|
| `VITE_OPENMRS_BASE_URL` | `/openmrs` (proxied) | Absolute URL to your OpenMRS instance, e.g. `https://openmrs.example.org/openmrs` |
| `VITE_LOCATION_UUID` | `44c3efb0-2583-4c80-a79e-1f756a03c0a1` | UUID of the OpenMRS location to associate with patients and encounters. Default is "Outpatient Clinic" in the reference app. |
| `VITE_GCS_CONCEPT_UUID` | `8a7ff9be-79af-4485-9499-094597f01335` | UUID of the GCS Total concept. The default was created manually in the reference instance. If you load the full CIEL dictionary, use the CIEL 162643 UUID from your instance. |

In production, `VITE_OPENMRS_BASE_URL` must point to an HTTPS endpoint. The field app uses Basic auth over HTTPS; OAuth2/OIDC is a milestone 2 target.

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

1. Set environment variables in your CI/hosting environment (see [Configuration](#configuration)).
2. Build the field app:
   ```sh
   cd apps/field-app
   pnpm build
   # Output in apps/field-app/dist — serve as a static site
   ```
3. Serve `dist/` over HTTPS. Any static host works (nginx, Caddy, S3 + CloudFront).
4. The app must be served from the same origin as OpenMRS, or CORS must be configured on the OpenMRS backend to allow the field-app origin.

## Known Limitations

- **GCS UUID is deployment-specific.** The default UUID (`8a7ff9be-...`) was created manually in the reference instance. Deployments with the full CIEL dictionary must set `VITE_GCS_CONCEPT_UUID` to the CIEL 162643 UUID from their instance.
- **Basic auth only.** Credentials are stored in `sessionStorage` for the life of the browser tab. OAuth2/OIDC is a milestone 2 target.
- **Budget OEM battery optimization.** Background Sync is killed on Tecno, Infinix, and itel devices without manual whitelisting in Android battery settings. The `visibilitychange` fallback mitigates this but does not eliminate it. Detection and user prompt for battery whitelisting is a milestone 2 feature.
- **Single-device capture only.** No multi-responder deduplication in milestone 1. If two paramedics capture the same patient independently, two separate OpenMRS patients are created.
- **CIEL concept subset.** Offline concept validation and display name lookup are not yet implemented. Milestone 2 will cache a CIEL subset in IndexedDB.

## License

Mozilla Public License 2.0 — see [LICENSE](LICENSE).

This project also follows the [OpenMRS Healthcare Disclaimer](http://openmrs.org/license).
