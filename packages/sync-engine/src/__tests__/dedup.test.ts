/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkActiveCalls } from "../dedup.js";

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const FHIR = "https://fhir.test/R4";
const AUTH = "Basic test";

/** A FHIR searchset bundle: one in-progress Encounter plus its _included Patient. */
function bundle() {
  return {
    entry: [
      {
        resource: {
          resourceType: "Encounter",
          id: "enc-1",
          subject: { reference: "Patient/pat-1" },
          period: { start: "2026-06-24T08:00:00.000Z" },
        },
      },
      {
        resource: {
          resourceType: "Patient",
          id: "pat-1",
          identifier: [{ use: "official", value: "MRN-42" }],
          gender: "female",
        },
      },
    ],
  };
}

beforeEach(() => {
  define("navigator", { onLine: true });
});

describe("checkActiveCalls — join-active-call discovery", () => {
  it("returns a summary joining each in-progress Encounter to its included Patient", async () => {
    define("fetch", vi.fn(async () => ({ ok: true, json: async () => bundle() })));

    const calls = await checkActiveCalls(FHIR, AUTH);

    expect(calls).toEqual([
      {
        encounterId: "enc-1",
        patientServerUUID: "pat-1",
        mrn: "MRN-42",
        gender: "female",
        startTime: "2026-06-24T08:00:00.000Z",
      },
    ]);
  });

  it("queries the in-progress encounters endpoint with the patient _include", async () => {
    const fetchMock = vi.fn(async (_url: string, _opts: { headers: { Authorization: string } }) => ({ ok: true, json: async () => bundle() }));
    define("fetch", fetchMock);

    await checkActiveCalls(FHIR, AUTH);

    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/Encounter?status=in-progress");
    expect(url).toContain("_include=Encounter:patient");
    expect(opts.headers.Authorization).toBe(AUTH);
  });

  it("drops an Encounter whose Patient was not included in the bundle", async () => {
    define("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ entry: [{ resource: { resourceType: "Encounter", id: "enc-x", subject: { reference: "Patient/missing" } } }] }),
    })));

    expect(await checkActiveCalls(FHIR, AUTH)).toEqual([]);
  });

  it("falls back to the server id and unknown gender when fields are absent", async () => {
    define("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        entry: [
          { resource: { resourceType: "Encounter", id: "enc-2", subject: { reference: "Patient/pat-2" } } },
          { resource: { resourceType: "Patient", id: "pat-2" } },
        ],
      }),
    })));

    const calls = await checkActiveCalls(FHIR, AUTH);
    expect(calls[0]!.mrn).toBe("pat-2");
    expect(calls[0]!.gender).toBe("unknown");
    expect(typeof calls[0]!.startTime).toBe("string");
  });

  it("returns [] when offline without hitting the network", async () => {
    define("navigator", { onLine: false });
    const fetchMock = vi.fn();
    define("fetch", fetchMock);

    expect(await checkActiveCalls(FHIR, AUTH)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] on a non-ok response", async () => {
    define("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await checkActiveCalls(FHIR, AUTH)).toEqual([]);
  });

  it("returns [] (never throws) when the request fails or times out", async () => {
    define("fetch", vi.fn(async () => { throw new Error("aborted"); }));
    expect(await checkActiveCalls(FHIR, AUTH)).toEqual([]);
  });
});
