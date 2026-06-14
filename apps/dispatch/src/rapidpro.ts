/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { RAPIDPRO_API_URL, RAPIDPRO_TOKEN, RAPIDPRO_FLOW_UUID, RAPIDPRO_GROUP_UUID } from "./config.js";

export interface AlertPayload {
  encounterId: string;
  mrn: string;
  gender: string;
  startTime: string;
}

/**
 * Trigger a RapidPro flow for the configured responder group.
 * Passes encounter details as flow extra variables so the flow template
 * can include them in the outbound SMS.
 */
export async function sendAlert(payload: AlertPayload): Promise<void> {
  if (!RAPIDPRO_API_URL || !RAPIDPRO_TOKEN || !RAPIDPRO_FLOW_UUID || !RAPIDPRO_GROUP_UUID) {
    throw new Error("RapidPro not configured");
  }

  const res = await fetch(`${RAPIDPRO_API_URL}/api/v2/flow_starts.json`, {
    method: "POST",
    headers: {
      "Authorization": `Token ${RAPIDPRO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      flow: RAPIDPRO_FLOW_UUID,
      groups: [RAPIDPRO_GROUP_UUID],
      restart_participants: true,
      extra: {
        encounter_id: payload.encounterId,
        patient_mrn:  payload.mrn,
        gender:       payload.gender,
        start_time:   new Date(payload.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`RapidPro ${res.status}: ${body}`);
  }
}
