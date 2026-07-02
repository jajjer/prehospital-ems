/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
/**
 * English message catalog — the **source of truth** for i18n (issue #16). Every
 * other locale is typed as `Record<MessageKey, string>`, so adding a key here and
 * forgetting to translate it is a compile error, not a silent English fallback.
 *
 * `{name}` placeholders are interpolated by {@link ../index.translate}. Keep keys
 * grouped by screen; keep values free of markup (they render as plain text).
 */
export const en = {
  // Brand / shared
  "brand.tag": "EMS",
  "common.appName": "Field Capture",
  "common.close": "Close",
  "common.save": "Save",
  "common.saved": "Saved ✓",

  // Language switcher
  "lang.label": "Language",
  "lang.hint": "Applies immediately and works offline.",

  // Status bar
  "status.queued": "{count} queued",
  "status.failed": "{count} failed",
  "status.toReview": "{count} to review",
  "status.live": "Live",
  "status.offline": "Offline",
  "status.lock": "Lock",
  "status.lockApp": "Lock app",
  "status.signOut": "Sign out",

  // Navigation tabs
  "nav.capture": "Capture",
  "nav.records": "Records",
  "nav.settings": "Settings",

  // Login
  "login.subtitle.continue": "Sign in to continue",
  "login.subtitle.credentials": "Sign in with your OpenMRS credentials",
  "login.withOpenMRS": "Sign in with OpenMRS",
  "login.orUsernamePassword": "or use username and password",
  "login.username": "Username",
  "login.password": "Password",
  "login.signIn": "Sign in",
  "login.signingIn": "Signing in…",
  "login.invalidCredentials": "Invalid username or password.",
  "login.unreachable": "Could not reach OpenMRS. Check network.",
  "login.deviceSettings": "Device settings",

  // Lock screen
  "lock.createTitle": "Create app PIN",
  "lock.confirmTitle": "Confirm PIN",
  "lock.enterTitle": "Enter PIN",
  "lock.createSubtitle": "Protects patient data if this device is lost. Required to open the app.",
  "lock.unlockSubtitle": "Enter your PIN to unlock. Your queued records are safe.",
  "lock.pinMismatch": "PINs do not match. Start over.",
  "lock.wrongPin": "Wrong PIN.",
  "lock.wrongPinRemaining": "Wrong PIN. {count} attempts left before data is erased.",
  "lock.wrongPinRemainingOne": "Wrong PIN. 1 attempt left before data is erased.",
  "lock.genericError": "Something went wrong. Try again.",
  "lock.eraseWarning": "Data is erased after {count} wrong attempts to protect patient privacy.",
  "lock.delete": "Delete",
  "lock.next": "Next",
  "lock.setPin": "Set PIN",
  "lock.unlock": "Unlock",

  // App shell (banners, modals, transient screens)
  "app.updateAvailable": "Update available",
  "app.refresh": "Refresh",
  "app.bgSyncSuppressed": "Background sync may be disabled by battery optimization. Go to Settings → Apps → Chrome → Battery → Unrestricted.",
  "app.clockSkew": "Device clock may be off by ~{minutes} min. Vital timestamps could be incorrect — check Settings → Date & Time.",
  "app.storageWarning": "Device storage is nearly full. Free up space to ensure records can be saved offline.",
  "app.sessionExpiredTitle": "Session expired",
  "app.sessionExpiredBody": "Sign in again to continue syncing. Your queued records are safe.",
  "app.unlocking": "Unlocking…",
  "app.unlockError": "Could not unlock secure storage on this device. Close and reopen the app.",
  "app.completingSignIn": "Completing sign-in…",
  "app.queuedForSync": "Queued for sync",
  "app.queuedForSyncBody": "Data will upload automatically when connected.",
  "app.newPatient": "New patient",
  "app.dismiss": "Dismiss",

  // Settings (device configuration)
  "settings.title": "Device settings",
  "settings.intro": "Per-facility configuration for this device. Enroll with a fleet service to pull it centrally, or set values by hand below. Manual overrides win over the deployment's config.json, the fleet-pushed config, and the build defaults. Leave a field blank to use those. Changes apply immediately — no reinstall needed and they work offline.",
  "settings.manualConfiguration": "Manual configuration",
  "settings.inEffect": "In effect: {value}",
  "settings.openmrsBaseUrl": "OpenMRS base URL",
  "settings.locationUuid": "Location UUID (service / capture location)",
  "settings.gcsConceptUuid": "GCS concept UUID",
  "settings.idleLockMinutes": "Idle auto-lock (minutes)",
  "settings.wipeCheckUrl": "Remote-wipe URL (optional)",
  "settings.wipeCheckUnset": "Unset — remote wipe disabled",
  "settings.syncTelemetryUrl": "Sync-telemetry URL (optional)",
  "settings.syncTelemetryUnset": "Unset — telemetry disabled",
  "settings.receivingFacilities": "Receiving facilities",
  "settings.receivingNone": "None configured. The receiving facility is selected at handoff — capture never requires it, since the destination is often unknown when the crew first captures.",
  "settings.receivingSome": "{count} configured: {names}. Selected at handoff.",
  "settings.reset": "Reset to deployment defaults",

  // Fleet enrollment
  "enroll.title": "Fleet enrollment",
  "enroll.intro": "Enroll this device with a provisioning service to pull its configuration centrally. Managed devices refresh their config on every boot and can be re-pointed fleet-wide from the server.",
  "enroll.deviceId": "Device ID",
  "enroll.deviceIdHint": "Also the device's address for fleet sync-health and remote wipe.",
  "enroll.statusLabel": "Status",
  "enroll.statusEnrolled": "Enrolled",
  "enroll.statusEnrolledAs": "Enrolled as “{label}”",
  "enroll.fleet": "Fleet",
  "enroll.service": "Service",
  "enroll.checkUpdate": "Check for config update",
  "enroll.checking": "Checking…",
  "enroll.unenroll": "Un-enroll",
  "enroll.serviceUrl": "Provisioning service URL",
  "enroll.code": "Enrollment code (if required)",
  "enroll.label": "Device label (optional)",
  "enroll.enroll": "Enroll device",
  "enroll.enrolling": "Enrolling…",
  "enroll.okEnrolled": "Device enrolled — configuration applied.",
  "enroll.errEnroll": "Enrollment failed.",
  "enroll.okRefreshed": "Configuration updated from the fleet service.",
  "enroll.errRefresh": "Could not reach the fleet service — kept the last cached configuration.",
  "enroll.okUnenrolled": "Device un-enrolled — reverted to local configuration.",
} as const;

/** The set of translatable message keys. Other catalogs must cover all of them. */
export type MessageKey = keyof typeof en;

export default en;
