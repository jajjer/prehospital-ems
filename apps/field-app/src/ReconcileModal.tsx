/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState } from "react";
import {
  searchPatientsByMpi, reconcilePatient,
  type MpiCandidate, type ReconcileResult,
} from "@prehospital-ems/sync-engine";
import { FHIR_BASE } from "./config.js";
import { C, FONT } from "./theme.js";
import type { EnrichedEntry } from "./RecordsScreen.js";

/**
 * Reconcile a provisional ("Unknown Patient") record to a confirmed OpenMRS
 * patient. The crew searches the MPI by name, picks the matching identity, and
 * confirms — the encounter and its observations re-point to the confirmed
 * patient server-side, the provisional identifier is preserved for traceability,
 * and the reconciliation is audited. See sync-engine reconciliation.ts.
 */
export function ReconcileModal({ record, authHeader, onClose, onReconciled }: {
  record: EnrichedEntry;
  authHeader: string;
  onClose: () => void;
  onReconciled: () => void;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [results, setResults] = useState<MpiCandidate[]>([]);
  const [selected, setSelected] = useState<MpiCandidate | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch() {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setSelected(null);
    const found = await searchPatientsByMpi(query, FHIR_BASE, authHeader);
    setResults(found);
    setSearched(true);
    setSearching(false);
  }

  async function handleConfirm() {
    if (!selected) return;
    setConfirming(true);
    setError(null);
    const result: ReconcileResult = await reconcilePatient({
      mrn: record.mrn,
      target: selected,
      fhirBaseUrl: FHIR_BASE,
      authHeader,
    });
    if (result === "ok") {
      onReconciled();
      return;
    }
    setError(
      result === "network-error" ? "No connection — try again when online."
      : result === "server-error" ? "Server error re-pointing the record — try again."
      : "This record hasn't synced yet — reconcile after it uploads."
    );
    setConfirming(false);
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 250, padding: "1rem", fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: "1.25rem", width: "100%", maxWidth: 440,
          maxHeight: "90dvh", overflowY: "auto",
        }}
      >
        <p style={{ fontWeight: 700, fontSize: "0.9375rem", marginBottom: "0.25rem", color: C.text }}>
          Reconcile patient identity
        </p>
        <p style={{ color: C.muted, fontSize: "0.8125rem", marginBottom: "1rem", lineHeight: 1.4 }}>
          Find the confirmed record for{" "}
          <span style={{ color: C.text }}>{record.complaint || "this patient"}</span>{" "}
          in OpenMRS. Linking re-points this encounter and its vitals — the
          provisional ID <span style={{ fontFamily: "monospace", color: C.muted }}>{record.mrn}</span> is kept.
        </p>

        {/* Search row */}
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
            placeholder="Name or identifier"
            autoFocus
            style={{
              flex: 1, padding: "0.625rem 0.75rem",
              background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
              color: C.text, fontFamily: FONT, fontSize: "0.875rem", outline: "none",
            }}
          />
          <button
            onClick={() => void handleSearch()}
            disabled={searching || !query.trim()}
            style={{
              padding: "0.625rem 1rem",
              background: searching || !query.trim() ? C.border : C.primary, color: "#fff",
              border: "none", borderRadius: 8,
              fontFamily: FONT, fontSize: "0.875rem", fontWeight: 600,
              cursor: searching || !query.trim() ? "default" : "pointer",
            }}
          >
            {searching ? "…" : "Search"}
          </button>
        </div>

        {/* Results */}
        {searched && !searching && results.length === 0 && (
          <p style={{ color: C.muted, fontSize: "0.8125rem", marginTop: "0.875rem", textAlign: "center" }}>
            No confirmed patients found. Refine the name, or check you're online.
          </p>
        )}

        {results.length > 0 && (
          <div style={{ marginTop: "0.875rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {results.map((c) => {
              const isSel = selected?.uuid === c.uuid;
              return (
                <button
                  key={c.uuid}
                  onClick={() => setSelected(c)}
                  style={{
                    textAlign: "left", padding: "0.625rem 0.75rem",
                    background: isSel ? "#162032" : C.bg,
                    border: `1px solid ${isSel ? C.primary : C.border}`, borderRadius: 8,
                    color: C.text, fontFamily: FONT, cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: "0.875rem", fontWeight: 600 }}>{c.name}</div>
                  <div style={{ fontSize: "0.75rem", color: C.muted, marginTop: "0.15rem" }}>
                    {c.gender === "male" ? "M" : c.gender === "female" ? "F" : "U"}
                    {c.birthDate ? ` · ${c.birthDate}` : ""}
                    {c.identifier ? ` · ${c.identifier}` : ""}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {error && (
          <div style={{ background: C.dangerBg, border: `1px solid ${C.danger}`, borderRadius: 8, padding: "0.625rem 0.875rem", marginTop: "0.875rem" }}>
            <span style={{ color: C.danger, fontSize: "0.8125rem" }}>{error}</span>
          </div>
        )}

        {/* Actions */}
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
            onClick={() => void handleConfirm()}
            disabled={!selected || confirming}
            style={{
              flex: 2, padding: "0.75rem",
              background: !selected || confirming ? C.border : C.primary, color: "#fff",
              border: "none", borderRadius: 8,
              fontFamily: FONT, fontSize: "0.9375rem", fontWeight: 700,
              cursor: !selected || confirming ? "default" : "pointer",
            }}
          >
            {confirming ? "Linking…" : "Confirm match"}
          </button>
        </div>
      </div>
    </div>
  );
}
