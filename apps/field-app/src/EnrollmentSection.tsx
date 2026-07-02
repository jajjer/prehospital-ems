/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
/**
 * Fleet enrollment (issue #15). The provisioning half of Device settings: enroll
 * this device with a fleet provisioning service so it pulls its configuration —
 * OpenMRS base, location/concept UUIDs, and its remote-wipe / telemetry endpoints
 * — from one central place instead of being hand-configured. Once enrolled, the
 * device refreshes its config on every boot; ops can re-point the whole fleet by
 * editing it server-side.
 *
 * Reachable before sign-in (via the Device settings link on the login screen), so
 * a brand-new device can be enrolled and configured before it can even log in.
 */
import { useEffect, useState } from "react";
import { getDeviceId } from "@prehospital-ems/sync-engine";
import { C, FONT } from "./theme.js";
import { useT } from "./i18n/react.js";
import {
  enrollDevice,
  refreshDeviceConfig,
  unenrollDevice,
  getEnrollment,
  type Enrollment,
} from "./provisioning.js";

type Msg = { kind: "ok" | "err"; text: string } | null;

export function EnrollmentSection() {
  const t = useT();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(() => getEnrollment());
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  // The opaque per-device id is generated on first use and doubles as the address
  // for telemetry and remote wipe (issues #10 / #2) — show it so an admin can
  // register the device server-side and correlate it in the fleet dashboard.
  useEffect(() => {
    let cancelled = false;
    void getDeviceId().then((id) => { if (!cancelled) setDeviceId(id); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  async function handleEnroll() {
    if (!deviceId || busy) return;
    setBusy(true);
    setMsg(null);
    const res = await enrollDevice({ provisioningUrl: url, enrollmentCode: code, label, deviceId });
    setBusy(false);
    if (res.ok) {
      setEnrollment(getEnrollment());
      setMsg({ kind: "ok", text: t("enroll.okEnrolled") });
      setUrl(""); setCode(""); setLabel("");
    } else {
      setMsg({ kind: "err", text: res.error ?? t("enroll.errEnroll") });
    }
  }

  async function handleRefresh() {
    if (!deviceId || busy) return;
    setBusy(true);
    setMsg(null);
    const ok = await refreshDeviceConfig({ deviceId });
    setBusy(false);
    setMsg(ok
      ? { kind: "ok", text: t("enroll.okRefreshed") }
      : { kind: "err", text: t("enroll.errRefresh") });
  }

  function handleUnenroll() {
    unenrollDevice();
    setEnrollment(null);
    setMsg({ kind: "ok", text: t("enroll.okUnenrolled") });
  }

  return (
    <div style={cardStyle}>
      <h3 style={{ fontSize: "0.875rem", fontWeight: 700, margin: "0 0 0.25rem" }}>{t("enroll.title")}</h3>
      <p style={{ color: C.muted, fontSize: "0.75rem", margin: "0 0 1rem" }}>
        {t("enroll.intro")}
      </p>

      {deviceId && (
        <div style={{ marginBottom: "1rem" }}>
          <span style={labelStyle}>{t("enroll.deviceId")}</span>
          <code style={idStyle}>{deviceId}</code>
          <p style={{ color: C.muted, fontSize: "0.6875rem", margin: "0.25rem 0 0" }}>
            {t("enroll.deviceIdHint")}
          </p>
        </div>
      )}

      {enrollment ? (
        <>
          <Row
            label={t("enroll.statusLabel")}
            value={enrollment.deviceLabel ? t("enroll.statusEnrolledAs", { label: enrollment.deviceLabel }) : t("enroll.statusEnrolled")}
          />
          {enrollment.fleetId && <Row label={t("enroll.fleet")} value={enrollment.fleetId} />}
          <Row label={t("enroll.service")} value={enrollment.provisioningUrl} />
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginTop: "1rem", flexWrap: "wrap" }}>
            <button onClick={() => void handleRefresh()} disabled={busy} style={primaryBtn}>
              {busy ? t("enroll.checking") : t("enroll.checkUpdate")}
            </button>
            <button onClick={handleUnenroll} disabled={busy} style={ghostBtn}>{t("enroll.unenroll")}</button>
          </div>
        </>
      ) : (
        <>
          <EnrollField
            label={t("enroll.serviceUrl")}
            placeholder="https://fleet.example.org/provision"
            value={url}
            onChange={setUrl}
          />
          <EnrollField
            label={t("enroll.code")}
            placeholder="e.g. MEDIC-2026"
            value={code}
            onChange={setCode}
          />
          <EnrollField
            label={t("enroll.label")}
            placeholder="e.g. Medic-7"
            value={label}
            onChange={setLabel}
          />
          <button
            onClick={() => void handleEnroll()}
            disabled={busy || !deviceId || !url.trim()}
            style={{ ...primaryBtn, opacity: busy || !deviceId || !url.trim() ? 0.6 : 1, marginTop: "0.25rem" }}
          >
            {busy ? t("enroll.enrolling") : t("enroll.enroll")}
          </button>
        </>
      )}

      {msg && (
        <p style={{
          margin: "0.75rem 0 0", fontSize: "0.8125rem",
          color: msg.kind === "ok" ? C.success : C.danger,
        }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: "0.5rem", fontSize: "0.8125rem", marginBottom: "0.375rem" }}>
      <span style={{ color: C.muted, minWidth: 64 }}>{label}</span>
      <span style={{ color: C.text, wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

function EnrollField(props: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <label style={labelStyle}>{props.label}</label>
      <input
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
        style={inputStyle}
      />
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
  padding: "1rem", marginBottom: "1.5rem",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: "0.75rem", color: C.label, marginBottom: "0.375rem", fontWeight: 600,
};
const idStyle: React.CSSProperties = {
  display: "block", background: "#162032", border: `1px solid ${C.border}`,
  borderRadius: 6, padding: "0.5rem 0.625rem", color: C.text,
  fontSize: "0.75rem", wordBreak: "break-all",
};
const inputStyle: React.CSSProperties = {
  background: "#162032", border: `1px solid ${C.border}`,
  borderRadius: 6, padding: "0.625rem 0.75rem",
  color: C.text, fontFamily: FONT, fontSize: "0.875rem",
  outline: "none", width: "100%", boxSizing: "border-box",
};
const primaryBtn: React.CSSProperties = {
  background: C.primary, color: "#fff", border: "none", borderRadius: 8,
  padding: "0.625rem 1rem", fontSize: "0.875rem", fontWeight: 700,
  cursor: "pointer", fontFamily: FONT,
};
const ghostBtn: React.CSSProperties = {
  background: "none", border: `1px solid ${C.border}`, borderRadius: 6,
  padding: "0.5rem 0.75rem", color: C.muted, fontFamily: FONT,
  fontSize: "0.8125rem", cursor: "pointer",
};
