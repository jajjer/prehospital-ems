// In dev without VITE_OPENMRS_BASE_URL set, use a relative path so the
// Vite dev server proxy handles it (avoids CORS). In production, set
// VITE_OPENMRS_BASE_URL to the absolute OpenMRS URL.
export const OPENMRS_BASE =
  (import.meta.env.VITE_OPENMRS_BASE_URL as string | undefined) ?? "/openmrs";

export const FHIR_BASE = `${OPENMRS_BASE}/ws/fhir2/R4`;
export const REST_BASE = `${OPENMRS_BASE}/ws/rest/v1`;

// Location UUID for patient identifier and encounter. Defaults to "Outpatient Clinic"
// in the OpenMRS 3 reference application. Set VITE_LOCATION_UUID for other deployments.
export const LOCATION_UUID =
  (import.meta.env.VITE_LOCATION_UUID as string | undefined) ?? "44c3efb0-2583-4c80-a79e-1f756a03c0a1";

// GCS concept UUID. The default was created manually in the reference instance;
// set VITE_GCS_CONCEPT_UUID if the full CIEL dictionary is loaded (CIEL 162643).
export const GCS_CONCEPT_UUID =
  (import.meta.env.VITE_GCS_CONCEPT_UUID as string | undefined) ?? "8a7ff9be-79af-4485-9499-094597f01335";
