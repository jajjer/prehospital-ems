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
| `captureLog` | `sex`, `approximateAge`, `complaint`, `vitalsJson`, `lat`, `lng` | `mrn`, `capturedAt`, `submissionStatus`, `encounterId`, `handoffAt`, `joined` |

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
table, the wrapped data key, and all key material. The data key is destroyed, so
even an attacker who later recovers the (already-deleted) tables has nothing to
decrypt them with. Auth tokens in `sessionStorage` are cleared by the app, which
then reloads to a clean state.

Biometric unlock (WebAuthn) is intentionally **not** implemented yet: releasing
usable key material from an authenticator requires the WebAuthn PRF extension,
whose support on the target budget devices is still uneven. The PIN is the
portable, fully-offline baseline; biometrics can layer on later.

## Threat model

| Threat                                                              | Mitigated?                                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Lost/stolen device → offline forensic dump of IndexedDB / disk      | **Yes.** PHI is ciphertext; the wrapped data key is only recoverable with the PIN (or the non-extractable device key, pre-PIN), so the dump has no usable key material.       |
| Lost/stolen device → attacker unlocks the phone and opens the app   | **Yes, once a PIN is set.** The data key is unwrapped only by the PIN; idle/background re-lock and a 10-attempt auto-wipe bound the exposure. Before a PIN is set (interim device-key mode), code in the app's origin can still decrypt — which is why a PIN is mandatory at first sign-in. |
| Lost device reported to an admin                                    | **Yes (when configured).** Remote wipe clears all local data on next launch/reconnect; see [App lock](#app-lock-session-timeout--remote-wipe). |
| Brute-force of the PIN                                              | **Bounded.** PBKDF2 (210k iters) slows each guess; 10 consecutive failures wipe local data. |
| XSS / malicious script running in the app origin                    | Not addressed here — see [#3](https://github.com/jajjer/prehospital-ems/issues/3) (token hardening + CSP).   |
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
