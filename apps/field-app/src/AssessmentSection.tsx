/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import type { AssessmentInput, AvpuLevel, PupilReactivity } from "@prehospital-ems/fhir-contracts";
import { C, FONT } from "./theme.js";

/**
 * Flat form state for the assessment section. Inputs are held as strings so the
 * fields can be cleared; `toAssessmentInput` converts to the typed, optional-only
 * `AssessmentInput` the builder expects (mirrors InterventionsPicker).
 */
export interface AssessmentForm {
  avpu: AvpuLevel | "";
  painScore: string;
  bloodGlucose: string;
  pupilLeftSize: string;
  pupilLeftReact: PupilReactivity | "";
  pupilRightSize: string;
  pupilRightReact: PupilReactivity | "";
  mechanismOfInjury: string;
  allergies: string;
  medications: string;
  pastHistory: string;
  narrative: string;
}

export const EMPTY_ASSESSMENT: AssessmentForm = {
  avpu: "", painScore: "", bloodGlucose: "",
  pupilLeftSize: "", pupilLeftReact: "", pupilRightSize: "", pupilRightReact: "",
  mechanismOfInjury: "", allergies: "", medications: "", pastHistory: "", narrative: "",
};

const num = (s: string): number | undefined => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
};

/** Build the typed AssessmentInput, omitting empty fields (exactOptionalPropertyTypes). */
export function toAssessmentInput(f: AssessmentForm): AssessmentInput {
  const out: AssessmentInput = {};
  if (f.avpu) out.avpu = f.avpu;
  const pain = num(f.painScore);
  if (pain !== undefined) out.painScore = pain;
  const glucose = num(f.bloodGlucose);
  if (glucose !== undefined) out.bloodGlucose = glucose;

  const leftSize = num(f.pupilLeftSize);
  if (leftSize !== undefined || f.pupilLeftReact) {
    out.pupilLeft = { ...(leftSize !== undefined ? { size: leftSize } : {}), ...(f.pupilLeftReact ? { reactivity: f.pupilLeftReact } : {}) };
  }
  const rightSize = num(f.pupilRightSize);
  if (rightSize !== undefined || f.pupilRightReact) {
    out.pupilRight = { ...(rightSize !== undefined ? { size: rightSize } : {}), ...(f.pupilRightReact ? { reactivity: f.pupilRightReact } : {}) };
  }

  if (f.mechanismOfInjury.trim()) out.mechanismOfInjury = f.mechanismOfInjury.trim();
  if (f.allergies.trim()) out.allergies = f.allergies.trim();
  if (f.medications.trim()) out.medications = f.medications.trim();
  if (f.pastHistory.trim()) out.pastHistory = f.pastHistory.trim();
  if (f.narrative.trim()) out.narrative = f.narrative.trim();
  return out;
}

/** True when nothing has been entered — lets the caller skip enqueuing resources. */
export function isAssessmentEmpty(f: AssessmentForm): boolean {
  return Object.values(f).every((v) => v === "");
}

const AVPU: { value: AvpuLevel; label: string }[] = [
  { value: "A", label: "A" },
  { value: "V", label: "V" },
  { value: "P", label: "P" },
  { value: "U", label: "U" },
];

const REACTIVITY: { value: PupilReactivity; label: string }[] = [
  { value: "brisk", label: "Brisk" },
  { value: "sluggish", label: "Slug." },
  { value: "fixed", label: "Fixed" },
];

