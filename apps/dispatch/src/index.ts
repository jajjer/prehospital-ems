/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
// Dispatch sidecar stub — milestone 1 placeholder.
// No Postgres, no MapLibre, no RapidPro until milestone 2.
// See design doc: apps/dispatch is scaffolded as an empty package in M1.

export interface CommsGateway {
  sendAlert(message: string): Promise<void>;
}

console.log("[dispatch] stub running — milestone 2 implementation pending");
