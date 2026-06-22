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

The encryption key is an AES-256-GCM key held in memory only while the app is
unlocked (`packages/sync-engine/src/crypto.ts`). It is provisioned on app start
by `initEncryption()` (`deviceKey.ts`). There are two derivation paths:

1. **User secret (target state).** When the app-lock flow supplies a PIN, the
   key is derived from `PBKDF2(PIN, per-device-salt, SHA-256, 210k iters)`. The
   key material exists only while the app is unlocked; locking
   (`lockEncryption()`) drops it and re-arms the gate so the next PHI access
   blocks until the PIN is re-entered. This is the configuration that fully
   addresses the lost/stolen-device threat.

2. **Device key (current interim state).** Until app lock lands
   ([#2](https://github.com/jajjer/prehospital-ems/issues/2)), the key is a
   **non-extractable** AES-GCM key generated once and persisted in the browser
   keystore (a separate `prehospital-ems-keystore` database). Its raw bytes
   never leave the browser's crypto subsystem, so a raw disk/IndexedDB dump
   yields only ciphertext and an opaque key handle.

The per-device salt is random (16 bytes), generated once, and stored alongside
the key. Salt is not secret.

## Threat model

| Threat                                                              | Mitigated?                                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Lost/stolen device → offline forensic dump of IndexedDB / disk      | **Yes.** PHI is ciphertext; the device key is non-extractable, so the dump has no usable key material.       |
| Lost/stolen device → attacker unlocks the phone and opens the app   | **Partially, today.** With the device key alone, code in the app's origin can decrypt. The app-lock PIN ([#2](https://github.com/jajjer/prehospital-ems/issues/2)) closes this by gating the key behind a user secret. |
| XSS / malicious script running in the app origin                    | Not addressed here — see [#3](https://github.com/jajjer/prehospital-ems/issues/3) (token hardening + CSP).   |
| Network interception                                                | Out of scope for at-rest encryption; transport is HTTPS (see Deployment in the README).                     |

## Known limitations

- **At-rest protection currently depends on the device key**, which is
  recoverable by code running in the app's origin. The PIN-derived key
  ([#2](https://github.com/jajjer/prehospital-ems/issues/2)) is required to fully
  protect data on an unlocked, stolen device. The code path for it
  (`initEncryption({ userSecret })`) already exists.
- **No remote wipe yet** — tracked in
  [#2](https://github.com/jajjer/prehospital-ems/issues/2).
- **Rows written before this change** (if any predate encryption) are read back
  verbatim: non-envelope values pass through untouched so the app degrades
  gracefully rather than failing. A fresh install stores everything encrypted.

## Reporting

This is a reference implementation. For security issues in the upstream OpenMRS
platform, follow the [OpenMRS responsible disclosure process](https://openmrs.org/).
