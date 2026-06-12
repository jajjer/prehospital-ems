import { useState } from "react";
import {
  buildProvisionalMrn,
  buildProvisionalPatient,
  buildPrehospitalEncounter,
  buildVitalObservations,
  validateVitals,
  type VitalsInput,
} from "@prehospital-ems/fhir-contracts";
import { enqueue, flush } from "@prehospital-ems/sync-engine";

interface Props {
  onSubmit: () => void;
}

const EMPTY_VITALS: VitalsInput = {
  hr: 0,
  rr: 0,
  bpSystolic: 0,
  spo2: 0,
  gcs: 15,
};

export function CaptureForm({ onSubmit }: Props) {
  const [vitals, setVitals] = useState<VitalsInput>(EMPTY_VITALS);
  const [errors, setErrors] = useState<string[]>([]);

  function handleChange(field: keyof VitalsInput, raw: string) {
    const value = Number(raw);
    setVitals((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const validationErrors = validateVitals(vitals);
    if (validationErrors.length > 0) {
      setErrors(validationErrors.map((e) => e.message));
      return;
    }
    setErrors([]);

    // Build provisional patient + encounter IDs locally
    const mrn = buildProvisionalMrn();
    const provisionalEncounterId = `ENC-${crypto.randomUUID().slice(0, 8)}`;

    const patient = buildProvisionalPatient(mrn);
    // Encounter and observations need server UUIDs — sync-engine resolves
    // from identityMap before POST. For enqueue, we use provisional IDs as
    // placeholder references; resolveReferences() in syncWorker replaces them.
    const encounter = buildPrehospitalEncounter({
      patientServerUUID: mrn, // resolved to server UUID by sync worker
    });
    const observations = buildVitalObservations(vitals, {
      patientServerUUID: mrn,
      encounterServerUUID: provisionalEncounterId,
    });

    // Enqueue in order: Patient → Encounter → Observations
    await enqueue({
      id: crypto.randomUUID(),
      resourceType: "Patient",
      resourceId: mrn,
      body: JSON.stringify(patient),
    });
    await enqueue({
      id: crypto.randomUUID(),
      resourceType: "Encounter",
      resourceId: provisionalEncounterId,
      body: JSON.stringify({ ...encounter, id: provisionalEncounterId }),
      patientId: mrn,
    });
    for (const obs of observations) {
      await enqueue({
        id: crypto.randomUUID(),
        resourceType: "Observation",
        resourceId: crypto.randomUUID(),
        body: JSON.stringify(obs),
        patientId: mrn,
        encounterId: provisionalEncounterId,
      });
    }

    onSubmit();

    // Fire-and-forget flush — if online, sync immediately; if not, the
    // online/visibilitychange listeners in syncWorker will pick it up later.
    void flush();
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      {errors.length > 0 && (
        <ul style={{ color: "#dc2626", marginBottom: "1rem", paddingLeft: "1.25rem" }}>
          {errors.map((err) => <li key={err}>{err}</li>)}
        </ul>
      )}

      <VitalField label="Heart rate (bpm)" value={vitals.hr} onChange={(v) => handleChange("hr", v)} />
      <VitalField label="Respiratory rate (breaths/min)" value={vitals.rr} onChange={(v) => handleChange("rr", v)} />
      <VitalField label="Systolic BP (mmHg)" value={vitals.bpSystolic} onChange={(v) => handleChange("bpSystolic", v)} />
      <VitalField label="SpO2 (%)" value={vitals.spo2} onChange={(v) => handleChange("spo2", v)} />
      <VitalField label="GCS total (3–15)" value={vitals.gcs} onChange={(v) => handleChange("gcs", v)} />

      <button type="submit" style={submitBtn}>
        Save &amp; queue
      </button>
    </form>
  );
}

function VitalField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "block", marginBottom: "0.75rem" }}>
      <span style={{ display: "block", fontSize: "0.75rem", color: "#374151", marginBottom: 4 }}>
        {label}
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "0.5rem",
          border: "1px solid #d1d5db",
          borderRadius: 4,
          fontSize: "1rem",
          boxSizing: "border-box",
        }}
      />
    </label>
  );
}

const submitBtn: React.CSSProperties = {
  width: "100%",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "0.75rem",
  cursor: "pointer",
  fontSize: "1rem",
  marginTop: "0.5rem",
};
