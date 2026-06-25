/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
export { db } from "./db.js";
export type { WriteQueueItem, DeadLetterItem, IdentityMapEntry, CaptureLogEntry, ConceptCacheEntry } from "./db.js";
export { initSyncWorker, flush, enqueue, finalizeEncounter } from "./syncWorker.js";
export type { SyncWorkerConfig, FinalizeResult } from "./syncWorker.js";
export { backoffDelay, shouldDeadLetter, BACKOFF } from "./backoff.js";
export { logCapture, getRecentCaptures, markCaptureComplete, getPendingCapture, getCaptureStatus, retryDeadLettered, pruneOldCaptures, addVitalsSet, vitalsSeries } from "./captureLog.js";
export type { CaptureStatus, VitalsTimePoint } from "./captureLog.js";
export { seedConcepts, getConceptByUUID, getConceptByCielId } from "./conceptCache.js";
export { checkActiveCalls } from "./dedup.js";
export type { ActiveCallSummary } from "./dedup.js";
export {
  setEncryptionKey,
  getEncryptionKey,
  lockEncryption,
  isUnlocked,
  getActiveKey,
  deriveKeyFromPassphrase,
  generateDataKey,
  wrapDataKey,
  unwrapDataKey,
  encryptString,
  decryptString,
  encryptField,
  decryptField,
  isEnvelope,
} from "./crypto.js";
export {
  initAppLock,
  isPinSet,
  setupPin,
  unlockWithPin,
  changePin,
  getFailedAttempts,
  lock,
  getDeviceId,
  MIN_PIN_LENGTH,
  MAX_PIN_ATTEMPTS,
} from "./appLock.js";
export type { AppLockState, AppLockMode, UnlockResult } from "./appLock.js";
export {
  getAuthHeader,
  getRefreshToken,
  getTokenExpiry,
  setAuthHeader,
  setRefreshToken,
  reconcileTokenStorage,
  clearTokens,
} from "./tokenStore.js";
export { wipeLocalData } from "./wipe.js";
export { isRemoteWipeRequested } from "./remoteWipe.js";
export type { RemoteWipeOptions } from "./remoteWipe.js";
