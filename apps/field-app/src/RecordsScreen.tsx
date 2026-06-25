/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState, useEffect } from "react";
import {
  getRecentCaptures, getCaptureStatus, retryDeadLettered, flush, finalizeEncounter,
  addVitalsSet, vitalsSeries, enqueue, getConflictsForMrn, resolveConflict,
  type CaptureLogEntry, type CaptureStatus, type VitalsTimePoint,
  type ConflictLogEntry, type ConflictResolution,
} from "@prehospital-ems/sync-engine";
import { buildVitalObservations, validateVitals, type VitalsInput, type AssessmentInput } from "@prehospital-ems/fhir-contracts";
import { C, FONT } from "./theme.js";
import { VITALS, EMPTY_VITALS, VitalsGrid, type VitalMeta } from "./VitalsGrid.js";
import { GCS_CONCEPT_UUID } from "./config.js";

interface EnrichedEntry extends CaptureLogEntry {
  status: CaptureStatus;
  /** Most recent vitals reading — what the summary chips display. */
  vitals: VitalsInput;
  /** Full timestamped series (initial + repeats), oldest first. */
  series: VitalsTimePoint[];
  /** Unresolved sync conflicts for this capture — surfaced for human resolution. */
  conflicts: ConflictLogEntry[];
}

/**
 * Enqueues a repeat vitals set against an existing encounter and records it locally.
 * Reuses the current Patient/Encounter — no new resources are created. Works offline:
 * the Observations reference the provisional ids and resolve via the identity map on flush.
 */
async function submitRepeatVitals(record: EnrichedEntry, vitals: VitalsInput): Promise<void> {
  const capturedAt = Date.now();
  const encounterRef = record.encounterId;
  if (!encounterRef) throw new Error("repeat vitals: capture has no encounter");
  // Joined calls hold the server Patient UUID; own captures use the provisional mrn,
  // which the sync worker resolves to the server UUID via the identity map.
  const patientRef = record.joined ? record.patientRef : record.mrn;
  if (!patientRef) throw new Error("repeat vitals: capture has no patient reference");

  const observations = buildVitalObservations(vitals, {
    patientServerUUID: patientRef,
    encounterServerUUID: encounterRef,
    effectiveTime: new Date(capturedAt).toISOString(),
    gcsConceptUUID: GCS_CONCEPT_UUID,
  });
  for (const obs of observations) {
    await enqueue({
      id: crypto.randomUUID(), resourceType: "Observation",
      resourceId: crypto.randomUUID(), body: JSON.stringify(obs),
      patientId: record.mrn, encounterId: encounterRef,
    });
  }
  await addVitalsSet(record.mrn, JSON.stringify(vitals), capturedAt);
  void flush();
}

