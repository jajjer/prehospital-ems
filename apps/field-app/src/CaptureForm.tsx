/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState, useEffect } from "react";
import {
  buildProvisionalMrn,
  buildProvisionalPatient,
  buildPrehospitalEncounter,
  buildVitalObservations,
  buildChiefComplaintCondition,
  validateVitals,
  type VitalsInput,
  type PatientSex,
} from "@prehospital-ems/fhir-contracts";
import {
  enqueue, flush, logCapture, markCaptureComplete, getPendingCapture,
  checkActiveCalls, type ActiveCallSummary,
} from "@prehospital-ems/sync-engine";
import { C, FONT } from "./theme.js";
import { FHIR_BASE, LOCATION_UUID, GCS_CONCEPT_UUID } from "./config.js";

interface Props {
  authHeader: string;
  onSubmit: () => void;
}

interface VitalMeta {
  key: keyof VitalsInput;
  label: string;
  unit: string;
  low: number;
  high: number;
  step: number;
  min: number;
  max: number;
}

const VITALS: VitalMeta[] = [
  { key: "hr",          label: "Heart Rate",    unit: "bpm",   low: 60,   high: 100,  step: 1,   min: 0,  max: 300 },
  { key: "rr",          label: "Resp. Rate",    unit: "/min",  low: 12,   high: 20,   step: 1,   min: 0,  max: 60  },
  { key: "bpSystolic",  label: "Systolic BP",   unit: "mmHg",  low: 90,   high: 140,  step: 1,   min: 0,  max: 300 },
  { key: "bpDiastolic", label: "Diastolic BP",  unit: "mmHg",  low: 60,   high: 90,   step: 1,   min: 0,  max: 200 },
  { key: "temp",        label: "Temp",          unit: "°C",    low: 36.1, high: 37.5, step: 0.1, min: 24, max: 45  },
  { key: "spo2",        label: "SpO₂",          unit: "%",     low: 95,   high: 100,  step: 1,   min: 0,  max: 100 },
  { key: "gcs",         label: "GCS Total",     unit: "pts",   low: 13,   high: 15,   step: 1,   min: 3,  max: 15  },
];

const EMPTY_VITALS: VitalsInput = { hr: 0, rr: 0, bpSystolic: 0, bpDiastolic: 0, temp: 0, spo2: 0, gcs: 15 };

function vitalColor(value: number, meta: VitalMeta): string {
  if (value === 0) return C.muted;
  if (value < meta.low || value > meta.high) return C.danger;
  return C.success;
}

type DedupModalState = {
  calls: ActiveCallSummary[];
  onJoin: (call: ActiveCallSummary) => void;
  onNew: () => void;
} | null;

