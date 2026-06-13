// In dev without VITE_OPENMRS_BASE_URL set, use a relative path so the
// Vite dev server proxy handles it (avoids CORS). In production, set
// VITE_OPENMRS_BASE_URL to the absolute OpenMRS URL.
export const OPENMRS_BASE =
  (import.meta.env.VITE_OPENMRS_BASE_URL as string | undefined) ?? "/openmrs";

export const FHIR_BASE = `${OPENMRS_BASE}/ws/fhir2/R4`;
export const REST_BASE = `${OPENMRS_BASE}/ws/rest/v1`;
