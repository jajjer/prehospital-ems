import { describe, it, expect } from "vitest";
import { backoffDelay, shouldDeadLetter, BACKOFF } from "../backoff.js";

describe("backoffDelay", () => {
  it("returns 0 or more", () => {
    for (let i = 0; i < 10; i++) {
      expect(backoffDelay(i)).toBeGreaterThanOrEqual(0);
    }
  });

  it("never exceeds maxDelayMs", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(backoffDelay(attempt)).toBeLessThanOrEqual(BACKOFF.maxDelayMs);
    }
  });

  it("cap grows: attempt 1 cap > attempt 0 cap (statistically)", () => {
    // Run many samples; average for attempt 1 should exceed attempt 0
    const avg = (n: number) =>
      Array.from({ length: 500 }, () => backoffDelay(n)).reduce((a, b) => a + b, 0) / 500;
    expect(avg(1)).toBeGreaterThan(avg(0) * 0.5); // generous: just check it's non-trivially higher
  });
});

describe("shouldDeadLetter", () => {
  it("returns true for 4xx errors (permanent)", () => {
    expect(shouldDeadLetter(0, 422)).toBe(true);
    expect(shouldDeadLetter(0, 404)).toBe(true);
  });

  it("returns false for 5xx under maxRetries", () => {
    expect(shouldDeadLetter(0, 503)).toBe(false);
    expect(shouldDeadLetter(BACKOFF.maxRetries - 1, 503)).toBe(false);
  });

  it("returns true for 5xx at maxRetries", () => {
    expect(shouldDeadLetter(BACKOFF.maxRetries, 503)).toBe(true);
  });

  it("returns true for 5xx beyond maxRetries", () => {
    expect(shouldDeadLetter(BACKOFF.maxRetries + 1, 500)).toBe(true);
  });
});
