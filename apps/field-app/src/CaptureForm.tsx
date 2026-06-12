import { useState } from "react";
import {
  buildProvisionalMrn,
  buildProvisionalPatient,
  buildPrehospitalEncounter,
  buildVitalObservations,
  validateVitals,
  type VitalsInput,
  type PatientSex,
} from "@prehospital-ems/fhir-contracts";
import { enqueue, flush, logCapture } from "@prehospital-ems/sync-engine";
import { C, FONT } from "./theme.js";

interface Props {
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
  { key: "hr",          label: "Heart Rate",    unit: "bpm",   low: 60,  high: 100, step: 1,  min: 0,   max: 300 },
  { key: "rr",          label: "Resp. Rate",    unit: "/min",  low: 12,  high: 20,  step: 1,  min: 0,   max: 60  },
  { key: "bpSystolic",  label: "Systolic BP",   unit: "mmHg",  low: 90,  high: 140, step: 1,  min: 0,   max: 300 },
  { key: "bpDiastolic", label: "Diastolic BP",  unit: "mmHg",  low: 60,  high: 90,  step: 1,  min: 0,   max: 200 },
  { key: "spo2",        label: "SpO₂",          unit: "%",     low: 95,  high: 100, step: 1,  min: 0,   max: 100 },
  { key: "gcs",         label: "GCS Total",     unit: "pts",   low: 13,  high: 15,  step: 1,  min: 3,   max: 15  },
];

const EMPTY_VITALS: VitalsInput = { hr: 0, rr: 0, bpSystolic: 0, bpDiastolic: 0, spo2: 0, gcs: 15 };

function vitalColor(value: number, meta: VitalMeta): string {
  if (value === 0) return C.muted;
  if (value < meta.low || value > meta.high) return C.danger;
  return C.success;
}

export function CaptureForm({ onSubmit }: Props) {
  const [vitals, setVitals] = useState<VitalsInput>(EMPTY_VITALS);
  const [sex, setSex] = useState<PatientSex>("unknown");
  const [age, setAge] = useState("");
  const [complaint, setComplaint] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validateVitals(vitals).map((e) => e.message);
    if (errs.length > 0) { setErrors(errs); return; }
    setErrors([]);
    setSubmitting(true);

    const mrn = buildProvisionalMrn();
    const provisionalEncounterId = `ENC-${crypto.randomUUID().slice(0, 8)}`;
    const approxAge = age ? parseInt(age, 10) : undefined;

    const patient = buildProvisionalPatient(mrn, {
      sex,
      ...(Number.isFinite(approxAge) && approxAge !== undefined ? { approximateAge: approxAge } : {}),
    });
    const encounter = buildPrehospitalEncounter({ patientServerUUID: mrn });
    const observations = buildVitalObservations(vitals, {
      patientServerUUID: mrn,
      encounterServerUUID: provisionalEncounterId,
    });

    await enqueue({ id: crypto.randomUUID(), resourceType: "Patient",   resourceId: mrn,                    body: JSON.stringify(patient) });
    await enqueue({ id: crypto.randomUUID(), resourceType: "Encounter",  resourceId: provisionalEncounterId, body: JSON.stringify({ ...encounter, id: provisionalEncounterId }), patientId: mrn });
    for (const obs of observations) {
      await enqueue({ id: crypto.randomUUID(), resourceType: "Observation", resourceId: crypto.randomUUID(), body: JSON.stringify(obs), patientId: mrn, encounterId: provisionalEncounterId });
    }

    await logCapture({
      mrn,
      capturedAt: Date.now(),
      sex,
      approximateAge: Number.isFinite(approxAge) && approxAge !== undefined ? approxAge : undefined,
      complaint,
      vitalsJson: JSON.stringify(vitals),
    });

    void flush();
    setSubmitting(false);
    onSubmit();
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} style={{ fontFamily: FONT }}>

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
            style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
          />
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
