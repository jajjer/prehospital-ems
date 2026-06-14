# TODOS

## LMIC Hardening — important for real-world field deployment

### LMIC-5: Multi-responder deduplication
**What:** If two paramedics in the same vehicle both capture the same patient, there is no deduplication mechanism — two separate patients are created in OpenMRS.
**Why:** This will happen in real deployments. The current architecture has no concept of a shared "active call" that multiple devices contribute to.
**Note:** Full fix requires the dispatch app (M2). Interim: document the limitation and recommend single-device capture per call until M2.

---

## M2 Features

### ~~M2-1: CIEL concept caching~~ DONE

### ~~M2-3: Dispatch app — MapLibre, RapidPro~~ DONE

### ~~M2-4: OAuth2 / OIDC authentication~~ DONE
