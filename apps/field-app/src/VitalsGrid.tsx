/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { gcsTotalFromComponents, GCS_RANGES, type VitalsInput } from "@prehospital-ems/fhir-contracts";
import { C, FONT } from "./theme.js";

export interface VitalMeta {
  key: keyof VitalsInput;
  label: string;
  unit: string;
  low: number;
  high: number;
  step: number;
  min: number;
  max: number;
}

/** Reference ranges + input bounds for the WHO prehospital vitals, shared by the
 *  capture form and the repeat-vitals flow so both render identically. */
export const VITALS: VitalMeta[] = [
  { key: "hr",          label: "Heart Rate",    unit: "bpm",   low: 60,   high: 100,  step: 1,   min: 0,  max: 300 },
  { key: "rr",          label: "Resp. Rate",    unit: "/min",  low: 12,   high: 20,   step: 1,   min: 0,  max: 60  },
  { key: "bpSystolic",  label: "Systolic BP",   unit: "mmHg",  low: 90,   high: 140,  step: 1,   min: 0,  max: 300 },
  { key: "bpDiastolic", label: "Diastolic BP",  unit: "mmHg",  low: 60,   high: 90,   step: 1,   min: 0,  max: 200 },
  { key: "temp",        label: "Temp",          unit: "°C",    low: 36.1, high: 37.5, step: 0.1, min: 24, max: 45  },
  { key: "spo2",        label: "SpO₂",          unit: "%",     low: 95,   high: 100,  step: 1,   min: 0,  max: 100 },
  { key: "gcs",         label: "GCS Total",     unit: "pts",   low: 13,   high: 15,   step: 1,   min: 3,  max: 15  },
];

export const EMPTY_VITALS: VitalsInput = {
  hr: 0, rr: 0, bpSystolic: 0, bpDiastolic: 0, temp: 0, spo2: 0,
  // GCS defaults to a normal 15 broken out as E4 V5 M6; the total stays derived.
  gcs: 15, gcsEye: 4, gcsVerbal: 5, gcsMotor: 6,
};

function vitalColor(value: number, meta: VitalMeta): string {
  if (value === 0) return C.muted;
  if (value < meta.low || value > meta.high) return C.danger;
  return C.success;
}

/** The 2-column grid of vitals input cards. Stateless — the parent owns the value. */
export function VitalsGrid({ vitals, onChange }: {
  vitals: VitalsInput;
  onChange: (next: VitalsInput) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.625rem" }}>
      {VITALS.filter((v) => v.key !== "gcs").map((v) => (
        <VitalCard
          key={v.key}
          meta={v}
          value={vitals[v.key] ?? 0}
          onChange={(val) => onChange({ ...vitals, [v.key]: val })}
        />
      ))}
      <GcsCard vitals={vitals} onChange={onChange} />
    </div>
  );
}

const GCS_PARTS = [
  { key: "gcsEye" as const,    label: "Eye",    range: GCS_RANGES.eye },
  { key: "gcsVerbal" as const, label: "Verbal", range: GCS_RANGES.verbal },
  { key: "gcsMotor" as const,  label: "Motor",  range: GCS_RANGES.motor },
];

/** GCS captured as E/V/M sub-scores with a derived, colour-coded total. */
function GcsCard({ vitals, onChange }: {
  vitals: VitalsInput;
  onChange: (next: VitalsInput) => void;
}) {
  const total = gcsTotalFromComponents(vitals) ?? vitals.gcs;
  const meta = VITALS.find((m) => m.key === "gcs")!;
  const abnormal = total < meta.low || total > meta.high;

  return (
    <div style={{
      gridColumn: "1 / -1",
      background: abnormal ? "#1c0a0a" : "#162032",
      border: `1px solid ${abnormal ? C.danger : C.border}`,
      borderRadius: 8, padding: "0.625rem 0.75rem",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.4rem" }}>
        <span style={{ fontSize: "0.6875rem", color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>
          GCS
        </span>
        <span style={{ fontSize: "0.875rem", fontWeight: 700, color: abnormal ? C.danger : C.success }}>
          {total} <span style={{ fontSize: "0.6875rem", color: C.muted, fontWeight: 400 }}>/ 15</span>
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        {GCS_PARTS.map((part) => {
          const value = vitals[part.key];
          return (
            <div key={part.key} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <span style={{ fontSize: "0.6875rem", color: C.muted, width: "3.25rem", flexShrink: 0 }}>
                {part.label}
              </span>
              <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                {Array.from({ length: part.range.max - part.range.min + 1 }, (_, i) => part.range.min + i).map((n) => {
                  const selected = value === n;
                  return (
                    <button
                      key={n} type="button"
                      onClick={() => {
                        const next = { ...vitals, [part.key]: n };
                        const t = gcsTotalFromComponents(next);
                        if (t !== undefined) next.gcs = t;
                        onChange(next);
                      }}
                      style={{
                        minWidth: "1.9rem", padding: "0.3rem 0",
                        border: `1px solid ${selected ? C.primary : C.border}`,
                        borderRadius: 6, background: selected ? "#1d3557" : "transparent",
                        color: selected ? C.primary : C.muted,
                        fontFamily: FONT, fontSize: "0.8125rem", fontWeight: selected ? 700 : 400,
                        cursor: "pointer",
                      }}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VitalCard({ meta, value, onChange }: {
  meta: VitalMeta;
  value: number;
  onChange: (v: number) => void;
}) {
  const color = vitalColor(value, meta);
  const isAbnormal = value !== 0 && (value < meta.low || value > meta.high);

  return (
    <div style={{
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
