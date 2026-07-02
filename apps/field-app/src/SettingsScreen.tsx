/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
/**
 * Device settings (issue #14). Admin-entered per-facility runtime config,
 * persisted locally on the device. These overrides win over the deployment's
 * /config.json, the build-time VITE_ vars, and the built-in defaults, so a single
 * device can be re-pointed in the field without rebuilding or touching the server.
 *
 * Reachable BEFORE login (so the OpenMRS base URL can be fixed on a freshly-
 * provisioned device) and after, via the Settings tab. Editing only local config;
 * it never needs the network.
 */
import { useState } from "react";
import { C, FONT } from "./theme.js";
import { useT } from "./i18n/react.js";
import { LanguageSwitcher } from "./LanguageSwitcher.js";
import { EnrollmentSection } from "./EnrollmentSection.js";
import {
  DEFAULT_CONFIG,
  getActiveConfig,
  getAdminOverrides,
  setAdminOverrides,
  clearAdminOverrides,
  type RuntimeConfig,
} from "./config.js";

interface Props {
  /** Render a back/close affordance. */
  onClose: () => void;
}

type FormState = {
  openmrsBaseUrl: string;
  locationUuid: string;
  gcsConceptUuid: string;
  idleLockMinutes: string;
  wipeCheckUrl: string;
  syncTelemetryUrl: string;
};

function formFromOverrides(o: Partial<RuntimeConfig>): FormState {
  return {
    openmrsBaseUrl: o.openmrsBaseUrl ?? "",
    locationUuid: o.locationUuid ?? "",
    gcsConceptUuid: o.gcsConceptUuid ?? "",
    idleLockMinutes: o.idleLockMinutes != null ? String(o.idleLockMinutes) : "",
    wipeCheckUrl: o.wipeCheckUrl ?? "",
    syncTelemetryUrl: o.syncTelemetryUrl ?? "",
  };
}

