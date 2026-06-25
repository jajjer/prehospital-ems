/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState, useEffect, useCallback } from "react";
import {
  evaluateSyncHealth,
  type SyncHealthSnapshot,
  type SyncSeverity,
} from "@prehospital-ems/sync-engine";
import { C, FONT } from "./theme.js";
import { SYNC_TELEMETRY_URL } from "./config.js";
import { fetchFleetHealth } from "./fleetHealthClient.js";

interface Props {
  authHeader: string;
}

/** A device that hasn't reported within this window has gone dark — itself a signal. */
const DEVICE_STALE_MS = 10 * 60_000;

const SEVERITY_RANK: Record<SyncSeverity, number> = { ok: 0, warning: 1, critical: 2 };

const SEVERITY_COLOR: Record<SyncSeverity, string> = {
  ok: C.success,
  warning: C.warning,
  critical: C.danger,
};

const SEVERITY_LABEL: Record<SyncSeverity, string> = {
  ok: "Healthy",
  warning: "Warning",
  critical: "Alert",
};

function relativeAge(from: number, now: number): string {
  const ms = Math.max(0, now - from);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface DeviceRow {
  snapshot: SyncHealthSnapshot;
  severity: SyncSeverity;
  reasons: string[];
  stale: boolean;
}

function buildRows(devices: SyncHealthSnapshot[], now: number): DeviceRow[] {
  return devices
    .map((snapshot): DeviceRow => {
      const evaluation = evaluateSyncHealth(snapshot, now);
      const stale = now - snapshot.reportedAt > DEVICE_STALE_MS;
      const reasons = [...evaluation.reasons];
      // A dark device that still had un-synced work last we heard is an alert; a
      // dark idle device (empty queue) is only informational.
      let severity = evaluation.severity;
      if (stale) {
        const hadWork = snapshot.queueDepth > 0 || snapshot.deadLetterCount > 0;
        if (hadWork && SEVERITY_RANK.critical > SEVERITY_RANK[severity]) severity = "critical";
        else if (!hadWork && SEVERITY_RANK.warning > SEVERITY_RANK[severity]) severity = "warning";
        reasons.push(`no check-in for ${relativeAge(snapshot.reportedAt, now)}`);
      }
      return { snapshot, severity, reasons, stale };
    })
    .sort((a, b) => {
      const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (bySeverity !== 0) return bySeverity;
      // Within a severity, surface the oldest pending work first.
      return (a.snapshot.oldestQueuedAt ?? Infinity) - (b.snapshot.oldestQueuedAt ?? Infinity);
    });
}

export function FleetHealth({ authHeader }: Props) {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!SYNC_TELEMETRY_URL) return;
    try {
      const devices = await fetchFleetHealth(SYNC_TELEMETRY_URL, authHeader);
      setRows(buildRows(devices, Date.now()));
      setLastRefresh(new Date());
      setError(null);
    } catch {
      setError("Cannot reach telemetry endpoint");
    } finally {
      setLoaded(true);
    }
  }, [authHeader]);

  useEffect(() => {
    if (!SYNC_TELEMETRY_URL) return;
    void refresh();
    const id = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!SYNC_TELEMETRY_URL) {
    return (
      <div style={{ padding: "3rem 1.5rem", maxWidth: 640, margin: "0 auto", textAlign: "center" }}>
        <p style={{ fontWeight: 600, fontSize: "1rem", marginBottom: "0.5rem" }}>
          Fleet telemetry not configured
        </p>
        <p style={{ color: C.muted, fontSize: "0.875rem", lineHeight: 1.6 }}>
          Set <code style={codeStyle}>VITE_SYNC_TELEMETRY_URL</code> on both the dispatch
          console and the field app to collect per-device sync health. Devices POST PHI-free
          snapshots (queue depth, last-sync time, dead-letter count) and this dashboard reads
          them back.
        </p>
      </div>
    );
  }

  const alerting = rows.filter((r) => r.severity !== "ok").length;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "1rem 1.25rem" }}>
      {/* Summary bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span style={{ fontWeight: 600, fontSize: "0.9375rem" }}>Fleet Health</span>
          {alerting > 0
            ? (
              <span style={{
                background: C.dangerBg, border: `1px solid ${C.danger}`, color: C.danger,
                borderRadius: 6, padding: "0.15rem 0.5rem", fontSize: "0.75rem", fontWeight: 600,
              }}>
                {alerting} device{alerting !== 1 ? "s" : ""} need attention
              </span>
            )
            : rows.length > 0 && (
              <span style={{ color: C.success, fontSize: "0.75rem", fontWeight: 600 }}>
                All {rows.length} device{rows.length !== 1 ? "s" : ""} healthy
              </span>
            )}
        </div>
        <span style={{ color: error ? C.danger : C.muted, fontSize: "0.75rem" }}>
          {error
            ? error
            : lastRefresh && `Updated ${lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`}
        </span>
      </div>

      {loaded && rows.length === 0 && !error && (
        <div style={{ padding: "3rem 1rem", textAlign: "center", color: C.muted, fontSize: "0.875rem" }}>
          No devices have reported yet.
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: C.muted, borderBottom: `1px solid ${C.border}` }}>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Device</th>
                <th style={thStyle}>Queued</th>
                <th style={thStyle}>Oldest unsynced</th>
                <th style={thStyle}>Failed</th>
                <th style={thStyle}>Conflicts</th>
                <th style={thStyle}>Last sync</th>
                <th style={thStyle}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <DeviceRowView key={row.snapshot.deviceId} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DeviceRowView({ row }: { row: DeviceRow }) {
  const { snapshot, severity, reasons } = row;
  const now = Date.now();
  const color = SEVERITY_COLOR[severity];

  return (
    <tr style={{ borderBottom: `1px solid ${C.border}` }}>
      <td style={tdStyle}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block",
          }} />
          <span style={{ color, fontWeight: 600 }}>{SEVERITY_LABEL[severity]}</span>
        </span>
        {reasons.length > 0 && (
          <div style={{ color: C.muted, fontSize: "0.6875rem", marginTop: "0.2rem" }}>
            {reasons.join(" · ")}
          </div>
        )}
      </td>
      <td style={{ ...tdStyle, fontFamily: "monospace", color: C.text }}>
        {snapshot.deviceId.slice(0, 8)}
      </td>
      <td style={{ ...tdStyle, color: snapshot.queueDepth > 0 ? C.warning : C.muted }}>
        {snapshot.queueDepth}
      </td>
      <td style={tdStyle}>
        {snapshot.oldestQueuedAt !== null
          ? relativeAge(snapshot.oldestQueuedAt, now)
          : <span style={{ color: C.muted }}>—</span>}
      </td>
      <td style={{ ...tdStyle, color: snapshot.deadLetterCount > 0 ? C.danger : C.muted, fontWeight: snapshot.deadLetterCount > 0 ? 600 : 400 }}>
        {snapshot.deadLetterCount}
      </td>
      <td style={{ ...tdStyle, color: snapshot.unresolvedConflictCount > 0 ? C.warning : C.muted }}>
        {snapshot.unresolvedConflictCount}
      </td>
      <td style={tdStyle}>
        {snapshot.lastSyncAt !== null
          ? relativeAge(snapshot.lastSyncAt, now)
          : <span style={{ color: C.muted }}>never</span>}
      </td>
      <td style={{ ...tdStyle, color: row.stale ? C.danger : C.muted }}>
        {relativeAge(snapshot.reportedAt, now)}
      </td>
    </tr>
  );
}

const thStyle: React.CSSProperties = {
  padding: "0.5rem 0.625rem", fontWeight: 500, whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "0.625rem", verticalAlign: "top", whiteSpace: "nowrap",
};

const codeStyle: React.CSSProperties = {
  background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4,
  padding: "0.05rem 0.3rem", fontSize: "0.8125rem",
};
