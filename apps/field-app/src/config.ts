export const OPENMRS_BASE =
  (import.meta.env.VITE_OPENMRS_BASE_URL as string | undefined) ??
  "http://localhost:8069/openmrs";

export const FHIR_BASE = `${OPENMRS_BASE}/ws/fhir2/R4`;
export const REST_BASE = `${OPENMRS_BASE}/ws/rest/v1`;
