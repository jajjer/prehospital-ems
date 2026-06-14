/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState, useEffect } from "react";
import { initSyncWorker, flush } from "@prehospital-ems/sync-engine";
import { CaptureForm } from "./CaptureForm.js";
import { StatusBar } from "./StatusBar.js";
import { LoginScreen } from "./LoginScreen.js";
import { RecordsScreen } from "./RecordsScreen.js";
import { C, FONT } from "./theme.js";
import { FHIR_BASE, REST_BASE } from "./config.js";

type Tab = "capture" | "records";

export function App() {
  const [authHeader, setAuthHeader] = useState<string | null>(
    () => sessionStorage.getItem("ems_auth")
  );
  const [tab, setTab] = useState<Tab>("capture");
  const [submitted, setSubmitted] = useState(false);
  const [swUpdateReady, setSwUpdateReady] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    if (authHeader) {
      initSyncWorker({ fhirBaseUrl: FHIR_BASE, authHeader });
    }
  }, [authHeader]);

  // Detect a waiting service worker and surface a non-blocking update banner.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then((reg) => {
      if (reg.waiting) { setSwUpdateReady(true); return; }
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            setSwUpdateReady(true);
          }
        });
      });
    }).catch(() => undefined);
    // Reload after the new SW takes control (triggered by SKIP_WAITING).
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      window.location.reload();
    });
  }, []);

  // Re-auth when the sync worker encounters a 401.
  useEffect(() => {
    const handler = () => setSessionExpired(true);
    window.addEventListener("ems:auth-expired", handler);
    return () => window.removeEventListener("ems:auth-expired", handler);
  }, []);

  function handleReAuth(newAuth: string) {
    setAuthHeader(newAuth);
    setSessionExpired(false);
    void flush();
  }

  function handleSwUpdate() {
    navigator.serviceWorker.ready.then((reg) => {
      reg.waiting?.postMessage({ type: "SKIP_WAITING" });
    }).catch(() => undefined);
  }

  if (!authHeader) {
    return <LoginScreen onLogin={(auth) => setAuthHeader(auth)} />;
  }

  function handleLogout() {
    sessionStorage.removeItem("ems_auth");
    setAuthHeader(null);
  }

  function handleSubmit() {
    setSubmitted(true);
  }

  return (
    <div style={{ minHeight: "100dvh", background: C.bg, color: C.text, fontFamily: FONT }}>
      {swUpdateReady && (
        <div style={{
          background: "#1e293b", borderBottom: `1px solid ${C.border}`,
          padding: "0.5rem 1rem", display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ color: C.muted, fontSize: "0.8125rem" }}>Update available</span>
          <button
            onClick={handleSwUpdate}
            style={{
              background: C.primary, color: "#fff", border: "none", borderRadius: 6,
              padding: "0.3rem 0.75rem", fontSize: "0.8125rem", fontWeight: 600,
              cursor: "pointer", fontFamily: FONT,
            }}
          >
            Refresh
          </button>
        </div>
      )}

      {sessionExpired && (
        <ReAuthModal onReAuth={handleReAuth} />
      )}

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

function ReAuthModal({ onReAuth }: { onReAuth: (auth: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    setError("");
    setLoading(true);
    const auth = `Basic ${btoa(`${username}:${password}`)}`;
    try {
      const res = await fetch(`${REST_BASE}/session`, {
        headers: { Authorization: auth },
      });
      const data = await res.json() as { authenticated?: boolean };
      if (data.authenticated) {
        sessionStorage.setItem("ems_auth", auth);
        onReAuth(auth);
      } else {
        setError("Invalid credentials.");
      }
    } catch {
      setError("Could not reach OpenMRS. Check network.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 100, padding: "1rem", fontFamily: FONT,
    }}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 12, padding: "1.5rem", width: "100%", maxWidth: 340,
      }}>
        <p style={{ fontWeight: 700, marginBottom: "0.25rem" }}>Session expired</p>
        <p style={{ color: C.muted, fontSize: "0.8125rem", marginBottom: "1.25rem" }}>
          Sign in again to continue syncing. Your queued records are safe.
        </p>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <input
            type="text" placeholder="Username" autoCapitalize="off"
            value={username} onChange={(e) => setUsername(e.target.value)}
            style={{ ...reAuthInputStyle, marginBottom: "0.75rem" }}
          />
          <input
            type="password" placeholder="Password"
            value={password} onChange={(e) => setPassword(e.target.value)}
            style={{ ...reAuthInputStyle, marginBottom: error ? "0.75rem" : "1rem" }}
          />
          {error && (
            <div style={{ color: C.danger, fontSize: "0.8125rem", marginBottom: "0.75rem" }}>{error}</div>
          )}
          <button
            type="submit" disabled={loading || !username || !password}
            style={{
              width: "100%", padding: "0.75rem",
              background: loading || !username || !password ? C.border : C.primary,
              color: "#fff", border: "none", borderRadius: 8,
              fontSize: "0.9375rem", fontWeight: 700,
              cursor: loading || !username || !password ? "default" : "pointer",
              fontFamily: FONT,
            }}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

const reAuthInputStyle: React.CSSProperties = {
  display: "block", width: "100%", boxSizing: "border-box",
  background: "#162032", border: `1px solid ${C.border}`,
  borderRadius: 6, padding: "0.625rem 0.75rem",
  color: C.text, fontFamily: FONT, fontSize: "0.9375rem", outline: "none",
};

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
