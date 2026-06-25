/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import type { VitalsInput } from "@prehospital-ems/fhir-contracts";
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

export const EMPTY_VITALS: VitalsInput = { hr: 0, rr: 0, bpSystolic: 0, bpDiastolic: 0, temp: 0, spo2: 0, gcs: 15 };

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
      {VITALS.map((v) => (
        <VitalCard
          key={v.key}
          meta={v}
          value={vitals[v.key]}
          onChange={(val) => onChange({ ...vitals, [v.key]: val })}
          fullWidth={v.key === "gcs"}
        />
      ))}
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
