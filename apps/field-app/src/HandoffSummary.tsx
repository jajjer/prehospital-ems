/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState, useEffect } from "react";
import {
  finalizeEncounter, getServerEncounterId,
  type VitalsTimePoint,
} from "@prehospital-ems/sync-engine";
import {
  getInterventionConcept,
  type VitalsInput, type AssessmentInput, type InterventionInput,
} from "@prehospital-ems/fhir-contracts";
import { QrCode, Ecc } from "./qrcodegen.js";
import { FHIR_BASE } from "./config.js";
import { VITALS, type VitalMeta } from "./VitalsGrid.js";
import { FONT } from "./theme.js";
import type { EnrichedEntry } from "./RecordsScreen.js";

/**
 * The receiving-facility handoff summary: a clean, printable "document" view of
 * everything captured for one encounter — demographics, complaint, vitals trend,
 * interventions, GCS and the full assessment — plus a QR code linking to the FHIR
 * Encounter so the facility can pull the record. The clinician confirms handoff
 * here, which finalizes the encounter in OpenMRS (status → finished, period.end).
 *
 * Rendered as a white sheet on a dark backdrop: print-friendly by construction
 * (no dark-theme overrides needed) and isolated for `window.print()` via the
 * `#handoff-sheet` id below.
 */

// Print-document palette — deliberately light/high-contrast, independent of the
// app's dark theme so the sheet reads on paper as well as on screen.
const S = {
  bg: "#ffffff",
  text: "#0f172a",
  muted: "#475569",
  faint: "#94a3b8",
  line: "#e2e8f0",
  danger: "#b91c1c",
  accent: "#1d4ed8",
  ok: "#15803d",
} as const;

