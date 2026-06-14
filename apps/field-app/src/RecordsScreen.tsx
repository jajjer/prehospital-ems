/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState, useEffect } from "react";
import { db, getCaptureStatus, retryDeadLettered, flush, type CaptureLogEntry, type CaptureStatus } from "@prehospital-ems/sync-engine";
import { C, FONT } from "./theme.js";
import type { VitalsInput } from "@prehospital-ems/fhir-contracts";

interface EnrichedEntry extends CaptureLogEntry {
  status: CaptureStatus;
  vitals: VitalsInput;
}

export function RecordsScreen() {
  const [records, setRecords] = useState<EnrichedEntry[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const entries = await db.captureLog.orderBy("capturedAt").reverse().limit(50).toArray();
    const enriched = await Promise.all(
      entries.map(async (e) => ({
        ...e,
        status: await getCaptureStatus(e.mrn),
        vitals: JSON.parse(e.vitalsJson) as VitalsInput,
      }))
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
          />
        ))}
      </div>
    </div>
  );
}

function RecordCard({ record, onRetry }: { record: EnrichedEntry; onRetry: () => void }) {
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const time = new Date(record.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = new Date(record.capturedAt).toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <div
      onClick={() => setOpen((v) => !v)}
      style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 8, padding: "0.75rem 0.875rem",
        cursor: "pointer", transition: "border-color 0.1s",
        borderColor: record.status === "failed" ? C.danger : C.border,
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

      {/* Vitals summary row */}
      <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
        <VitalChip label="HR" value={record.vitals.hr} unit="bpm" low={60} high={100} />
        <VitalChip label="BP" value={record.vitals.bpSystolic === 0 && record.vitals.bpDiastolic === 0 ? 0 : `${record.vitals.bpSystolic}/${record.vitals.bpDiastolic}`} unit="mmHg" />
        <VitalChip label="RR" value={record.vitals.rr} unit="/min" low={12} high={20} />
        {record.vitals.temp > 0 && <VitalChip label="T" value={record.vitals.temp} unit="°C" low={36.1} high={37.5} />}
        <VitalChip label="SpO₂" value={record.vitals.spo2} unit="%" low={95} high={100} />
        <VitalChip label="GCS" value={record.vitals.gcs} unit="" low={13} high={15} />
      </div>

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

      {/* Expanded detail */}
      {open && (
        <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: `1px solid ${C.border}`, fontSize: "0.75rem", color: C.muted }}>
          <div>MRN: <span style={{ color: C.text, fontFamily: "monospace" }}>{record.mrn}</span></div>
          <div style={{ marginTop: "0.25rem" }}>
            Status: <StatusLabel status={record.status} />
          </div>
        </div>
      )}
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
