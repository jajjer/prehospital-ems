/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState, useEffect } from "react";
import { initSyncWorker, flush, pruneOldCaptures } from "@prehospital-ems/sync-engine";
import { CaptureForm } from "./CaptureForm.js";
import { StatusBar } from "./StatusBar.js";
import { LoginScreen } from "./LoginScreen.js";
import { RecordsScreen } from "./RecordsScreen.js";
import { C, FONT } from "./theme.js";
import { FHIR_BASE, REST_BASE } from "./config.js";
import {
  OAUTH2_CLIENT_ID,
  exchangeCodeForToken,
  refreshAccessToken,
  startOAuth2Login,
  clearOAuth2Tokens,
} from "./oauth2.js";

type Tab = "capture" | "records";

export function App() {
  const [authHeader, setAuthHeader] = useState<string | null>(
    () => sessionStorage.getItem("ems_auth")
  );
  const [tab, setTab] = useState<Tab>("capture");
  const [submitted, setSubmitted] = useState(false);
  const [swUpdateReady, setSwUpdateReady] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [bgSyncSuppressed, setBgSyncSuppressed] = useState(false);
  const [clockSkewMinutes, setClockSkewMinutes] = useState<number | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const [completingOAuth2, setCompletingOAuth2] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return !!(p.get("code") && p.get("state"));
  });

  useEffect(() => {
    if (authHeader) {
      initSyncWorker({ fhirBaseUrl: FHIR_BASE, authHeader });
      void pruneOldCaptures();
    }
  }, [authHeader]);

  // Complete OAuth2 authorization-code exchange when redirected back from OpenMRS.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code  = params.get("code");
    const state = params.get("state");
    if (!code || !state) return;
    window.history.replaceState({}, "", window.location.pathname);
    exchangeCodeForToken(code, state)
      .then((auth) => { if (auth) setAuthHeader(auth); })
      .catch(() => undefined)
      .finally(() => setCompletingOAuth2(false));
  }, []);

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
  // Try silent token refresh first (OAuth2 only); fall back to re-auth modal.
  useEffect(() => {
    const handler = () => {
      void refreshAccessToken().then((newAuth) => {
        if (newAuth) {
          setAuthHeader(newAuth);
        } else {
          setSessionExpired(true);
        }
      });
    };
    window.addEventListener("ems:auth-expired", handler);
    return () => window.removeEventListener("ems:auth-expired", handler);
  }, []);

  // Battery optimization detection.
  useEffect(() => {
    const handler = () => setBgSyncSuppressed(true);
    window.addEventListener("ems:bg-sync-suppressed", handler);
    return () => window.removeEventListener("ems:bg-sync-suppressed", handler);
  }, []);

  // Clock skew detection.
  useEffect(() => {
    const handler = (e: Event) => {
      setClockSkewMinutes((e as CustomEvent<{ skewMinutes: number }>).detail.skewMinutes);
    };
    window.addEventListener("ems:clock-skew", handler);
    return () => window.removeEventListener("ems:clock-skew", handler);
  }, []);

  // Storage quota warning — check once on login.
  useEffect(() => {
    if (!authHeader || !("storage" in navigator)) return;
    navigator.storage.estimate().then(({ usage = 0, quota = 0 }) => {
      if (quota > 0 && usage / quota > 0.8) setStorageWarning(true);
    }).catch(() => undefined);
  }, [authHeader]);

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

  if (completingOAuth2) {
    return (
      <div style={{ minHeight: "100dvh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT }}>
        <span style={{ color: C.muted, fontSize: "0.9375rem" }}>Completing sign-in…</span>
      </div>
    );
  }

  if (!authHeader) {
    return <LoginScreen onLogin={(auth) => setAuthHeader(auth)} />;
  }

  function handleLogout() {
    sessionStorage.removeItem("ems_auth");
    clearOAuth2Tokens();
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

      {bgSyncSuppressed && (
        <WarnBanner onDismiss={() => setBgSyncSuppressed(false)}>
          Background sync may be disabled by battery optimization. Go to Settings → Apps → Chrome → Battery → Unrestricted.
        </WarnBanner>
      )}

      {clockSkewMinutes !== null && (
        <WarnBanner onDismiss={() => setClockSkewMinutes(null)}>
          Device clock may be off by ~{clockSkewMinutes} min. Vital timestamps could be incorrect — check Settings → Date &amp; Time.
        </WarnBanner>
      )}

      {storageWarning && (
        <WarnBanner onDismiss={() => setStorageWarning(false)}>
          Device storage is nearly full. Free up space to ensure records can be saved offline.
        </WarnBanner>
      )}

      {sessionExpired && (
        <ReAuthModal onReAuth={handleReAuth} useOAuth2={!!OAUTH2_CLIENT_ID} />
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

function ReAuthModal({ onReAuth, useOAuth2 }: { onReAuth: (auth: string) => void; useOAuth2: boolean }) {
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

        {useOAuth2 && (
          <>
            <button
              type="button"
              onClick={() => void startOAuth2Login()}
              style={{
                width: "100%", padding: "0.75rem",
                background: C.primary, color: "#fff", border: "none", borderRadius: 8,
                fontSize: "0.9375rem", fontWeight: 700, cursor: "pointer",
                fontFamily: FONT, marginBottom: "1rem",
              }}
            >
              Sign in with OpenMRS
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
              <div style={{ flex: 1, height: 1, background: C.border }} />
              <span style={{ color: C.muted, fontSize: "0.75rem" }}>or</span>
              <div style={{ flex: 1, height: 1, background: C.border }} />
            </div>
          </>
        )}

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

function WarnBanner({ children, onDismiss }: { children: React.ReactNode; onDismiss: () => void }) {
  return (
    <div style={{
      background: "#1c1a0a", borderBottom: `1px solid #ca8a04`,
      padding: "0.5rem 1rem", display: "flex", justifyContent: "space-between",
      alignItems: "center", gap: "0.75rem",
    }}>
      <span style={{ color: "#fbbf24", fontSize: "0.8125rem" }}>{children}</span>
      <button
        onClick={onDismiss}
        style={{
          background: "none", border: "none", color: "#ca8a04",
          cursor: "pointer", fontSize: "1rem", padding: 0, flexShrink: 0,
          fontFamily: FONT,
        }}
      >✕</button>
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
