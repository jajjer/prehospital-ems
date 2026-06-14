/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
export const OPENMRS_BASE =
  (import.meta.env.VITE_OPENMRS_BASE_URL as string | undefined) ?? "/openmrs";

export const FHIR_BASE = `${OPENMRS_BASE}/ws/fhir2/R4`;
export const REST_BASE = `${OPENMRS_BASE}/ws/rest/v1`;

// RapidPro outbound SMS — all three must be set to enable the "Alert responders" button.
export const RAPIDPRO_API_URL   = import.meta.env.VITE_RAPIDPRO_API_URL   as string | undefined;
export const RAPIDPRO_TOKEN     = import.meta.env.VITE_RAPIDPRO_TOKEN     as string | undefined;
export const RAPIDPRO_FLOW_UUID = import.meta.env.VITE_RAPIDPRO_FLOW_UUID as string | undefined;
// UUID of the RapidPro contact group to alert (your active-responder group).
export const RAPIDPRO_GROUP_UUID = import.meta.env.VITE_RAPIDPRO_GROUP_UUID as string | undefined;

export const RAPIDPRO_ENABLED =
  !!(RAPIDPRO_API_URL && RAPIDPRO_TOKEN && RAPIDPRO_FLOW_UUID && RAPIDPRO_GROUP_UUID);

// MapLibre tile style. Defaults to OpenFreeMap Liberty (free, no API key required).
// Override with VITE_MAP_STYLE_URL for production tile providers (MapTiler, Stadia, etc).
export const MAP_STYLE_URL =
  (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) ??
  "https://tiles.openfreemap.org/styles/liberty";

// Default map center — defaults to Nairobi, Kenya. Override per deployment.
export const MAP_CENTER: [number, number] = [
  parseFloat(import.meta.env.VITE_MAP_CENTER_LNG as string ?? "36.8219") || 36.8219,
  parseFloat(import.meta.env.VITE_MAP_CENTER_LAT as string ?? "-1.2921") || -1.2921,
];