export function SettingsScreen({ onClose }: Props) {
  const t = useT();
  const [form, setForm] = useState<FormState>(() => formFromOverrides(getAdminOverrides()));
  const [saved, setSaved] = useState(false);
  // What's actually in effect right now (after all layers resolve) — shown as the
  // placeholder/hint so the admin sees the effective value when a field is blank.
  const active = getActiveConfig();

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  function handleSave() {
    // Only persist the fields the admin actually filled in — a blank field means
    // "fall back to config.json / build-time / default", not "set to empty".
    const overrides: Partial<RuntimeConfig> = {};
    if (form.openmrsBaseUrl.trim()) overrides.openmrsBaseUrl = form.openmrsBaseUrl.trim();
    if (form.locationUuid.trim()) overrides.locationUuid = form.locationUuid.trim();
    if (form.gcsConceptUuid.trim()) overrides.gcsConceptUuid = form.gcsConceptUuid.trim();
    const idle = Number(form.idleLockMinutes);
    if (form.idleLockMinutes.trim() && idle > 0) overrides.idleLockMinutes = idle;
    if (form.wipeCheckUrl.trim()) overrides.wipeCheckUrl = form.wipeCheckUrl.trim();
    if (form.syncTelemetryUrl.trim()) overrides.syncTelemetryUrl = form.syncTelemetryUrl.trim();
    setAdminOverrides(overrides);
    setSaved(true);
  }

  function handleReset() {
    clearAdminOverrides();
    setForm(formFromOverrides({}));
    setSaved(true);
  }

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 1rem 2rem", fontFamily: FONT, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>{t("settings.title")}</h2>
        <button onClick={onClose} style={ghostBtn} aria-label={t("common.close")}>{t("common.close")}</button>
      </div>
      <p style={{ color: C.muted, fontSize: "0.8125rem", marginBottom: "1.25rem" }}>
        {t("settings.intro")}
      </p>

      <LanguageSwitcher />

      <EnrollmentSection />

      <h3 style={{ fontSize: "0.875rem", fontWeight: 700, margin: "0 0 0.75rem" }}>{t("settings.manualConfiguration")}</h3>

      <Field
        label={t("settings.openmrsBaseUrl")}
        hint={t("settings.inEffect", { value: active.openmrsBaseUrl })}
        placeholder={DEFAULT_CONFIG.openmrsBaseUrl}
        value={form.openmrsBaseUrl}
        onChange={(v) => set("openmrsBaseUrl", v)}
        autoCapitalize="off"
      />
      <Field
        label={t("settings.locationUuid")}
        hint={t("settings.inEffect", { value: active.locationUuid })}
        placeholder={DEFAULT_CONFIG.locationUuid}
        value={form.locationUuid}
        onChange={(v) => set("locationUuid", v)}
        autoCapitalize="off"
      />
      <Field
        label={t("settings.gcsConceptUuid")}
        hint={t("settings.inEffect", { value: active.gcsConceptUuid })}
        placeholder={DEFAULT_CONFIG.gcsConceptUuid}
        value={form.gcsConceptUuid}
        onChange={(v) => set("gcsConceptUuid", v)}
        autoCapitalize="off"
      />
      <Field
        label={t("settings.idleLockMinutes")}
        hint={t("settings.inEffect", { value: String(active.idleLockMinutes) })}
        placeholder={String(DEFAULT_CONFIG.idleLockMinutes)}
        value={form.idleLockMinutes}
        onChange={(v) => set("idleLockMinutes", v)}
        inputMode="numeric"
      />
      <Field
        label={t("settings.wipeCheckUrl")}
        hint={active.wipeCheckUrl ? t("settings.inEffect", { value: active.wipeCheckUrl }) : t("settings.wipeCheckUnset")}
        placeholder="https://admin.example.org/wipe-check"
        value={form.wipeCheckUrl}
        onChange={(v) => set("wipeCheckUrl", v)}
        autoCapitalize="off"
      />
      <Field
        label={t("settings.syncTelemetryUrl")}
        hint={active.syncTelemetryUrl ? t("settings.inEffect", { value: active.syncTelemetryUrl }) : t("settings.syncTelemetryUnset")}
        placeholder="https://admin.example.org/fleet-health"
        value={form.syncTelemetryUrl}
        onChange={(v) => set("syncTelemetryUrl", v)}
        autoCapitalize="off"
      />

      {/* Receiving facilities are deployment-level config (config.json), not a
          per-device field — the destination is usually unknown at capture time
          and assigned later at handoff. Surface what's configured for clarity. */}
      <div style={{ marginTop: "0.5rem", marginBottom: "1.25rem" }}>
        <span style={labelStyle}>{t("settings.receivingFacilities")}</span>
        <p style={{ color: C.muted, fontSize: "0.75rem", margin: "0.25rem 0 0" }}>
          {active.receivingLocations.length === 0
            ? t("settings.receivingNone")
            : t("settings.receivingSome", {
                count: active.receivingLocations.length,
                names: active.receivingLocations.map((l) => l.name).join(", "),
              })}
        </p>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button onClick={handleSave} style={primaryBtn}>{t("common.save")}</button>
        <button onClick={handleReset} style={ghostBtn}>{t("settings.reset")}</button>
        {saved && <span style={{ color: C.success, fontSize: "0.8125rem" }}>{t("common.saved")}</span>}
      </div>
    </div>
  );
}

function Field(props: {
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  inputMode?: "numeric";
  autoCapitalize?: "off";
}) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <label style={labelStyle}>{props.label}</label>
      <input
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        inputMode={props.inputMode}
        autoCapitalize={props.autoCapitalize}
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
        style={inputStyle}
      />
      <p style={{ color: C.muted, fontSize: "0.6875rem", margin: "0.25rem 0 0" }}>{props.hint}</p>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: "0.75rem", color: C.label, marginBottom: "0.375rem", fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  background: "#162032", border: `1px solid ${C.border}`,
  borderRadius: 6, padding: "0.625rem 0.75rem",
  color: C.text, fontFamily: FONT, fontSize: "0.875rem",
  outline: "none", width: "100%", boxSizing: "border-box",
};
const primaryBtn: React.CSSProperties = {
  background: C.primary, color: "#fff", border: "none", borderRadius: 8,
  padding: "0.625rem 1.25rem", fontSize: "0.875rem", fontWeight: 700,
  cursor: "pointer", fontFamily: FONT,
};
const ghostBtn: React.CSSProperties = {
  background: "none", border: `1px solid ${C.border}`, borderRadius: 6,
  padding: "0.4rem 0.75rem", color: C.muted, fontFamily: FONT,
  fontSize: "0.8125rem", cursor: "pointer",
};
