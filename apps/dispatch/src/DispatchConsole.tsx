/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState, useEffect, useCallback } from "react";
import { C, FONT } from "./theme.js";
import { FHIR_BASE, RAPIDPRO_ENABLED } from "./config.js";
import { fetchActiveCalls, type ActiveCall } from "./fhir.js";
import { sendAlert } from "./rapidpro.js";
import { DispatchMap } from "./DispatchMap.js";
import { FleetHealth } from "./FleetHealth.js";

interface Props {
  authHeader: string;
  onLogout: () => void;
}

type View = "calls" | "fleet";

export function DispatchConsole({ authHeader, onLogout }: Props) {
  const [view, setView]             = useState<View>("calls");
  const [calls, setCalls]           = useState<ActiveCall[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const active = await fetchActiveCalls(FHIR_BASE, authHeader);
      setCalls(active);
      setLastRefresh(new Date());
      setError(null);
    } catch {
      setError("Cannot reach OpenMRS");
    }
  }, [authHeader]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: C.bg, fontFamily: FONT, color: C.text }}>

      {/* Header */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0.625rem 1rem", borderBottom: `1px solid ${C.border}`, flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{
            background: C.primary, color: "#fff", borderRadius: 4,
            padding: "0.1rem 0.4rem", fontSize: "0.6875rem", fontWeight: 700,
            letterSpacing: "0.08em", textTransform: "uppercase",
          }}>EMS</span>
          <span style={{ fontWeight: 600, fontSize: "0.9375rem" }}>Dispatch Console</span>

          {/* View toggle */}
          <div style={{ display: "flex", gap: "0.25rem", marginLeft: "0.75rem" }}>
            {(["calls", "fleet"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  background: view === v ? C.surface : "transparent",
                  border: `1px solid ${view === v ? C.border : "transparent"}`,
                  borderRadius: 6, padding: "0.2rem 0.6rem",
                  color: view === v ? C.text : C.muted,
                  fontFamily: FONT, fontSize: "0.75rem", fontWeight: view === v ? 600 : 400,
                  cursor: "pointer",
                }}
              >
                {v === "calls" ? "Calls" : "Fleet health"}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "1rem", fontSize: "0.75rem" }}>
          {view === "calls" && (
            error
              ? <span style={{ color: C.danger }}>{error}</span>
              : lastRefresh && (
                <span style={{ color: C.muted }}>
                  Updated {lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              )
          )}
          {view === "calls" && (
            <span style={{ color: C.muted }}>
              {calls.length} active call{calls.length !== 1 ? "s" : ""}
            </span>
          )}
          <button
            onClick={onLogout}
            style={{
              background: "none", border: `1px solid ${C.border}`, borderRadius: 4,
              padding: "0.2rem 0.5rem", color: C.muted, fontFamily: FONT,
              fontSize: "0.6875rem", cursor: "pointer",
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {view === "fleet" ? (
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <FleetHealth authHeader={authHeader} />
        </div>
      ) : (
      /* Split pane */
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* Left: call list */}
        <div style={{
          width: 320, flexShrink: 0,
          borderRight: `1px solid ${C.border}`,
          overflowY: "auto", display: "flex", flexDirection: "column",
        }}>
          {calls.length === 0
            ? (
              <div style={{ padding: "3rem 1rem", textAlign: "center", color: C.muted, fontSize: "0.875rem" }}>
                {error ? "Check OpenMRS connection." : "No active calls."}
              </div>
            )
            : calls.map((call) => (
              <CallCard
                key={call.encounterId}
                call={call}
                isSelected={selectedId === call.encounterId}
                onClick={() => setSelectedId(call.encounterId === selectedId ? null : call.encounterId)}
              />
            ))
          }
        </div>

        {/* Right: map */}
        <div style={{ flex: 1, position: "relative" }}>
          <DispatchMap
            calls={calls}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
      </div>
      )}
    </div>
  );
}

function CallCard({ call, isSelected, onClick }: {
  call: ActiveCall;
  isSelected: boolean;
  onClick: () => void;
}) {
  const [alerting, setAlerting]     = useState(false);
  const [alertSent, setAlertSent]   = useState(false);
  const [alertError, setAlertError] = useState<string | null>(null);

  const time = new Date(call.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = new Date(call.startTime).toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <div
      onClick={onClick}
      style={{
        padding: "0.875rem 1rem",
        borderBottom: `1px solid ${C.border}`,
        borderLeft: `3px solid ${isSelected ? C.primary : "transparent"}`,
        background: isSelected ? "#1a2744" : "transparent",
        cursor: "pointer",
        transition: "background 0.1s, border-color 0.1s",
      }}
    >
      {/* Top row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.375rem" }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: "0.875rem", color: C.text, fontFamily: "monospace" }}>
            {call.mrn}
          </span>
          <span style={{ color: C.muted, fontSize: "0.75rem", marginLeft: "0.5rem" }}>
            {call.gender === "male" ? "M" : call.gender === "female" ? "F" : "U"}
          </span>
        </div>
        <div style={{ textAlign: "right", fontSize: "0.6875rem", color: C.muted }}>
          <div>{time}</div>
          <div>{date}</div>
        </div>
      </div>

      {/* GPS badge */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: RAPIDPRO_ENABLED ? "0.625rem" : 0 }}>
        <span style={{
          fontSize: "0.6875rem", fontWeight: 600,
          color: call.gps ? C.success : C.muted,
        }}>
          {call.gps
            ? `GPS ${call.gps.lat.toFixed(4)}, ${call.gps.lng.toFixed(4)}`
            : "No GPS"}
        </span>
      </div>

      {/* Alert button */}
      {RAPIDPRO_ENABLED && (
        <div onClick={(e) => e.stopPropagation()}>
          {alertError && (
            <div style={{ color: C.danger, fontSize: "0.6875rem", marginBottom: "0.25rem" }}>{alertError}</div>
          )}
          <button
            disabled={alerting || alertSent}
            onClick={async () => {
              setAlerting(true);
              setAlertError(null);
              try {
                await sendAlert({
                  encounterId: call.encounterId,
                  mrn: call.mrn,
                  gender: call.gender,
                  startTime: call.startTime,
                });
                setAlertSent(true);
              } catch (e) {
                setAlertError(e instanceof Error ? e.message : "Alert failed");
              } finally {
                setAlerting(false);
              }
            }}
            style={{
              width: "100%", padding: "0.35rem",
              background: alertSent ? "#14532d" : "transparent",
              border: `1px solid ${alertSent ? C.success : C.warning}`,
              borderRadius: 6, color: alertSent ? C.success : C.warning,
              fontFamily: FONT, fontSize: "0.6875rem", fontWeight: 600,
              cursor: alerting || alertSent ? "default" : "pointer",
              opacity: alerting ? 0.6 : 1,
              transition: "all 0.15s",
            }}
          >
            {alertSent ? "Responders alerted" : alerting ? "Sending…" : "Alert responders"}
          </button>
        </div>
      )}
    </div>
  );
}
