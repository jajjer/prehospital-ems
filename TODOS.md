# TODOS

## LMIC Hardening — important for real-world field deployment

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
