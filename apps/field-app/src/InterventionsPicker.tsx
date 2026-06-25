/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import {
  INTERVENTION_CATALOG,
  getInterventionConcept,
  type InterventionInput,
  type MedRoute,
} from "@prehospital-ems/fhir-contracts";
import { C, FONT } from "./theme.js";

/** One captured intervention plus a stable local id for list rendering. */
export type SelectedIntervention = InterventionInput & { uid: string };

const ROUTES: MedRoute[] = ["PO", "SL", "IV", "IM", "IO", "IN", "SC", "neb", "PR", "topical"];

const PROCEDURES = INTERVENTION_CATALOG.filter((c) => c.resource === "Procedure");
const MEDICATIONS = INTERVENTION_CATALOG.filter((c) => c.resource === "MedicationAdministration");

/** Strip the local `uid` before handing selections to the FHIR builders. */
export function toInterventionInputs(selected: SelectedIntervention[]): InterventionInput[] {
  return selected.map(({ uid: _uid, ...input }) => input);
}

/**
 * Quick-pick intervention capture. Stateless — the parent owns the list.
 * Tapping a chip appends an entry (medications repeat, so multiple doses are
 * allowed); each selected row can be tweaked or removed. Minimal typing: a
 * single tap records a procedure; medications pre-fill a typical adult dose.
 */
export function InterventionsPicker({ selected, onChange }: {
  selected: SelectedIntervention[];
  onChange: (next: SelectedIntervention[]) => void;
}) {
  function add(key: string) {
    const concept = getInterventionConcept(key);
    if (!concept) return;
    const entry: SelectedIntervention = {
      uid: crypto.randomUUID(),
      key,
      ...(concept.defaultDose !== undefined ? { dose: concept.defaultDose } : {}),
      ...(concept.doseUnit ? { doseUnit: concept.doseUnit } : {}),
      ...(concept.defaultRoute ? { route: concept.defaultRoute } : {}),
    };
    onChange([...selected, entry]);
  }

  function replace(next: SelectedIntervention) {
    onChange(selected.map((s) => (s.uid === next.uid ? next : s)));
  }

  function remove(uid: string) {
    onChange(selected.filter((s) => s.uid !== uid));
  }

  return (
    <div>
      <ChipRow label="Treatments" concepts={PROCEDURES} onAdd={add} />
      <ChipRow label="Medications" concepts={MEDICATIONS} onAdd={add} />

      {selected.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.875rem" }}>
          {selected.map((s) => (
            <SelectedRow key={s.uid} entry={s} onReplace={replace} onRemove={remove} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChipRow({ label, concepts, onAdd }: {
  label: string;
  concepts: readonly { key: string; label: string }[];
  onAdd: (key: string) => void;
}) {
  return (
    <div style={{ marginBottom: "0.625rem" }}>
      <div style={{ fontSize: "0.6875rem", color: C.muted, marginBottom: "0.375rem", fontWeight: 500 }}>
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
        {concepts.map((c) => (
          <button
            key={c.key} type="button"
            onClick={() => onAdd(c.key)}
            style={{
              padding: "0.4rem 0.625rem", border: `1px solid ${C.border}`,
              borderRadius: 16, background: "#162032", color: C.label,
              fontFamily: FONT, fontSize: "0.8125rem", fontWeight: 500,
              cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            + {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectedRow({ entry, onReplace, onRemove }: {
  entry: SelectedIntervention;
  onReplace: (next: SelectedIntervention) => void;
  onRemove: (uid: string) => void;
}) {
  const concept = getInterventionConcept(entry.key);
  const isMed = concept?.resource === "MedicationAdministration";

  function setDose(raw: string) {
    const next = { ...entry };
    if (raw === "") delete next.dose;
    else next.dose = Number(raw);
    onReplace(next);
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "0.5rem",
      background: "#162032", border: `1px solid ${C.border}`,
      borderRadius: 8, padding: "0.5rem 0.625rem",
    }}>
      <span style={{ flex: 1, fontSize: "0.8125rem", fontWeight: 600, color: C.text }}>
        {concept?.label ?? entry.key}
      </span>

      {isMed && (
        <>
          <input
            type="number" inputMode="decimal" aria-label="dose"
            value={entry.dose ?? ""}
            onChange={(e) => setDose(e.target.value)}
            style={{
              width: 56, background: C.surface, border: `1px solid ${C.border}`,
              borderRadius: 6, padding: "0.3rem 0.4rem", color: C.text,
              fontFamily: FONT, fontSize: "0.8125rem", textAlign: "right",
            }}
          />
          <span style={{ fontSize: "0.75rem", color: C.muted, width: 24 }}>{entry.doseUnit}</span>
          <select
            aria-label="route"
            value={entry.route ?? ""}
            onChange={(e) => onReplace({ ...entry, route: e.target.value as MedRoute })}
            style={{
              background: C.surface, border: `1px solid ${C.border}`,
              borderRadius: 6, padding: "0.3rem 0.25rem", color: C.text,
              fontFamily: FONT, fontSize: "0.8125rem",
            }}
          >
            {ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </>
      )}

      <button
        type="button" aria-label={`Remove ${concept?.label ?? entry.key}`}
        onClick={() => onRemove(entry.uid)}
        style={{
          background: "none", border: "none", color: C.muted,
          cursor: "pointer", fontSize: "1rem", padding: "0 0.25rem", flexShrink: 0,
        }}
      >
        ✕
      </button>
    </div>
  );
}