export function AssessmentSection({ value, onChange }: {
  value: AssessmentForm;
  onChange: (next: AssessmentForm) => void;
}) {
  const set = <K extends keyof AssessmentForm>(key: K, v: AssessmentForm[K]) =>
    onChange({ ...value, [key]: v });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
      {/* Neuro: AVPU + GCS lives in vitals; here AVPU as a quick gross level */}
      <div>
        <FieldLabel>AVPU — responsiveness</FieldLabel>
        <Segmented
          options={AVPU}
          selected={value.avpu}
          onSelect={(v) => set("avpu", value.avpu === v ? "" : v)}
        />
      </div>

      {/* Pain + glucose */}
      <div style={{ display: "flex", gap: "0.75rem" }}>
        <div style={{ flex: 1 }}>
          <FieldLabel>Pain (0–10)</FieldLabel>
          <input
            type="number" inputMode="numeric" placeholder="—" min={0} max={10}
            value={value.painScore} onChange={(e) => set("painScore", e.target.value)}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <FieldLabel>Glucose (mg/dL)</FieldLabel>
          <input
            type="number" inputMode="numeric" placeholder="—" min={10} max={1000}
            value={value.bloodGlucose} onChange={(e) => set("bloodGlucose", e.target.value)}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Pupils */}
      <div>
        <FieldLabel>Pupils (size mm + reactivity)</FieldLabel>
        <PupilRow
          label="L"
          size={value.pupilLeftSize} reactivity={value.pupilLeftReact}
          onSize={(v) => set("pupilLeftSize", v)}
          onReactivity={(v) => set("pupilLeftReact", value.pupilLeftReact === v ? "" : v)}
        />
        <div style={{ height: "0.4rem" }} />
        <PupilRow
          label="R"
          size={value.pupilRightSize} reactivity={value.pupilRightReact}
          onSize={(v) => set("pupilRightSize", v)}
          onReactivity={(v) => set("pupilRightReact", value.pupilRightReact === v ? "" : v)}
        />
      </div>

      {/* Mechanism of injury */}
      <TextField label="Mechanism of injury" value={value.mechanismOfInjury} onChange={(v) => set("mechanismOfInjury", v)} placeholder="e.g. RTC, fall from height" />

      {/* History / allergies / meds */}
      <TextField label="Allergies" value={value.allergies} onChange={(v) => set("allergies", v)} placeholder="e.g. penicillin, NKDA" />
      <TextField label="Current medications" value={value.medications} onChange={(v) => set("medications", v)} placeholder="e.g. metformin, warfarin" />
      <TextField label="Past medical history" value={value.pastHistory} onChange={(v) => set("pastHistory", v)} placeholder="e.g. T2DM, hypertension" />

      {/* Narrative */}
      <div>
        <FieldLabel>Narrative</FieldLabel>
        <textarea
          placeholder="Free-text account of the call…"
          value={value.narrative} onChange={(e) => set("narrative", e.target.value)}
          maxLength={255} rows={3}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.4 }}
        />
        {value.narrative.length > 200 && (
          <div style={{ fontSize: "0.6875rem", color: value.narrative.length >= 255 ? C.danger : C.muted, textAlign: "right", marginTop: "0.2rem" }}>
            {value.narrative.length}/255
          </div>
        )}
      </div>
    </div>
  );
}

function PupilRow({ label, size, reactivity, onSize, onReactivity }: {
  label: string;
  size: string;
  reactivity: PupilReactivity | "";
  onSize: (v: string) => void;
  onReactivity: (v: PupilReactivity) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
      <span style={{ fontSize: "0.8125rem", color: C.muted, width: "1rem", flexShrink: 0, fontWeight: 600 }}>{label}</span>
      <input
        type="number" inputMode="numeric" placeholder="mm" min={1} max={9} step={0.5}
        value={size} onChange={(e) => onSize(e.target.value)}
        style={{ ...inputStyle, width: "3.5rem", flexShrink: 0 }}
      />
      <Segmented options={REACTIVITY} selected={reactivity} onSelect={onReactivity} />
    </div>
  );
}

function TextField({ label, value, onChange, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        type="text" placeholder={placeholder} maxLength={255}
        value={value} onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    </div>
  );
}

function Segmented<T extends string>({ options, selected, onSelect }: {
  options: { value: T; label: string }[];
  selected: T | "";
  onSelect: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "0.375rem" }}>
      {options.map((o) => {
        const on = selected === o.value;
        return (
          <button
            key={o.value} type="button"
            onClick={() => onSelect(o.value)}
            style={{
              flex: 1, padding: "0.5rem 0",
              border: `1px solid ${on ? C.primary : C.border}`,
              borderRadius: 6, background: on ? "#1d3557" : C.surface,
              color: on ? C.primary : C.muted,
              fontFamily: FONT, fontSize: "0.8125rem", fontWeight: on ? 600 : 400,
              cursor: "pointer", transition: "all 0.1s",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "0.6875rem", color: C.muted, marginBottom: "0.3rem", fontWeight: 500 }}>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#162032", border: `1px solid ${C.border}`,
  borderRadius: 6, padding: "0.5rem 0.625rem",
  color: C.text, fontFamily: FONT, fontSize: "0.9375rem",
  outline: "none", width: "100%", boxSizing: "border-box",
};