const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  #handoff-sheet, #handoff-sheet * { visibility: visible !important; }
  #handoff-sheet {
    position: absolute !important; left: 0 !important; top: 0 !important;
    width: 100% !important; max-width: none !important;
    margin: 0 !important; padding: 16px !important;
    box-shadow: none !important; border: none !important; border-radius: 0 !important;
  }
  .handoff-noprint { display: none !important; }
}
`;

export function HandoffSummary({ record, onClose, onChanged }: {
  record: EnrichedEntry;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [encounterUrl, setEncounterUrl] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve the server Encounter UUID into an absolute URL the facility can scan.
  // FHIR_BASE may be relative (the dev proxy) — resolve it against the origin.
  useEffect(() => {
    let cancelled = false;
    void getServerEncounterId(record.mrn).then((uuid) => {
      if (cancelled || !uuid) return;
      const base = new URL(FHIR_BASE, window.location.origin).href.replace(/\/$/, "");
      setEncounterUrl(`${base}/Encounter/${uuid}`);
    });
    return () => { cancelled = true; };
  }, [record.mrn]);

  async function handleFinalize() {
    setFinalizing(true);
    setError(null);
    const result = await finalizeEncounter(record.mrn);
    if (result === "ok") {
      onChanged();
    } else if (result === "network-error") {
      setError("No connection — try again when online.");
    } else if (result === "server-error") {
      setError("Server error — try again.");
    } else {
      setError("Encounter not yet synced.");
    }
    setFinalizing(false);
  }

  async function handleShare() {
    const text = buildShareText(record, encounterUrl);
    try {
      if (navigator.share) {
        await navigator.share({ title: "EMS handoff summary", text });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
    } catch { /* user dismissed the share/copy — nothing to recover */ }
  }

  const captured = new Date(record.capturedAt);
  const interventions = parseInterventions(record.interventionsJson);
  const assessment = parseAssessment(record.assessmentJson);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        zIndex: 300, padding: "1rem", overflowY: "auto", fontFamily: FONT,
      }}
    >
      <style>{PRINT_CSS}</style>

      {/* Close — floats over the backdrop, never printed */}
      <button
        className="handoff-noprint"
        onClick={onClose}
        aria-label="Close handoff summary"
        style={{
          position: "fixed", top: "1rem", right: "1rem",
          background: "rgba(255,255,255,0.1)", border: "none", color: "#fff",
          width: 36, height: 36, borderRadius: "50%", fontSize: "1.1rem",
          cursor: "pointer", fontFamily: FONT, zIndex: 301,
        }}
      >
        ✕
      </button>

      <div
        id="handoff-sheet"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: S.bg, color: S.text, borderRadius: 10,
          width: "100%", maxWidth: 560, padding: "1.5rem",
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        }}
      >
        {/* Header: title + QR */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
          <div>
            <div style={{ fontSize: "0.6875rem", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: S.accent }}>
              Prehospital handoff
            </div>
            <h2 style={{ margin: "0.25rem 0 0", fontSize: "1.25rem", color: S.text }}>
              {record.complaint || "No complaint recorded"}
            </h2>
            <div style={{ marginTop: "0.25rem", fontSize: "0.875rem", color: S.muted }}>
              {demographics(record)}
            </div>
          </div>
          {encounterUrl && (
            <div style={{ textAlign: "center", flexShrink: 0 }}>
              <QrSvg text={encounterUrl} />
              <div style={{ fontSize: "0.5625rem", color: S.faint, marginTop: 2, letterSpacing: "0.04em" }}>
                SCAN FOR RECORD
              </div>
            </div>
          )}
        </div>

        {/* Timeline */}
        <div style={{
          display: "flex", flexWrap: "wrap", gap: "0.25rem 1.5rem",
          margin: "1rem 0", paddingBottom: "1rem", borderBottom: `1px solid ${S.line}`,
          fontSize: "0.8125rem", color: S.muted,
        }}>
          <Field label="Captured" value={`${captured.toLocaleDateString([], { month: "short", day: "numeric" })} ${captured.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`} />
          {record.handoffAt
            ? <Field label="Handed off" value={new Date(record.handoffAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} valueColor={S.ok} />
            : <Field label="Status" value="In transport" />}
          {record.joined && <Field label="Type" value="Joined existing call" />}
        </div>

        <VitalsTable series={record.series} />

        <GcsBlock vitals={latestVitals(record)} />

        {interventions.length > 0 && (
          <Section title="Interventions / treatments">
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {interventions.map((iv, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", fontSize: "0.8125rem" }}>
                  <span style={{ color: S.text }}>
                    <strong style={{ fontWeight: 600 }}>{iv.label}</strong>
                    {iv.detail && <span style={{ color: S.muted }}> · {iv.detail}</span>}
                    {iv.note && <span style={{ color: S.muted }}> — {iv.note}</span>}
                  </span>
                  {iv.time && <span style={{ color: S.faint, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{iv.time}</span>}
                </div>
              ))}
            </div>
          </Section>
        )}

        <AssessmentBlock assessment={assessment} vitals={latestVitals(record)} />

        {/* Actions — never printed */}
        <div className="handoff-noprint" style={{ marginTop: "1.5rem", paddingTop: "1rem", borderTop: `1px solid ${S.line}` }}>
          {error && (
            <div style={{ color: S.danger, fontSize: "0.8125rem", marginBottom: "0.75rem" }}>{error}</div>
          )}
          <div style={{ display: "flex", gap: "0.625rem", flexWrap: "wrap" }}>
            <button onClick={() => window.print()} style={secondaryBtn}>Print</button>
            <button onClick={() => void handleShare()} style={secondaryBtn}>Share</button>
            {record.handoffAt ? (
              <div style={{ flex: 2, minWidth: 160, display: "flex", alignItems: "center", justifyContent: "center", color: S.ok, fontWeight: 600, fontSize: "0.875rem" }}>
                ✓ Handed off
              </div>
            ) : (
              <button
                onClick={() => void handleFinalize()}
                disabled={finalizing}
                style={{
                  flex: 2, minWidth: 160, padding: "0.75rem",
                  background: finalizing ? S.faint : S.accent, color: "#fff",
                  border: "none", borderRadius: 8,
                  fontFamily: FONT, fontSize: "0.9375rem", fontWeight: 700,
                  cursor: finalizing ? "default" : "pointer",
                }}
              >
                {finalizing ? "Finalizing…" : "Confirm handoff"}
              </button>
            )}
          </div>
          {!record.handoffAt && (
            <p style={{ color: S.faint, fontSize: "0.75rem", margin: "0.625rem 0 0", textAlign: "center" }}>
              Confirming marks the encounter finished in OpenMRS and records the handoff time.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const secondaryBtn: React.CSSProperties = {
  flex: 1, minWidth: 96, padding: "0.75rem",
  background: "transparent", border: `1px solid ${S.line}`, borderRadius: 8,
  color: S.muted, fontFamily: FONT, fontSize: "0.875rem", fontWeight: 600, cursor: "pointer",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: "1rem" }}>
      <div style={{ fontSize: "0.625rem", fontWeight: 700, color: S.faint, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.5rem" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <span>
      <span style={{ color: S.faint }}>{label}: </span>
      <span style={{ color: valueColor ?? S.text, fontWeight: 600 }}>{value}</span>
    </span>
  );
}

/** Vitals flowsheet, oldest → newest. Out-of-range cells render in the danger colour. */
function VitalsTable({ series }: { series: VitalsTimePoint[] }) {
  const rows = series.map((p) => ({ at: p.capturedAt, v: JSON.parse(p.vitalsJson) as VitalsInput }));
  const meta = (key: keyof VitalsInput): VitalMeta | undefined => VITALS.find((m) => m.key === key);
  const cols: Array<{ label: string; render: (v: VitalsInput) => React.ReactNode; key?: keyof VitalsInput }> = [
    { label: "HR",   render: (v) => v.hr || "—",   key: "hr" },
    { label: "BP",   render: (v) => (v.bpSystolic === 0 && v.bpDiastolic === 0 ? "—" : `${v.bpSystolic}/${v.bpDiastolic}`) },
    { label: "RR",   render: (v) => v.rr || "—",   key: "rr" },
    { label: "SpO₂", render: (v) => v.spo2 || "—", key: "spo2" },
    { label: "Temp", render: (v) => (v.temp > 0 ? v.temp : "—"), key: "temp" },
    { label: "GCS",  render: (v) => v.gcs || "—",  key: "gcs" },
  ];
  const th: React.CSSProperties = { textAlign: "right", padding: "0.25rem 0.5rem", color: S.muted, fontWeight: 600, borderBottom: `1px solid ${S.line}` };
  const td: React.CSSProperties = { textAlign: "right", padding: "0.25rem 0.5rem", fontVariantNumeric: "tabular-nums", color: S.text };
  return (
    <Section title={series.length > 1 ? `Vitals — ${series.length} sets` : "Vitals"}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: "0.8125rem", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>Time</th>
              {cols.map((c) => <th key={c.label} style={th}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.at}>
                <td style={{ ...td, textAlign: "left", color: S.muted }}>
                  {new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </td>
                {cols.map((c) => {
                  const m = c.key ? meta(c.key) : undefined;
                  const n = c.key ? r.v[c.key] : undefined;
                  const abnormal = m && typeof n === "number" && n !== 0 && (n < m.low || n > m.high);
                  return (
                    <td key={c.label} style={{ ...td, color: abnormal ? S.danger : S.text, fontWeight: abnormal ? 700 : 400 }}>
                      {c.render(r.v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** GCS with the E/V/M breakdown when components were captured. */
function GcsBlock({ vitals }: { vitals: VitalsInput }) {
  const hasBreakdown = vitals.gcsEye !== undefined && vitals.gcsVerbal !== undefined && vitals.gcsMotor !== undefined;
  if (!vitals.gcs && !hasBreakdown) return null;
  return (
    <Section title="Glasgow Coma Scale">
      <div style={{ fontSize: "0.875rem", color: S.text }}>
        <strong style={{ fontWeight: 700 }}>{vitals.gcs || "—"}</strong>
        {hasBreakdown && <span style={{ color: S.muted }}> (E{vitals.gcsEye} V{vitals.gcsVerbal} M{vitals.gcsMotor})</span>}
      </div>
    </Section>
  );
}

/** The remaining assessment fields (AVPU, pain, glucose, pupils, MOI, history, narrative). */
function AssessmentBlock({ assessment, vitals }: { assessment: AssessmentInput | undefined; vitals: VitalsInput }) {
  void vitals; // GCS is rendered separately by GcsBlock
  const a = assessment;
  if (!a) return null;
  const pupil = (e?: { size?: number; reactivity?: string }) =>
    e ? [e.size !== undefined ? `${e.size}mm` : null, e.reactivity].filter(Boolean).join(" ") : "";
  const rows: Array<[string, string]> = [];
  if (a.avpu) rows.push(["AVPU", a.avpu]);
  if (a.painScore !== undefined) rows.push(["Pain", `${a.painScore}/10`]);
  if (a.bloodGlucose !== undefined) rows.push(["Glucose", `${a.bloodGlucose} mg/dL`]);
  if (a.pupilLeft || a.pupilRight) rows.push(["Pupils", `L ${pupil(a.pupilLeft) || "—"} / R ${pupil(a.pupilRight) || "—"}`]);
  if (a.mechanismOfInjury) rows.push(["MOI", a.mechanismOfInjury]);
  if (a.allergies) rows.push(["Allergies", a.allergies]);
  if (a.medications) rows.push(["Meds", a.medications]);
  if (a.pastHistory) rows.push(["PMH", a.pastHistory]);
  if (a.narrative) rows.push(["Narrative", a.narrative]);
  if (rows.length === 0) return null;
  return (
    <Section title="Assessment">
      <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
        {rows.map(([label, val]) => (
          <div key={label} style={{ display: "flex", gap: "0.75rem", fontSize: "0.8125rem" }}>
            <span style={{ color: S.faint, flexShrink: 0, minWidth: "4.5rem" }}>{label}</span>
            <span style={{ color: S.text }}>{val}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** Renders a QR code for `text` as a crisp, scalable SVG (no canvas, fully offline). */
function QrSvg({ text, size = 116 }: { text: string; size?: number }) {
  const qr = QrCode.encodeText(text, Ecc.MEDIUM);
  const n = qr.size;
  const border = 2;
  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.getModule(x, y)) path += `M${x + border},${y + border}h1v1h-1z`;
    }
  }
  const dim = n + border * 2;
  return (
    <svg
      width={size} height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      role="img" aria-label="Encounter QR code"
      style={{ background: "#fff", display: "block" }}
    >
      <path d={path} fill="#000" shapeRendering="crispEdges" />
    </svg>
  );
}

/*---- pure helpers (exported for testing) ----*/

export function latestVitals(record: EnrichedEntry): VitalsInput {
  const latest = record.series[record.series.length - 1];
  return latest ? (JSON.parse(latest.vitalsJson) as VitalsInput) : (JSON.parse(record.vitalsJson) as VitalsInput);
}

function demographics(record: EnrichedEntry): string {
  const sex = record.sex === "male" ? "Male" : record.sex === "female" ? "Female" : "Unknown sex";
  const age = record.approximateAge !== undefined ? `, ~${record.approximateAge}y` : "";
  return `${sex}${age}`;
}

export interface FormattedIntervention {
  label: string;
  detail: string;
  note: string;
  time: string;
}

/** Parses the stored intervention list into print-ready rows. Resilient to bad JSON. */
export function parseInterventions(json: string | undefined): FormattedIntervention[] {
  if (!json) return [];
  let raw: InterventionInput[];
  try { raw = JSON.parse(json) as InterventionInput[]; } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.map((iv) => {
    const concept = getInterventionConcept(iv.key);
    const dose = iv.dose !== undefined
      ? `${iv.dose}${iv.doseUnit ?? concept?.doseUnit ?? ""}${iv.route ?? concept?.defaultRoute ? ` ${iv.route ?? concept?.defaultRoute}` : ""}`
      : "";
    let time = "";
    if (iv.time) {
      const d = new Date(iv.time);
      if (!Number.isNaN(d.getTime())) time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return {
      label: concept?.label ?? iv.key,
      detail: dose,
      note: iv.note ?? "",
      time,
    };
  });
}

function parseAssessment(json: string | undefined): AssessmentInput | undefined {
  if (!json) return undefined;
  try { return JSON.parse(json) as AssessmentInput; } catch { return undefined; }
}

/** Builds a plain-text handoff summary for the Share/clipboard action. */
export function buildShareText(record: EnrichedEntry, encounterUrl: string | null): string {
  const v = latestVitals(record);
  const lines = [
    `PREHOSPITAL HANDOFF`,
    `${record.complaint || "No complaint"} — ${demographics(record)}`,
    `Captured ${new Date(record.capturedAt).toLocaleString()}`,
    ``,
    `Latest vitals: HR ${v.hr || "—"}, BP ${v.bpSystolic || "—"}/${v.bpDiastolic || "—"}, RR ${v.rr || "—"}, SpO2 ${v.spo2 || "—"}%, GCS ${v.gcs || "—"}`,
  ];
  const interventions = parseInterventions(record.interventionsJson);
  if (interventions.length > 0) {
    lines.push(``, `Interventions: ${interventions.map((i) => i.label + (i.detail ? ` (${i.detail})` : "")).join(", ")}`);
  }
  if (encounterUrl) lines.push(``, `Record: ${encounterUrl}`);
  return lines.join("\n");
}