export function RecordsScreen() {
  const [records, setRecords] = useState<EnrichedEntry[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const entries = await getRecentCaptures(50);
    const enriched = await Promise.all(
      entries.map(async (e) => {
        const series = vitalsSeries(e);
        const latest = series[series.length - 1]!; // always ≥1 (the initial set)
        return {
          ...e,
          status: await getCaptureStatus(e.mrn),
          vitals: JSON.parse(latest.vitalsJson) as VitalsInput,
          series,
          conflicts: await getConflictsForMrn(e.mrn),
        };
      })
    );
    setRecords(enriched);
    setLoading(false);
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 3_000);
    return () => clearInterval(id);
  }, []);

  if (loading) {
    return <div style={{ padding: "2rem", color: C.muted, fontFamily: FONT, textAlign: "center" }}>Loading…</div>;
  }

  if (records.length === 0) {
    return (
      <div style={{ padding: "3rem 1rem", textAlign: "center", fontFamily: FONT }}>
        <p style={{ color: C.muted, fontSize: "0.9375rem" }}>No captures yet this session.</p>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{ fontSize: "0.6875rem", fontWeight: 700, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.75rem" }}>
        {records.length} record{records.length !== 1 ? "s" : ""}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
        {records.map((r) => (
          <RecordCard
            key={r.mrn}
            record={r}
            onRetry={async () => {
              await retryDeadLettered(r.mrn);
              void flush();
              await load();
            }}
            onChanged={() => void load()}
          />
        ))}
      </div>
    </div>
  );
}

function RecordCard({ record, onRetry, onChanged }: {
  record: EnrichedEntry;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [handingOff, setHandingOff] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [addingVitals, setAddingVitals] = useState(false);
  const time = new Date(record.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = new Date(record.capturedAt).toLocaleDateString([], { month: "short", day: "numeric" });

  // Repeat vitals reuse the existing encounter. Allowed until handoff, and only when we
  // have a patient reference (own captures always do; joined captures need patientRef).
  const canAddVitals = !!record.encounterId && !record.handoffAt
    && (!record.joined || !!record.patientRef);
  const setCount = record.series.length;
  const hasConflict = record.conflicts.length > 0;

  return (
    <div
      onClick={() => setOpen((v) => !v)}
      style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 8, padding: "0.75rem 0.875rem",
        cursor: "pointer", transition: "border-color 0.1s",
        borderColor: record.status === "failed" ? C.danger : hasConflict ? C.warning : C.border,
      }}
    >
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
          <StatusDot status={record.status} />
          <div>
            <span style={{ fontWeight: 600, fontSize: "0.875rem", color: C.text }}>
              {record.complaint || "No complaint"}
            </span>
            <span style={{ color: C.muted, fontSize: "0.75rem", marginLeft: "0.5rem" }}>
              {record.sex === "male" ? "M" : record.sex === "female" ? "F" : "U"}
              {record.approximateAge !== undefined ? ` · ${record.approximateAge}y` : ""}
            </span>
          </div>
        </div>
        <div style={{ textAlign: "right", fontSize: "0.75rem", color: C.muted, flexShrink: 0 }}>
          <div>{time}</div>
          <div>{date}</div>
        </div>
      </div>

      {/* Vitals summary row — shows the most recent reading */}
      <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem", flexWrap: "wrap", alignItems: "baseline" }}>
        <VitalChip label="HR" value={record.vitals.hr} unit="bpm" low={60} high={100} />
        <VitalChip label="BP" value={record.vitals.bpSystolic === 0 && record.vitals.bpDiastolic === 0 ? 0 : `${record.vitals.bpSystolic}/${record.vitals.bpDiastolic}`} unit="mmHg" />
        <VitalChip label="RR" value={record.vitals.rr} unit="/min" low={12} high={20} />
        {record.vitals.temp > 0 && <VitalChip label="T" value={record.vitals.temp} unit="°C" low={36.1} high={37.5} />}
        <VitalChip label="SpO₂" value={record.vitals.spo2} unit="%" low={95} high={100} />
        <VitalChip label="GCS" value={record.vitals.gcs} unit="" low={13} high={15} />
        {setCount > 1 && (
          <span style={{
            fontSize: "0.625rem", fontWeight: 700, color: C.primary,
            background: "#162032", border: `1px solid ${C.border}`,
            borderRadius: 999, padding: "0.05rem 0.4rem", letterSpacing: "0.03em",
          }}>
            {setCount} SETS · LATEST
          </span>
        )}
      </div>

      {/* Conflict banner — a concurrent server edit was detected; needs human review */}
      {hasConflict && (
        <div onClick={(e) => e.stopPropagation()}>
          {record.conflicts.map((c) => (
            <ConflictBanner key={c.id} conflict={c} onResolved={onChanged} />
          ))}
        </div>
      )}

      {/* Retry button — only shown for failed captures */}
      {record.status === "failed" && (
        <div style={{ marginTop: "0.625rem" }} onClick={(e) => e.stopPropagation()}>
          <button
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              await onRetry();
              setRetrying(false);
            }}
            style={{
              width: "100%", padding: "0.4rem",
              background: "transparent",
              border: `1px solid ${C.danger}`,
              borderRadius: 6, color: C.danger,
              fontFamily: FONT, fontSize: "0.75rem", fontWeight: 600,
              cursor: retrying ? "default" : "pointer",
              opacity: retrying ? 0.5 : 1,
              transition: "opacity 0.1s",
            }}
          >
            {retrying ? "Retrying…" : "Retry sync"}
          </button>
        </div>
      )}

      {/* Hand off — only for synced records that have an encounterId and haven't been handed off */}
      {record.status === "synced" && record.encounterId && !record.handoffAt && (
        <div style={{ marginTop: "0.625rem" }} onClick={(e) => e.stopPropagation()}>
          {handoffError && (
            <div style={{ color: C.danger, fontSize: "0.6875rem", marginBottom: "0.375rem" }}>
              {handoffError}
            </div>
          )}
          <button
            disabled={handingOff}
            onClick={async () => {
              setHandingOff(true);
              setHandoffError(null);
              const result = await finalizeEncounter(record.mrn);
              if (result === "ok") {
                onChanged();
              } else if (result === "network-error") {
                setHandoffError("No connection — try again when online.");
              } else if (result === "server-error") {
                setHandoffError("Server error — try again.");
              } else {
                setHandoffError("Encounter not yet synced.");
              }
              setHandingOff(false);
            }}
            style={{
              width: "100%", padding: "0.4rem",
              background: "transparent",
              border: `1px solid ${C.primary}`,
              borderRadius: 6, color: C.primary,
              fontFamily: FONT, fontSize: "0.75rem", fontWeight: 600,
              cursor: handingOff ? "default" : "pointer",
              opacity: handingOff ? 0.5 : 1,
              transition: "opacity 0.1s",
            }}
          >
            {handingOff ? "Handing off…" : "Hand off patient"}
          </button>
        </div>
      )}

      {/* Add vitals — repeat/serial vitals against the same encounter, until handoff */}
      {canAddVitals && (
        <div style={{ marginTop: "0.625rem" }} onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setAddingVitals(true)}
            style={{
              width: "100%", padding: "0.4rem",
              background: "transparent",
              border: `1px solid ${C.border}`,
              borderRadius: 6, color: C.text,
              fontFamily: FONT, fontSize: "0.75rem", fontWeight: 600,
              cursor: "pointer",
            }}
          >
            + Add vitals set
          </button>
        </div>
      )}

      {/* Handed-off confirmation */}
      {record.handoffAt && (
        <div style={{ marginTop: "0.625rem", fontSize: "0.6875rem", color: C.success }} onClick={(e) => e.stopPropagation()}>
          Handed off at {new Date(record.handoffAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      )}

      {/* Expanded detail */}
      {open && (
        <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: `1px solid ${C.border}`, fontSize: "0.75rem", color: C.muted }}>
          {setCount > 1 && <VitalsTrend series={record.series} />}
          <div style={{ marginTop: setCount > 1 ? "0.75rem" : 0 }}>MRN: <span style={{ color: C.text, fontFamily: "monospace" }}>{record.mrn}</span></div>
          <div style={{ marginTop: "0.25rem" }}>
            Status: <StatusLabel status={record.status} />
          </div>
          {record.joined && (
            <div style={{ marginTop: "0.25rem" }}>
              Type: <span style={{ color: C.primary }}>Joined existing call</span>
            </div>
          )}
          <AssessmentDetail vitals={record.vitals} assessmentJson={record.assessmentJson} />
        </div>
      )}

      {/* Add-vitals modal */}
      {addingVitals && (
        <AddVitalsModal
          record={record}
          onClose={() => setAddingVitals(false)}
          onSaved={() => { setAddingVitals(false); onChanged(); }}
        />
      )}
    </div>
  );
}

