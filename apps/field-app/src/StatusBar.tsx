/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState, useEffect } from "react";
import { db, getUnresolvedConflictCount } from "@prehospital-ems/sync-engine";
import { C, FONT } from "./theme.js";

interface Props {
  onLogout: () => void;
  onLock: () => void;
}

export function StatusBar({ onLogout, onLock }: Props) {
  const [queueCount, setQueueCount] = useState(0);
  const [deadCount, setDeadCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const refresh = () => {
      void db.writeQueue.count().then(setQueueCount);
      void db.deadLetter.count().then(setDeadCount);
      void getUnresolvedConflictCount().then(setConflictCount);
    };
    refresh();
    const id = setInterval(refresh, 2_000);

    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { clearInterval(id); window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  return (
    <header style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0.75rem 1rem",
      borderBottom: `1px solid ${C.border}`,
      fontFamily: FONT,
      marginBottom: "1.25rem",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span style={{
          background: C.primary, color: "#fff", borderRadius: 4,
          padding: "0.1rem 0.4rem", fontSize: "0.6875rem", fontWeight: 700,
          letterSpacing: "0.08em", textTransform: "uppercase",
        }}>EMS</span>
        <span style={{ fontWeight: 600, fontSize: "0.9375rem", color: C.text }}>
          Field Capture
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", fontSize: "0.75rem" }}>
        {queueCount > 0 && (
          <span style={{ color: C.warning }}>
            {queueCount} queued
          </span>
        )}
        {deadCount > 0 && (
          <span style={{ color: C.danger }}>
            {deadCount} failed
          </span>
        )}
        {conflictCount > 0 && (
          <span style={{ color: C.warning }}>
            {conflictCount} to review
          </span>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%",
            background: online ? C.success : C.danger,
            display: "inline-block",
            boxShadow: online ? `0 0 0 2px #14532d` : `0 0 0 2px #450a0a`,
          }} />
          <span style={{ color: online ? C.success : C.danger, fontWeight: 500 }}>
            {online ? "Live" : "Offline"}
          </span>
        </div>
        <button
          onClick={onLock}
          aria-label="Lock app"
          style={{
            background: "none", border: `1px solid ${C.border}`,
            borderRadius: 4, padding: "0.2rem 0.5rem",
            color: C.muted, fontFamily: FONT, fontSize: "0.6875rem",
            cursor: "pointer", letterSpacing: "0.04em",
          }}
        >
          Lock
        </button>
        <button
          onClick={onLogout}
          style={{
            background: "none", border: `1px solid ${C.border}`,
            borderRadius: 4, padding: "0.2rem 0.5rem",
            color: C.muted, fontFamily: FONT, fontSize: "0.6875rem",
            cursor: "pointer", letterSpacing: "0.04em",
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
