import { useState, useEffect } from "react";
import { initSyncWorker } from "@prehospital-ems/sync-engine";
import { CaptureForm } from "./CaptureForm.js";
import { StatusBar } from "./StatusBar.js";
import { LoginScreen } from "./LoginScreen.js";
import { RecordsScreen } from "./RecordsScreen.js";
import { C, FONT } from "./theme.js";
import { FHIR_BASE } from "./config.js";

type Tab = "capture" | "records";

export function App() {
  const [authHeader, setAuthHeader] = useState<string | null>(
    () => sessionStorage.getItem("ems_auth")
  );
  const [tab, setTab] = useState<Tab>("capture");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (authHeader) {
      initSyncWorker({ fhirBaseUrl: FHIR_BASE, authHeader });
    }
  }, [authHeader]);

  if (!authHeader) {
    return <LoginScreen onLogin={(auth) => setAuthHeader(auth)} />;
  }

  function handleLogout() {
    sessionStorage.removeItem("ems_auth");
    setAuthHeader(null);
  }

  function handleSubmit() {
    setSubmitted(true);
    setTab("records");
  }

  return (
    <div style={{ minHeight: "100dvh", background: C.bg, color: C.text, fontFamily: FONT }}>
      <StatusBar onLogout={handleLogout} />

      {/* Tab bar */}
      <div style={{
        display: "flex", maxWidth: 480, margin: "0 auto",
        padding: "0 1rem 0", gap: "0.25rem", marginBottom: "1.25rem",
      }}>
        {(["capture", "records"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); if (t === "capture") setSubmitted(false); }}
            style={{
              flex: 1, padding: "0.5rem",
              background: tab === t ? C.surface : "transparent",
              border: `1px solid ${tab === t ? C.border : "transparent"}`,
              borderRadius: 6,
              color: tab === t ? C.text : C.muted,
              fontFamily: FONT, fontSize: "0.8125rem", fontWeight: tab === t ? 600 : 400,
              cursor: "pointer", transition: "all 0.1s",
            }}
          >
            {t === "capture" ? "Capture" : "Records"}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 1rem 2rem" }}>
        {tab === "capture" ? (
          submitted ? (
            <SuccessScreen onNew={() => { setSubmitted(false); }} />
          ) : (
            <CaptureForm onSubmit={handleSubmit} />
          )
        ) : (
          <RecordsScreen />
        )}
      </div>
    </div>
  );
}

function SuccessScreen({ onNew }: { onNew: () => void }) {
  return (
    <div style={{ paddingTop: "3rem", textAlign: "center" }}>
      <div style={{
        width: 64, height: 64, borderRadius: "50%",
        background: "#14532d", border: `2px solid ${C.success}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        margin: "0 auto 1.25rem", fontSize: "1.75rem",
      }}>
        ✓
      </div>
      <p style={{ fontSize: "1.125rem", fontWeight: 600, marginBottom: "0.375rem" }}>
        Queued for sync
      </p>
      <p style={{ color: C.muted, fontSize: "0.875rem", marginBottom: "2rem" }}>
        Data will upload automatically when connected.
      </p>
      <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
        <button onClick={onNew} style={{
          background: C.primary, color: "#fff", border: "none",
          borderRadius: 8, padding: "0.75rem 2rem",
          fontSize: "0.9375rem", fontWeight: 600, cursor: "pointer",
          letterSpacing: "0.01em", fontFamily: FONT,
        }}>
          New patient
        </button>
      </div>
    </div>
  );
}