export function CaptureForm({ authHeader, onSubmit }: Props) {
  const [vitals, setVitals] = useState<VitalsInput>(EMPTY_VITALS);
  const [sex, setSex] = useState<PatientSex>("unknown");
  const [age, setAge] = useState("");
  const [complaint, setComplaint] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [pendingBanner, setPendingBanner] = useState(false);
  const [dedupModal, setDedupModal] = useState<DedupModalState>(null);

  useEffect(() => {
    getPendingCapture().then((entry) => {
      if (entry) setPendingBanner(true);
    }).catch(() => undefined);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validateVitals(vitals).map((e) => e.message);
    if (errs.length > 0) { setErrors(errs); return; }
    setErrors([]);
    setSubmitting(true);

    const localMrn = buildProvisionalMrn();
    const approxAge = age ? parseInt(age, 10) : undefined;

    // Non-blocking GPS capture — 3 s timeout, accepts cached position (30 s)
    let gps: { lat: number; lng: number } | undefined;
    await new Promise<void>((resolve) => {
      if (!("geolocation" in navigator)) { resolve(); return; }
      const timer = setTimeout(resolve, 3_000);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          gps = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          resolve();
        },
        () => { clearTimeout(timer); resolve(); },
        { maximumAge: 30_000, timeout: 2_500 }
      );
    });

    // Dedup check — if active calls exist in FHIR, ask whether to join one
    let joinTarget: ActiveCallSummary | null = null;
    if (navigator.onLine) {
      const activeCalls = await checkActiveCalls(FHIR_BASE, authHeader);
      if (activeCalls.length > 0) {
        joinTarget = await new Promise<ActiveCallSummary | null>((resolve) => {
          setDedupModal({
            calls: activeCalls,
            onJoin: (call) => { setDedupModal(null); resolve(call); },
            onNew:  ()     => { setDedupModal(null); resolve(null); },
          });
        });
      }
    }

    if (joinTarget) {
      await doJoinCapture(joinTarget, localMrn, gps, approxAge);
    } else {
      await doNewCapture(localMrn, gps, approxAge);
    }

    void flush();
    setSubmitting(false);
    onSubmit();
  }

  async function doNewCapture(
    mrn: string,
    gps: { lat: number; lng: number } | undefined,
    approxAge: number | undefined,
  ) {
    const provisionalEncounterId = `ENC-${crypto.randomUUID().slice(0, 8)}`;

    const patient = buildProvisionalPatient(mrn, {
      sex,
      locationUUID: LOCATION_UUID,
      ...(Number.isFinite(approxAge) && approxAge !== undefined ? { approximateAge: approxAge } : {}),
    });
    const encounter = buildPrehospitalEncounter({
      patientServerUUID: mrn,
      locationUUID: LOCATION_UUID,
      ...(gps ? { gps } : {}),
    });
    const observations = buildVitalObservations(vitals, {
      patientServerUUID: mrn,
      encounterServerUUID: provisionalEncounterId,
      gcsConceptUUID: GCS_CONCEPT_UUID,
    });

    await logCapture({
      mrn,
      capturedAt: Date.now(),
      sex,
      approximateAge: Number.isFinite(approxAge) && approxAge !== undefined ? approxAge : undefined,
      complaint,
      vitalsJson: JSON.stringify(vitals),
      submissionStatus: "pending",
      encounterId: provisionalEncounterId,
      ...(gps ? { lat: gps.lat, lng: gps.lng } : {}),
    });

    await enqueue({ id: crypto.randomUUID(), resourceType: "Patient",   resourceId: mrn,                    body: JSON.stringify(patient) });
    await enqueue({ id: crypto.randomUUID(), resourceType: "Encounter",  resourceId: provisionalEncounterId, body: JSON.stringify({ ...encounter, id: provisionalEncounterId }), patientId: mrn });
    for (const obs of observations) {
      await enqueue({ id: crypto.randomUUID(), resourceType: "Observation", resourceId: crypto.randomUUID(), body: JSON.stringify(obs), patientId: mrn, encounterId: provisionalEncounterId });
    }
    if (complaint.trim()) {
      const condition = buildChiefComplaintCondition(complaint.trim(), { patientServerUUID: mrn });
      await enqueue({ id: crypto.randomUUID(), resourceType: "Condition", resourceId: crypto.randomUUID(), body: JSON.stringify(condition), patientId: mrn, encounterId: provisionalEncounterId });
    }

    await markCaptureComplete(mrn);
  }

  async function doJoinCapture(
    target: ActiveCallSummary,
    localMrn: string,
    gps: { lat: number; lng: number } | undefined,
    approxAge: number | undefined,
  ) {
    // Store the server encounter UUID directly — no provisional IDs needed
    await logCapture({
      mrn: localMrn,
      capturedAt: Date.now(),
      sex,
      approximateAge: Number.isFinite(approxAge) && approxAge !== undefined ? approxAge : undefined,
      complaint,
      vitalsJson: JSON.stringify(vitals),
      submissionStatus: "pending",
      encounterId: target.encounterId,
      joined: true,
      ...(gps ? { lat: gps.lat, lng: gps.lng } : {}),
    });

    // Enqueue vitals against the existing encounter using server UUIDs directly
    const observations = buildVitalObservations(vitals, {
      patientServerUUID: target.patientServerUUID,
      encounterServerUUID: target.encounterId,
      gcsConceptUUID: GCS_CONCEPT_UUID,
    });
    for (const obs of observations) {
      await enqueue({
        id: crypto.randomUUID(), resourceType: "Observation",
        resourceId: crypto.randomUUID(), body: JSON.stringify(obs),
        patientId: target.patientServerUUID, encounterId: target.encounterId,
      });
    }
    if (complaint.trim()) {
      const condition = buildChiefComplaintCondition(complaint.trim(), { patientServerUUID: target.patientServerUUID });
      await enqueue({
        id: crypto.randomUUID(), resourceType: "Condition",
        resourceId: crypto.randomUUID(), body: JSON.stringify(condition),
        patientId: target.patientServerUUID, encounterId: target.encounterId,
      });
    }

    await markCaptureComplete(localMrn);
  }

  return (
    <>
      {/* Dedup modal */}
      {dedupModal && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 200, padding: "1rem", fontFamily: FONT,
        }}>
          <div style={{
            background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 12, padding: "1.25rem", width: "100%", maxWidth: 380,
          }}>
            <p style={{ fontWeight: 700, fontSize: "0.9375rem", marginBottom: "0.25rem", color: C.text }}>
              Active calls in system
            </p>
            <p style={{ color: C.muted, fontSize: "0.8125rem", marginBottom: "1rem" }}>
              Is your patient already being captured by another device? Join the existing call to avoid duplicates.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "1rem" }}>
              {dedupModal.calls.map((call) => (
                <div key={call.encounterId} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  background: "#162032", border: `1px solid ${C.border}`,
                  borderRadius: 8, padding: "0.625rem 0.75rem",
                }}>
                  <div>
                    <span style={{ fontWeight: 600, fontSize: "0.8125rem", fontFamily: "monospace", color: C.text }}>
                      {call.mrn}
                    </span>
                    <span style={{ color: C.muted, fontSize: "0.75rem", marginLeft: "0.5rem" }}>
                      {call.gender === "male" ? "M" : call.gender === "female" ? "F" : "U"}
                    </span>
                    <span style={{ color: C.muted, fontSize: "0.75rem", marginLeft: "0.5rem" }}>
                      {new Date(call.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <button
                    onClick={() => dedupModal.onJoin(call)}
                    style={{
                      background: C.primary, color: "#fff", border: "none",
                      borderRadius: 6, padding: "0.3rem 0.625rem",
                      fontSize: "0.75rem", fontWeight: 600, cursor: "pointer",
                      fontFamily: FONT, flexShrink: 0, marginLeft: "0.75rem",
                    }}
                  >
                    Join
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={() => dedupModal.onNew()}
              style={{
                width: "100%", padding: "0.625rem",
                background: "transparent", border: `1px solid ${C.border}`,
                borderRadius: 8, color: C.muted,
                fontFamily: FONT, fontSize: "0.875rem", fontWeight: 500,
                cursor: "pointer",
              }}
            >
              New patient — not in the list
            </button>
          </div>
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} style={{ fontFamily: FONT }}>

        {pendingBanner && (
          <div style={{
            background: "#1c1a0a", border: `1px solid #ca8a04`,
            borderRadius: 8, padding: "0.75rem 1rem",
            marginBottom: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span style={{ color: "#fbbf24", fontSize: "0.8125rem" }}>
              A recent capture may not have completed. Check Records before submitting again.
            </span>
            <button
              type="button"
              onClick={() => setPendingBanner(false)}
              style={{ background: "none", border: "none", color: "#ca8a04", cursor: "pointer", fontSize: "1rem", padding: "0 0 0 0.75rem" }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Patient info */}
        <Section label="Patient">
          <div style={{ display: "flex", gap: "0.75rem", marginBottom: "0.875rem" }}>
            <div style={{ flex: 1 }}>
              <FieldLabel>Sex</FieldLabel>
              <div style={{ display: "flex", gap: "0.375rem" }}>
                {(["male", "female", "unknown"] as PatientSex[]).map((s) => (
                  <button
                    key={s} type="button"
                    onClick={() => setSex(s)}
                    style={{
                      flex: 1, padding: "0.5rem 0", border: `1px solid ${sex === s ? C.primary : C.border}`,
                      borderRadius: 6, background: sex === s ? "#1d3557" : C.surface,
                      color: sex === s ? C.primary : C.muted,
                      fontFamily: FONT, fontSize: "0.8125rem", fontWeight: sex === s ? 600 : 400,
                      cursor: "pointer", transition: "all 0.1s",
                    }}
                  >
                    {s === "male" ? "M" : s === "female" ? "F" : "U"}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <FieldLabel>Approx. Age</FieldLabel>
              <input
                type="number" inputMode="numeric" placeholder="yrs"
                value={age} onChange={(e) => setAge(e.target.value)}
                style={inputStyle}
              />
            </div>
          </div>
          <div>
            <FieldLabel>Chief Complaint</FieldLabel>
            <input
              type="text" placeholder="e.g. chest pain, trauma, SOB"
              value={complaint} onChange={(e) => setComplaint(e.target.value)}
              maxLength={255}
              style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
            />
            {complaint.length > 200 && (
              <div style={{ fontSize: "0.6875rem", color: complaint.length >= 255 ? C.danger : C.muted, textAlign: "right", marginTop: "0.2rem" }}>
                {complaint.length}/255
              </div>
            )}
          </div>
        </Section>

        {/* Vitals grid */}
        <Section label="Vitals">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.625rem" }}>
            {VITALS.map((v) => (
              <VitalCard
                key={v.key}
                meta={v}
                value={vitals[v.key]}
                onChange={(val) => setVitals((p) => ({ ...p, [v.key]: val }))}
                fullWidth={v.key === "gcs"}
              />
            ))}
          </div>
        </Section>

        {/* Errors */}
        {errors.length > 0 && (
          <div style={{ background: C.dangerBg, border: `1px solid ${C.danger}`, borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "1rem" }}>
            {errors.map((e) => (
              <div key={e} style={{ color: C.danger, fontSize: "0.8125rem" }}>• {e}</div>
            ))}
          </div>
        )}

        <button
          type="submit" disabled={submitting}
          style={{
            width: "100%", padding: "0.875rem",
            background: submitting ? C.border : C.primary,
            color: "#fff", border: "none", borderRadius: 8,
            fontSize: "1rem", fontWeight: 700, cursor: submitting ? "default" : "pointer",
            fontFamily: FONT, letterSpacing: "0.02em",
            transition: "background 0.15s",
          }}
        >
          {submitting ? "Saving…" : "Save & Queue"}
        </button>
      </form>
    </>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <div style={{
        fontSize: "0.6875rem", fontWeight: 700, color: C.muted,
        letterSpacing: "0.1em", textTransform: "uppercase",
        marginBottom: "0.625rem",
      }}>
        {label}
      </div>
      <div style={{
        background: C.surface, borderRadius: 10,
        border: `1px solid ${C.border}`, padding: "0.875rem",
      }}>
        {children}
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "0.6875rem", color: C.muted, marginBottom: "0.3rem", fontWeight: 500 }}>
      {children}
    </div>
  );
}

function VitalCard({ meta, value, onChange, fullWidth }: {
  meta: VitalMeta;
  value: number;
  onChange: (v: number) => void;
  fullWidth?: boolean;
}) {
  const color = vitalColor(value, meta);
  const isAbnormal = value !== 0 && (value < meta.low || value > meta.high);

  return (
    <div style={{
      gridColumn: fullWidth ? "1 / -1" : undefined,
      background: isAbnormal ? "#1c0a0a" : "#162032",
      border: `1px solid ${isAbnormal ? C.danger : C.border}`,
      borderRadius: 8, padding: "0.625rem 0.75rem",
      transition: "border-color 0.15s, background 0.15s",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.3rem" }}>
        <span style={{ fontSize: "0.6875rem", color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>
          {meta.label}
        </span>
        <span style={{ fontSize: "0.625rem", color: isAbnormal ? C.danger : "#475569" }}>
          {meta.low}–{meta.high} {meta.unit}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.375rem" }}>
        <input
          type="number" inputMode="numeric"
          value={value === 0 ? "" : value}
          placeholder="—"
          min={meta.min} max={meta.max} step={meta.step}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            onChange(Number.isFinite(n) ? n : 0);
          }}
          style={{
            flex: 1, background: "transparent", border: "none", outline: "none",
            color, fontFamily: FONT, fontSize: "1.75rem", fontWeight: 700,
            padding: 0, width: 0, minWidth: 0,
          }}
        />
        <span style={{ fontSize: "0.75rem", color: C.muted, flexShrink: 0 }}>{meta.unit}</span>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#162032", border: `1px solid ${C.border}`,
  borderRadius: 6, padding: "0.5rem 0.625rem",
  color: C.text, fontFamily: FONT, fontSize: "0.9375rem",
  outline: "none", width: "100%", boxSizing: "border-box",
};
