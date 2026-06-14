# OpenMRS Talk post draft
# Post at: https://talk.openmrs.org — category "OpenMRS Development"
# Delete this file before submitting a PR to the OpenMRS GitHub organization.

---

**Title:** [Proposal] Offline-first prehospital EMS field capture for OpenMRS

---

## Problem

Prehospital EMS in LMIC settings relies on paper capture because paramedics operate in vehicles with intermittent or no mobile connectivity. The result: the receiving hospital sees no prehospital data in OpenMRS until someone transcribes paper forms, often hours later or not at all. This gap in the care record affects triage, handoff quality, and longitudinal follow-up for high-acuity patients.

## Proposed solution

An offline-first progressive web app (PWA) that runs on budget Android devices (Tecno, Infinix, itel — common in LMIC settings). Paramedics capture patient vitals, chief complaint, sex, and approximate age during transport. Data is stored locally in IndexedDB and synced to OpenMRS automatically when connectivity is restored, using the FHIR2 module's R4 endpoint.

No custom OpenMRS module is required. The app integrates via the existing fhir2 REST API.

## Technical approach

**Field app (`apps/field-app`):** React PWA built with Vite. Installable on Android Chrome. A service worker precaches the app shell for full offline capability.

**Sync engine (`packages/sync-engine`):** An IndexedDB write queue (Dexie) holds FHIR resources until they can be POSTed. On reconnect, a flush loop processes items in dependency order (Patient → Encounter → Observation/Condition). Provisional patient IDs are replaced with server-assigned UUIDs via an identity map before each POST. Failed items retry with exponential backoff (8 attempts, max 10 min delay); permanent 4xx errors are moved to a dead-letter table visible in the app's Records screen. Background Sync (Chrome `SyncManager`) fires the flush when the app is backgrounded; a `visibilitychange` listener serves as fallback for OEM battery-kill on budget devices.

**FHIR contracts (`packages/fhir-contracts`):** Typed builders for FHIR R4 Patient, Encounter, Observation, and Condition resources. CIEL concept codes are used for vitals observations alongside LOINC codes for downstream interoperability.

**FHIR resource mapping:**

| Clinical concept | FHIR resource | Notes |
|---|---|---|
| Patient | `Patient` | Provisional MRN, "Old Identification Number" identifier type |
| Encounter | `Encounter` | Class `EMER`, "Facility Visit" type |
| Vitals (HR, RR, BP, SpO₂, temp, GCS) | `Observation` | CIEL + LOINC coding |
| Chief complaint | `Condition` | Category `encounter-diagnosis` |

## Target deployments

Sub-Saharan Africa LMIC EMS systems where:
- Paramedics carry budget Android phones (Android 10–12)
- Connectivity is intermittent (2G/3G in rural transit, offline in dead zones)
- An OpenMRS 3.x Reference Application instance exists at the receiving hospital

## Open questions for the community

1. **GCS concept UUID:** The GCS Total concept (CIEL 162643) requires manual creation in OpenMRS if the full CIEL dictionary is not loaded. Is there a standard recommended approach for deployments that don't load the full CIEL dictionary? Should we ship a startup script that creates the concept if absent?

2. **Identifier type:** We use "Old Identification Number" (no Luhn validator) for provisional MRNs so arbitrary `PROV-{uuid8}` strings are accepted. Is there a more appropriate identifier type for provisional/prehospital identifiers in the OpenMRS data model?

3. **Encounter status:** The encounter is created with status `in-progress` and should be updated to `finished` with a `period.end` timestamp on patient handoff. Does fhir2 support PATCH for Encounter status, or must we PUT the full resource?

4. **Location:** We default to the "Outpatient Clinic" location UUID from the reference app. What is the recommended pattern for multi-facility deployments where the receiving location is unknown at capture time?

## Repository

https://github.com/openmrs/openmrs-ems-prehospital

## License

MPL 2.0, following the OpenMRS contribution guidelines.

---
*This post is required before submitting a PR to the OpenMRS GitHub organization per the OpenMRS governance process. Feedback welcome, especially on the open questions above.*
