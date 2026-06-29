/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadRuntimeConfig } from "./config.js";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

// Resolve the per-deployment runtime config (issue #14) before the first render
// so the OpenMRS base URL, telemetry endpoint, RapidPro creds, and map settings
// are correct. Falls back to the cached/build-time config if the fetch fails.
void loadRuntimeConfig().finally(() => {
  createRoot(root).render(<StrictMode><App /></StrictMode>);
});
