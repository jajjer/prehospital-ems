/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
export { db } from "./db.js";
export type { WriteQueueItem, DeadLetterItem, IdentityMapEntry, CaptureLogEntry, ConceptCacheEntry, ConflictLogEntry, ReconciliationLogEntry, AmendmentLogEntry } from "./db.js";
export { initSyncWorker, flush, enqueue, finalizeEncounter, getServerEncounterId } from "./syncWorker.js";
export type { SyncWorkerConfig, FinalizeResult } from "./syncWorker.js";
export { backoffDelay, shouldDeadLetter, BACKOFF } from "./backoff.js";
export { logCapture, getRecentCaptures, markCaptureComplete, getPendingCapture, getCaptureStatus, retryDeadLettered, pruneOldCaptures, addVitalsSet, vitalsSeries, amendInitialVitals } from "./captureLog.js";
export type { CaptureStatus, VitalsTimePoint } from "./captureLog.js";
export { recordConflict, getUnresolvedConflicts, getUnresolvedConflictCount, getConflictsForMrn, resolveConflict } from "./conflictLog.js";
export type { ConflictResolution, ConflictInput } from "./conflictLog.js";
export { recordAmendment, getAmendmentsForMrn } from "./amendmentLog.js";
export type { AmendmentInput } from "./amendmentLog.js";
export { getCurrentUser, setCurrentUser, reconcileIdentity, clearIdentity, captureIdentity } from "./identity.js";
export type { UserIdentity } from "./identity.js";
export { searchPatientsByMpi, reconcilePatient, getReconciliation } from "./reconciliation.js";
export type { MpiCandidate, ReconcileResult, ReconcileOptions } from "./reconciliation.js";
export {
  evaluateSyncHealth,
  collectSyncHealth,
  reportSyncHealth,
  recordSyncSuccess,
  getLastSyncAt,
  DEFAULT_SYNC_THRESHOLDS,
} from "./syncTelemetry.js";
export type {
  SyncHealthSnapshot,
  SyncSeverity,
  SyncHealthThresholds,
  SyncHealthEvaluation,
  ReportSyncHealthOptions,
} from "./syncTelemetry.js";
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
