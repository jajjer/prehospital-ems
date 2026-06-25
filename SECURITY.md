<!--
This Source Code Form is subject to the terms of the Mozilla Public License,
v. 2.0. If a copy of the MPL was not distributed with this file, You can
obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
-->

# Security

## PHI at rest in IndexedDB

The field app captures patient data offline and queues it in IndexedDB until it
can sync to OpenMRS. On the budget Android devices this is built for, that
queue can sit on the device for a long time — and those devices get lost and
stolen. So PHI is **encrypted at rest** with AES-256-GCM before it is written to
IndexedDB, and decrypted only in memory when it is needed (to render the Records
screen, or to POST to the FHIR server).

### What is encrypted

Encryption is applied per field, at the data-access boundary
(`packages/sync-engine/src/phiCrypto.ts`), so the sync engine's existing flows —
enqueue, flush, dead-letter, capture log, retry — all pass through it.

| Table        | Encrypted (ciphertext at rest)                        | Cleartext (and why)                                              |
| ------------ | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `writeQueue` | `body` (the FHIR resource JSON)                       | `id`, `resourceType`, `resourceId`, `enqueuedAt`, indexes        |
| `deadLetter` | `body`                                                 | ids, `statusCode`, `failedAt`, indexes                           |
| `captureLog` | `sex`, `approximateAge`, `complaint`, `vitalsJson`, `repeatVitalsJson`, `interventionsJson`, `assessmentJson`, `lat`, `lng` | `mrn`, `capturedAt`, `submissionStatus`, `encounterId`, `handoffAt`, `joined`, `patientRef` |

The cleartext columns are local provisional identifiers, timestamps, and sync
state. They are indexed (so Dexie can query them) and are not, on their own,
patient-identifying. The `body` and the `captureLog` demographic/clinical/GPS
fields hold the actual PHI and are always ciphertext on disk.

**Verify it:** in Chrome DevTools → Application → IndexedDB →
`prehospital-ems-sync`, the `body` value and the `captureLog` PHI fields read as
`enc:v1:…` envelopes, not patient data.

### Envelope format

Each encrypted value is a self-describing string:

```
enc:v1:<base64(iv)>:<base64(ciphertext+gcmTag)>
```

A fresh 96-bit IV is generated per value. GCM's authentication tag means a
tampered ciphertext fails to decrypt rather than returning garbage.

### Why field-level, not a Dexie middleware

WebCrypto's `encrypt`/`decrypt` are asynchronous, and an IndexedDB transaction
auto-commits the instant control yields to a non-IndexedDB promise. Encrypting
*inside* a Dexie `dbcore` middleware therefore throws `InvalidStateError` — the
transaction is already gone by the time the cipher resolves. We instead encrypt
just before handing a record to Dexie and decrypt just after Dexie returns it,
so every write is a single synchronous transaction over already-ciphertext
values. (This is also the only reason the Records screen reads forward and
reverses in memory: a reverse cursor would surface ciphertext, because the
decrypt happens after the read, not within it.)

## Key lifecycle

PHI is encrypted under a single AES-256-GCM **data key (DEK)** that is generated
once on first launch and never changes. Because the DEK is stable, existing
ciphertext stays readable no matter how the device is unlocked — setting a PIN,
locking, and unlocking never re-encrypt any PHI.

The DEK is never stored in plaintext. It is stored **wrapped** (encrypted) under
a **key-encryption key (KEK)** in a separate `prehospital-ems-keystore` database
(`packages/sync-engine/src/keystore.ts`). Wrapping is AES-GCM over the DEK's raw
bytes; the GCM auth tag means unwrapping with the wrong KEK fails rather than
yielding a garbage key — which is exactly how a wrong PIN is detected. The DEK is
held in memory only while the app is unlocked (`crypto.ts`); locking
(`lockEncryption()`) drops it and re-arms the gate so the next PHI access blocks
until the app is unlocked again.

There are two KEK modes, resolved on app start by `initAppLock()`
(`appLock.ts`):