/**
 * Flowsheet of vitals over time for one encounter — oldest at top, latest at bottom.
 * Out-of-range values render in the danger colour, mirroring the capture form.
 */
function VitalsTrend({ series }: { series: VitalsTimePoint[] }) {
  const rows = series.map((p) => ({
    capturedAt: p.capturedAt,
    v: JSON.parse(p.vitalsJson) as VitalsInput,
  }));
  const metaOf = (key: keyof VitalsInput): VitalMeta => VITALS.find((m) => m.key === key)!;
  const cols: Array<{ label: string; render: (v: VitalsInput) => React.ReactNode; meta?: VitalMeta }> = [
    { label: "HR",   render: (v) => v.hr || "—",   meta: metaOf("hr") },
    { label: "BP",   render: (v) => (v.bpSystolic === 0 && v.bpDiastolic === 0 ? "—" : `${v.bpSystolic}/${v.bpDiastolic}`) },
    { label: "RR",   render: (v) => v.rr || "—",   meta: metaOf("rr") },
    { label: "SpO₂", render: (v) => v.spo2 || "—", meta: metaOf("spo2") },
    { label: "Temp", render: (v) => (v.temp > 0 ? v.temp : "—"), meta: metaOf("temp") },
    { label: "GCS",  render: (v) => v.gcs || "—",  meta: metaOf("gcs") },
  ];
  const th: React.CSSProperties = { textAlign: "right", padding: "0.2rem 0.4rem", color: C.muted, fontWeight: 600 };
  const td: React.CSSProperties = { textAlign: "right", padding: "0.2rem 0.4rem", fontVariantNumeric: "tabular-nums" };
  return (
    <div>
      <div style={{ fontSize: "0.625rem", fontWeight: 700, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.4rem" }}>
        Vitals trend
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: "0.6875rem", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>Time</th>
              {cols.map((c) => <th key={c.label} style={th}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.capturedAt} style={{ borderTop: i === 0 ? "none" : `1px solid ${C.border}` }}>
                <td style={{ ...td, textAlign: "left", color: C.text }}>
                  {new Date(r.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </td>
                {cols.map((c) => {
                  const numeric = c.meta ? (r.v[c.meta.key]) : undefined;
                  const abnormal = c.meta && numeric !== 0 && numeric !== undefined
                    && (numeric < c.meta.low || numeric > c.meta.high);
                  return (
                    <td key={c.label} style={{ ...td, color: abnormal ? C.danger : C.text, fontWeight: abnormal ? 700 : 400 }}>
                      {c.render(r.v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Read-only summary of the expanded assessment captured with a record: the GCS
 * E/V/M breakdown (from the latest vitals) plus the stored assessment fields.
 * Renders nothing when no breakdown and no assessment were captured.
 */
function AssessmentDetail({ vitals, assessmentJson }: {
  vitals: VitalsInput;
  assessmentJson: string | undefined;
}) {
  let a: AssessmentInput | undefined;
  if (assessmentJson) {
    try { a = JSON.parse(assessmentJson) as AssessmentInput; } catch { a = undefined; }
  }
  const hasGcsBreakdown = vitals.gcsEye !== undefined && vitals.gcsVerbal !== undefined && vitals.gcsMotor !== undefined;

  const rows: Array<[string, string]> = [];
  if (hasGcsBreakdown) rows.push(["GCS", `${vitals.gcs} (E${vitals.gcsEye} V${vitals.gcsVerbal} M${vitals.gcsMotor})`]);
  if (a?.avpu) rows.push(["AVPU", a.avpu]);
  if (a?.painScore !== undefined) rows.push(["Pain", `${a.painScore}/10`]);
  if (a?.bloodGlucose !== undefined) rows.push(["Glucose", `${a.bloodGlucose} mg/dL`]);
  const pupil = (e?: { size?: number; reactivity?: string }) =>
    e ? [e.size !== undefined ? `${e.size}mm` : null, e.reactivity].filter(Boolean).join(" ") : "";
  if (a?.pupilLeft || a?.pupilRight) rows.push(["Pupils", `L ${pupil(a.pupilLeft) || "—"} / R ${pupil(a.pupilRight) || "—"}`]);
  if (a?.mechanismOfInjury) rows.push(["MOI", a.mechanismOfInjury]);
  if (a?.allergies) rows.push(["Allergies", a.allergies]);
  if (a?.medications) rows.push(["Meds", a.medications]);
  if (a?.pastHistory) rows.push(["PMH", a.pastHistory]);
  if (a?.narrative) rows.push(["Narrative", a.narrative]);

  if (rows.length === 0) return null;

  return (
    <div style={{ marginTop: "0.625rem", paddingTop: "0.625rem", borderTop: `1px solid ${C.border}` }}>
      <div style={{ fontSize: "0.625rem", fontWeight: 700, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.4rem" }}>
        Assessment
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        {rows.map(([label, val]) => (
          <div key={label} style={{ display: "flex", gap: "0.5rem" }}>
            <span style={{ color: C.muted, flexShrink: 0, minWidth: "4rem" }}>{label}</span>
            <span style={{ color: C.text }}>{val}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddVitalsModal({ record, onClose, onSaved }: {
  record: EnrichedEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [vitals, setVitals] = useState<VitalsInput>(EMPTY_VITALS);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const errs = validateVitals(vitals).map((e) => e.message);
    if (errs.length > 0) { setErrors(errs); return; }
    setErrors([]);
    setSaving(true);
    try {
      await submitRepeatVitals(record, vitals);
      onSaved();
    } catch {
      setErrors(["Could not save vitals. Try again."]);
      setSaving(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 200, padding: "1rem", fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: "1.25rem", width: "100%", maxWidth: 420,
          maxHeight: "90dvh", overflowY: "auto",
        }}
      >
        <p style={{ fontWeight: 700, fontSize: "0.9375rem", marginBottom: "0.25rem", color: C.text }}>
          Add vitals set
        </p>
        <p style={{ color: C.muted, fontSize: "0.8125rem", marginBottom: "1rem" }}>
          New timestamped reading for {record.complaint || "this patient"} — same encounter, no new record.
        </p>

        <VitalsGrid vitals={vitals} onChange={setVitals} />

        {errors.length > 0 && (
          <div style={{ background: C.dangerBg, border: `1px solid ${C.danger}`, borderRadius: 8, padding: "0.625rem 0.875rem", marginTop: "0.875rem" }}>
            {errors.map((e) => (
              <div key={e} style={{ color: C.danger, fontSize: "0.8125rem" }}>• {e}</div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: "0.625rem", marginTop: "1rem" }}>
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: "0.75rem", background: "transparent",
              border: `1px solid ${C.border}`, borderRadius: 8, color: C.muted,
              fontFamily: FONT, fontSize: "0.875rem", fontWeight: 500, cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            style={{
              flex: 2, padding: "0.75rem",
              background: saving ? C.border : C.primary, color: "#fff",
              border: "none", borderRadius: 8,
              fontFamily: FONT, fontSize: "0.9375rem", fontWeight: 700,
              cursor: saving ? "default" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save & Queue"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Surfaces an unresolved sync conflict: a matching record already existed on the
 * server (created/edited concurrently by another responder or the facility), so this
 * device's demographics were not applied. The responder reviews and records a
 * decision — the choice is persisted to the audit trail, never auto-overwritten.
 */
function ConflictBanner({ conflict, onResolved }: {
  conflict: ConflictLogEntry;
  onResolved: () => void;
}) {
  const [resolving, setResolving] = useState(false);
  const detected = new Date(conflict.detectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  async function resolve(resolution: ConflictResolution) {
    setResolving(true);
    await resolveConflict(conflict.id, resolution);
    onResolved();
  }

  const btn = (border: string, color: string): React.CSSProperties => ({
    flex: 1, padding: "0.4rem", background: "transparent",
    border: `1px solid ${border}`, borderRadius: 6, color,
    fontFamily: FONT, fontSize: "0.75rem", fontWeight: 600,
    cursor: resolving ? "default" : "pointer", opacity: resolving ? 0.5 : 1,
  });

  return (
    <div style={{
      marginTop: "0.625rem", padding: "0.625rem 0.75rem",
      background: "#2a1e05", border: `1px solid ${C.warning}`, borderRadius: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.3rem" }}>
        <span style={{ color: C.warning, fontSize: "0.75rem", fontWeight: 700 }}>⚠ Needs review</span>
        <span style={{ color: C.muted, fontSize: "0.6875rem" }}>· detected {detected}</span>
      </div>
      <p style={{ color: C.text, fontSize: "0.75rem", lineHeight: 1.4, margin: "0 0 0.5rem" }}>
        A matching {conflict.resourceType} already existed on the server, created or edited by
        another responder or the facility. This device's details were not applied — your captured
        vitals and notes still attach to that patient. Choose how to resolve:
      </p>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button disabled={resolving} onClick={() => void resolve("kept-server")} style={btn(C.border, C.text)}>
          Keep server record
        </button>
        <button disabled={resolving} onClick={() => void resolve("kept-local")} style={btn(C.warning, C.warning)}>
          Re-enter my details
        </button>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: CaptureStatus }) {
  const color = status === "synced" ? C.success : status === "failed" ? C.danger : C.warning;
  return (
    <span style={{
      width: 8, height: 8, borderRadius: "50%", background: color,
      display: "inline-block", flexShrink: 0,
    }} />
  );
}

function StatusLabel({ status }: { status: CaptureStatus }) {
  if (status === "synced") return <span style={{ color: C.success }}>Synced</span>;
  if (status === "failed") return <span style={{ color: C.danger }}>Sync failed</span>;
  return <span style={{ color: C.warning }}>Queued</span>;
}

function VitalChip({
  label, value, unit, low, high,
}: {
  label: string;
  value: number | string;
  unit: string;
  low?: number;
  high?: number;
}) {
  const numVal = typeof value === "number" ? value : undefined;
  const abnormal = numVal !== undefined && low !== undefined && high !== undefined
    && numVal !== 0 && (numVal < low || numVal > high);
  const color = numVal === 0 ? C.muted : abnormal ? C.danger : C.text;

  return (
    <div style={{ fontSize: "0.6875rem" }}>
      <span style={{ color: C.muted }}>{label} </span>
      <span style={{ color, fontWeight: 600 }}>{value === 0 ? "—" : value}</span>
      {unit && <span style={{ color: C.muted }}>{unit}</span>}
    </div>
  );
}
