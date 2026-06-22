/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import "fake-indexeddb/auto";
import { setEncryptionKey, deriveKeyFromPassphrase } from "../crypto.js";

// The encryption middleware blocks all database reads/writes until a key is
// installed. Provide a deterministic test key so every suite can use the DB.
const TEST_SALT = new Uint8Array(16); // fixed salt — deterministic in tests
setEncryptionKey(await deriveKeyFromPassphrase("test-passphrase", TEST_SALT));