1. **PIN-derived key (steady state).** Once the user sets an app-lock PIN, the
   KEK is `PBKDF2(PIN, per-device-salt, SHA-256, 210k iters)` and the device key
   is deleted. The DEK can then only be unwrapped by re-entering the PIN, so the
   key material exists only while the app is unlocked. This fully addresses the
   lost/stolen-device threat. See [App lock](#app-lock-session-timeout--remote-wipe).

2. **Device key (interim, pre-PIN).** Before a PIN is set, the KEK is a
   **non-extractable** AES-GCM key generated once and persisted in the keystore.
   Its raw bytes never leave the browser's crypto subsystem, so a raw
   disk/IndexedDB dump yields only ciphertext and an opaque key handle. Code
   running in the app's origin can still unwrap it, which is why setting a PIN is
   required (and prompted on first sign-in) to fully close the lost-device gap.

The per-device salt is random (16 bytes), generated once, and stored alongside
the key. Salt is not secret.

## App lock, session timeout & remote wipe

On a budget Android device, at-rest encryption defeats an offline forensic dump,
but not an attacker who simply unlocks the phone and opens the app. App lock
(`appLock.ts`, with the UI in `apps/field-app/src/LockScreen.tsx`) closes that
gap by gating the data key behind a user secret.

- **PIN.** A PIN (minimum 4 digits) is required to open the app. It is mandatory:
  the first time a user signs in, they must create one. The PIN derives the KEK
  that unwraps the data key — there is no separate "PIN check" that could be
  bypassed, and a wrong PIN simply fails to unwrap.
- **Idle timeout & background re-lock.** The UI re-locks after
  `VITE_IDLE_LOCK_MINUTES` of inactivity (default 5) and immediately when the app
  is backgrounded. Re-locking only drops the in-memory key — **the offline queue
  is never lost**.
- **Brute-force auto-wipe.** After `MAX_PIN_ATTEMPTS` (10) consecutive wrong
  PINs, all local data is wiped (see below).
- **Remote wipe.** When a device is reported lost, an admin flags it server-side.
  On the next launch and on reconnect, the app GETs `VITE_WIPE_CHECK_URL` with
  its opaque `deviceId`; a response of `{ "wipe": true }` triggers a wipe. The
  check **fails safe** — any network error, non-OK response, or unparseable body
  is treated as "do not wipe", so a transient outage never destroys data. The
  endpoint is optional; when `VITE_WIPE_CHECK_URL` is unset the check is skipped.

A **wipe** (`wipe.ts`) deletes both the PHI database and the keystore — every PHI
table, the wrapped data key, all key material, and the encrypted auth tokens. The
data key is destroyed, so even an attacker who later recovers the (already-
deleted) tables has nothing to decrypt them with. The in-memory token copies are
dropped in the same call, and the app reloads to a clean state.

Biometric unlock (WebAuthn) is intentionally **not** implemented yet: releasing
usable key material from an authenticator requires the WebAuthn PRF extension,
whose support on the target budget devices is still uneven. The PIN is the
portable, fully-offline baseline; biometrics can layer on later.

## Fleet sync telemetry

When `VITE_SYNC_TELEMETRY_URL` is configured, each device POSTs a sync-health
snapshot after every flush so operations can see stuck devices (see
`syncTelemetry.ts`). The snapshot egresses **only non-PHI**: the opaque
`deviceId`, queue/dead-letter/conflict **counts**, and **timestamps** (oldest
queued, oldest dead-lettered, last sync, reported-at). It never carries an MRN,
a FHIR resource body, or any patient content — the dead-lettered bodies that
caused a failure stay encrypted on the device. Reporting is **best-effort**: a
network error or non-OK response is swallowed and never disrupts the sync path.
The endpoint is optional; when unset, no telemetry leaves the device.

## Auth token storage

Access tokens, the OAuth2 refresh token, and the Basic-auth header used to live
in `sessionStorage` as plaintext — readable by any injected script, and (for the
refresh token) persisted across reloads in the clear. They are now handled by
`packages/sync-engine/src/tokenStore.ts`:

- **In memory.** The active auth header and refresh token are held in module
  state for the unlocked session and are the single source of truth the app and
  sync worker read. They are **never** written to web storage in plaintext.
- **Encrypted at rest.** So a session survives a reload — a service-worker update
  reloads the page mid-shift — the same values are persisted to the keystore as
  AES-GCM `enc:v1:…` envelopes under the **same data key that protects PHI**.
  The access-token expiry is stored alongside in cleartext (it is not sensitive)
  so a proactive refresh can be scheduled without unwrapping the token first.

Because the tokens are wrapped under the data key, a stolen **locked** device
yields only ciphertext — there is no plaintext token on disk — and the tokens are
destroyed together with the keystore on logout, remote wipe, or brute-force auto-
wipe. Persistence is gated on the unlock state: while the app is locked the
tokens are kept in memory only and reconciled to disk once it unlocks, so a token
write never blocks on an app that has not been unlocked yet.

**Proactive refresh.** Instead of only reacting to a `401` from the sync worker,
the app schedules a silent refresh to fire ~60s before the access token expires
(`oauth2.ts`, `scheduleProactiveRefresh`), re-arming itself after each refresh.
The 401 path remains as a fallback. PKCE handshake values (`verifier`, `state`)
stay in `sessionStorage`: they are short-lived, non-sensitive, and must survive
the authorization redirect before the app has unlocked.

**Verify it:** in Chrome DevTools → Application, `sessionStorage` no longer holds
`ems_auth` / `ems_refresh_token`, and the keystore's `tokens` table reads as
`enc:v1:…` envelopes, not bearer/refresh tokens.

## Content-Security-Policy

The built field app ships a Content-Security-Policy (`apps/field-app/vite.config.ts`,
injected as a `<meta http-equiv>` into `index.html` at **build time only** — Vite's
dev server needs inline scripts and `eval` for HMR, which a strict policy breaks).
The bundle is entirely same-origin hashed assets plus a same-origin service
worker, so `default-src 'self'` with `script-src 'self'` / `worker-src 'self'`
admits the app without `'unsafe-inline'` or `'unsafe-eval'` for scripts. The only
outbound connection is to OpenMRS (and the optional remote-wipe endpoint); when
those are configured as absolute URLs their origins are added to `connect-src`,
and the default same-origin reverse-proxy path (`/openmrs`) is already covered by
`'self'`. Since the policy lives in the precached `index.html`, **it applies
offline too** — the app keeps functioning with no network.

`frame-ancestors`, `X-Frame-Options`, HSTS, and `Referrer-Policy` cannot be set
from a `<meta>` tag; the host/CDN should send them as HTTP response headers. The
recommended production header set:

```
Content-Security-Policy: <as injected, optionally with frame-ancestors 'none'>
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=63072000; includeSubDomains
```

## Threat model

| Threat                                                              | Mitigated?                                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Lost/stolen device → offline forensic dump of IndexedDB / disk      | **Yes.** PHI is ciphertext; the wrapped data key is only recoverable with the PIN (or the non-extractable device key, pre-PIN), so the dump has no usable key material.       |
| Lost/stolen device → attacker unlocks the phone and opens the app   | **Yes, once a PIN is set.** The data key is unwrapped only by the PIN; idle/background re-lock and a 10-attempt auto-wipe bound the exposure. Before a PIN is set (interim device-key mode), code in the app's origin can still decrypt — which is why a PIN is mandatory at first sign-in. |
| Lost device reported to an admin                                    | **Yes (when configured).** Remote wipe clears all local data on next launch/reconnect; see [App lock](#app-lock-session-timeout--remote-wipe). |
| Brute-force of the PIN                                              | **Bounded.** PBKDF2 (210k iters) slows each guess; 10 consecutive failures wipe local data. |
| XSS / malicious script running in the app origin                    | **Reduced.** No auth tokens sit in plaintext web storage (in-memory + encrypted-at-rest), and a build-time CSP (`script-src 'self'`, no `'unsafe-inline'`/`'unsafe-eval'`) shrinks the injection surface. A script already executing in the origin can still read in-memory tokens while unlocked — defense-in-depth, not elimination. See [Auth token storage](#auth-token-storage) and [Content-Security-Policy](#content-security-policy). |
| Network interception                                                | Out of scope for at-rest encryption; transport is HTTPS (see Deployment in the README).                     |

## Known limitations

- **Before a PIN is set, at-rest protection depends on the device key**, which is
  recoverable by code running in the app's origin. The app prompts for a PIN at
  first sign-in to move out of this interim state as quickly as possible.
- **A forgotten PIN means the local data is unrecoverable** — by design. The data
  key is wrapped under the PIN; there is no recovery path or backdoor. Already-
  synced records live on the server; only unsynced local data is lost, and the
  user can set a new PIN after a wipe.
- **No biometric unlock yet** — PIN only (see [App lock](#app-lock-session-timeout--remote-wipe)).
- **Rows written before this change** (if any predate encryption) are read back
  verbatim: non-envelope values pass through untouched so the app degrades
  gracefully rather than failing. A fresh install stores everything encrypted.

## Reporting

This is a reference implementation. For security issues in the upstream OpenMRS
platform, follow the [OpenMRS responsible disclosure process](https://openmrs.org/).
