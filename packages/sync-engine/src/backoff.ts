/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
// Exponential backoff with full jitter.
// Parameters from design doc: initial=2s, multiplier=2, maxDelay=10min, maxRetries=8.

export const BACKOFF = {
  initialMs: 2_000,
  multiplier: 2,
  maxDelayMs: 10 * 60 * 1_000,
  maxRetries: 8,
} as const;

/**
 * Returns the delay in ms for attempt N (0-indexed), with full jitter.
 * Formula: random(0, min(maxDelay, initial * multiplier^n))
 */
export function backoffDelay(attempt: number): number {
  const cap = Math.min(
    BACKOFF.maxDelayMs,
    BACKOFF.initialMs * Math.pow(BACKOFF.multiplier, attempt)
  );
  return Math.random() * cap;
}

/** Returns true if the item should be promoted to dead-letter on this attempt. */
export function shouldDeadLetter(retryCount: number, statusCode: number): boolean {
  const isPermanentError = statusCode >= 400 && statusCode < 500;
  const exhausted = retryCount >= BACKOFF.maxRetries;
  return isPermanentError || exhausted;
}
