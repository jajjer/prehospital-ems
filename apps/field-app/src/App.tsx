import { useState, useEffect } from "react";
import { initSyncWorker } from "@prehospital-ems/sync-engine";
import { CaptureForm } from "./CaptureForm.js";
import { StatusBar } from "./StatusBar.js";
import { LoginScreen } from "./LoginScreen.js";
import { C, FONT } from "./theme.js";
import { FHIR_BASE } from "./config.js";

export function App() {
  const [authHeader, setAuthHeader] = useState<string | null>(
    () => sessionStorage.getItem("ems_auth")
  );
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

  return (
    <div style={{ minHeight: "100dvh", background: C.bg, color: C.text, fontFamily: FONT }}>
      <StatusBar onLogout={handleLogout} />
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 1rem 2rem" }}>
        {submitted ? (
          <SuccessScreen onNew={() => setSubmitted(false)} />
        ) : (
          <CaptureForm onSubmit={() => setSubmitted(true)} />
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
      <button onClick={onNew} style={{
        background: C.primary, color: "#fff", border: "none",
        borderRadius: 8, padding: "0.75rem 2rem",
        fontSize: "0.9375rem", fontWeight: 600, cursor: "pointer",
        letterSpacing: "0.01em", fontFamily: FONT,
      }}>
        New patient
      </button>
    </div>
  );
}
