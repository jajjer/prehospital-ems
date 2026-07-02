/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState, useEffect } from "react";
import {
  initSyncWorker, flush, pruneOldCaptures, seedConcepts,
  initAppLock, lock as lockApp, getDeviceId, isRemoteWipeRequested, wipeLocalData,
  reconcileTokenStorage, clearTokens, setAuthHeader as persistAuthHeader,
  captureIdentity, reconcileIdentity, clearIdentity,
} from "@prehospital-ems/sync-engine";
import { CaptureForm } from "./CaptureForm.js";
import { StatusBar } from "./StatusBar.js";
import { LoginScreen } from "./LoginScreen.js";
import { LockScreen } from "./LockScreen.js";
import { RecordsScreen } from "./RecordsScreen.js";
import { SettingsScreen } from "./SettingsScreen.js";
import { C, FONT } from "./theme.js";
import { useI18n, useT } from "./i18n/react.js";
import { FHIR_BASE, REST_BASE, IDLE_LOCK_MS, WIPE_CHECK_URL, SYNC_TELEMETRY_URL } from "./config.js";
import {
  OAUTH2_CLIENT_ID,
  exchangeCodeForToken,
  refreshAccessToken,
  startOAuth2Login,
  scheduleProactiveRefresh,
  stopProactiveRefresh,
} from "./oauth2.js";

type Tab = "capture" | "records" | "settings";
type LockStatus = "loading" | "unlocked" | "locked" | "error";

export function App() {
  const { t, formatNumber } = useI18n();
  // Restored asynchronously from encrypted-at-rest storage once the app unlocks
  // — never read from plaintext web storage (issue #3).
  const [authHeader, setAuthHeader] = useState<string | null>(null);
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
  const [lockStatus, setLockStatus] = useState<LockStatus>("loading");
  const [pinSet, setPinSet] = useState(false);

  // Provision the at-rest key / app-lock state once on start. In device-key mode
  // (no PIN yet) this installs the key and the app is usable; once a PIN exists
  // we stay locked until it's entered. Database ops queue on the key gate, so a
  // read firing before this resolves never races.
  useEffect(() => {
    let cancelled = false;
    initAppLock()
      .then((s) => {
        if (cancelled) return;
        setPinSet(s.pinSet);
        setLockStatus(s.locked ? "locked" : "unlocked");
      })
      .catch((err) => {
        console.error("[applock] failed to initialize", err);
        if (!cancelled) setLockStatus("error");
      });
    return () => { cancelled = true; };
  }, []);

  // Re-lock on idle and when the app is backgrounded (only once a PIN is set).
  // Locking drops the in-memory key but never the offline queue.
  useEffect(() => {
    if (!pinSet || lockStatus !== "unlocked") return;
    const doLock = () => { lockApp(); setLockStatus("locked"); };
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => { clearTimeout(timer); timer = setTimeout(doLock, IDLE_LOCK_MS); };
    const onVisibility = () => { if (document.visibilityState === "hidden") doLock(); };
    const activity = ["pointerdown", "keydown", "touchstart"] as const;
    activity.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    document.addEventListener("visibilitychange", onVisibility);
    reset();
    return () => {
      clearTimeout(timer);
      activity.forEach((e) => window.removeEventListener(e, reset));
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pinSet, lockStatus]);

  // Remote wipe: on launch and on reconnect, ask the admin backend whether this
  // device has been flagged. Fail-safe — only an explicit flag wipes.
  useEffect(() => {
    const wipeUrl = WIPE_CHECK_URL;
    if (!authHeader || lockStatus !== "unlocked" || !wipeUrl) return;
    const check = async () => {
      try {
        const deviceId = await getDeviceId();
        if (await isRemoteWipeRequested({ url: wipeUrl, deviceId, authHeader })) {
          await wipeLocalData();
          sessionStorage.clear();
          stopProactiveRefresh();
          window.location.reload();
        }
      } catch { /* fail-safe: never wipe on a transient error */ }
    };
    void check();
    window.addEventListener("online", check);
    return () => window.removeEventListener("online", check);
  }, [authHeader, lockStatus]);

  useEffect(() => {
    if (authHeader && lockStatus === "unlocked") {
      initSyncWorker({
        fhirBaseUrl: FHIR_BASE,
        authHeader,
        // exactOptionalPropertyTypes: omit the key entirely when unset.
        ...(SYNC_TELEMETRY_URL ? { telemetryUrl: SYNC_TELEMETRY_URL } : {}),
      });
      void pruneOldCaptures();
      void seedConcepts(REST_BASE, authHeader);
      // Capture *who* is signed in, so field-record amendments can be attributed
      // to an authenticated identity (issue #13). Best-effort and online-only;
      // offline reloads fall back to the identity restored from the keystore below.
      void captureIdentity(REST_BASE, authHeader);
    }
  }, [authHeader, lockStatus]);

  // Restore the auth header from encrypted-at-rest storage once the app unlocks,
  // so a service-worker-update reload mid-shift doesn't force a re-login. The
  // tokens are decryptable only after the data key is installed (i.e. unlocked).
  useEffect(() => {
    if (lockStatus !== "unlocked") return;
    let cancelled = false;
    void reconcileTokenStorage().then((restored) => {
      if (!cancelled && restored) setAuthHeader(restored);
    });
    // Restore the signed-in identity from the keystore so amendment attribution
    // survives a reload mid-shift (issue #13).
    void reconcileIdentity();
    return () => { cancelled = true; };
  }, [lockStatus]);

  // Proactive silent refresh (OAuth2): mint a fresh access token shortly before
  // the current one expires, instead of only reacting to a 401 mid-sync.
  useEffect(() => {
    if (!authHeader || !OAUTH2_CLIENT_ID) return;
    scheduleProactiveRefresh((newAuth) => setAuthHeader(newAuth));
    return () => stopProactiveRefresh();
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

  function handleLogout() {
    stopProactiveRefresh();
    void clearTokens();
    void clearIdentity();
    setAuthHeader(null);
  }

  function handleLock() {
    lockApp();
    setLockStatus("locked");
  }

  function handleSubmit() {
    setSubmitted(true);
  }

  if (lockStatus === "loading") {
    return (
      <div style={{ minHeight: "100dvh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT }}>
        <span style={{ color: C.muted, fontSize: "0.9375rem" }}>{t("app.unlocking")}</span>
      </div>
    );
  }

  if (lockStatus === "error") {
    return (
      <div style={{ minHeight: "100dvh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: "1.5rem", textAlign: "center", fontFamily: FONT }}>
        <span style={{ color: C.danger, fontSize: "0.9375rem" }}>
          {t("app.unlockError")}
        </span>
      </div>
    );
  }

  // App lock comes before everything else: local PHI must stay sealed until the
  // PIN is entered, regardless of sign-in state.
  if (lockStatus === "locked") {
    return <LockScreen mode="unlock" onDone={() => setLockStatus("unlocked")} />;
  }

  if (completingOAuth2) {
    return (
      <div style={{ minHeight: "100dvh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT }}>
        <span style={{ color: C.muted, fontSize: "0.9375rem" }}>{t("app.completingSignIn")}</span>
      </div>
    );
  }

  if (!authHeader) {
    return <LoginScreen onLogin={(auth) => setAuthHeader(auth)} />;
  }

  // First sign-in with no PIN yet: require the user to set one before capturing.
  if (!pinSet) {
    return <LockScreen mode="create" onDone={() => setPinSet(true)} />;
  }

  return (
    <div style={{ minHeight: "100dvh", background: C.bg, color: C.text, fontFamily: FONT }}>
      {swUpdateReady && (
        <div style={{
          background: "#1e293b", borderBottom: `1px solid ${C.border}`,
          padding: "0.5rem 1rem", display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ color: C.muted, fontSize: "0.8125rem" }}>{t("app.updateAvailable")}</span>
          <button
            onClick={handleSwUpdate}
            style={{
              background: C.primary, color: "#fff", border: "none", borderRadius: 6,
              padding: "0.3rem 0.75rem", fontSize: "0.8125rem", fontWeight: 600,
              cursor: "pointer", fontFamily: FONT,
            }}
          >
            {t("app.refresh")}
          </button>
        </div>
      )}

      {bgSyncSuppressed && (
        <WarnBanner onDismiss={() => setBgSyncSuppressed(false)} dismissLabel={t("app.dismiss")}>
          {t("app.bgSyncSuppressed")}
        </WarnBanner>
      )}

      {clockSkewMinutes !== null && (
        <WarnBanner onDismiss={() => setClockSkewMinutes(null)} dismissLabel={t("app.dismiss")}>
          {t("app.clockSkew", { minutes: formatNumber(clockSkewMinutes) })}
        </WarnBanner>
      )}

      {storageWarning && (
        <WarnBanner onDismiss={() => setStorageWarning(false)} dismissLabel={t("app.dismiss")}>
          {t("app.storageWarning")}
        </WarnBanner>
      )}

      {sessionExpired && (
        <ReAuthModal onReAuth={handleReAuth} useOAuth2={!!OAUTH2_CLIENT_ID} />
      )}

      <StatusBar onLogout={handleLogout} onLock={handleLock} />

      {/* Tab bar */}
      <div style={{
        display: "flex", maxWidth: 480, margin: "0 auto",
        padding: "0 1rem 0", gap: "0.25rem", marginBottom: "1.25rem",
      }}>
        {(["capture", "records", "settings"] as Tab[]).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => { setTab(tabKey); if (tabKey === "capture") setSubmitted(false); }}
            style={{
              flex: 1, padding: "0.5rem",
              background: tab === tabKey ? C.surface : "transparent",
              border: `1px solid ${tab === tabKey ? C.border : "transparent"}`,
              borderRadius: 6,
              color: tab === tabKey ? C.text : C.muted,
              fontFamily: FONT, fontSize: "0.8125rem", fontWeight: tab === tabKey ? 600 : 400,
              cursor: "pointer", transition: "all 0.1s",
            }}
          >
            {tabKey === "capture" ? t("nav.capture") : tabKey === "records" ? t("nav.records") : t("nav.settings")}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 1rem 2rem" }}>
        {tab === "capture" ? (
          submitted ? (
            <SuccessScreen onNew={() => { setSubmitted(false); }} />
          ) : (
            <CaptureForm authHeader={authHeader} onSubmit={handleSubmit} />
          )
        ) : tab === "records" ? (
          <RecordsScreen authHeader={authHeader} />
        ) : (
          <SettingsScreen onClose={() => setTab("capture")} />
        )}
      </div>
    </div>
  );
}

function ReAuthModal({ onReAuth, useOAuth2 }: { onReAuth: (auth: string) => void; useOAuth2: boolean }) {
  const t = useT();
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
        await persistAuthHeader(auth);
        onReAuth(auth);
      } else {
        setError(t("login.invalidCredentials"));
      }
    } catch {
      setError(t("login.unreachable"));
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
        <p style={{ fontWeight: 700, marginBottom: "0.25rem" }}>{t("app.sessionExpiredTitle")}</p>
        <p style={{ color: C.muted, fontSize: "0.8125rem", marginBottom: "1.25rem" }}>
          {t("app.sessionExpiredBody")}
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
              {t("login.withOpenMRS")}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
              <div style={{ flex: 1, height: 1, background: C.border }} />
              <span style={{ color: C.muted, fontSize: "0.75rem" }}>{t("login.orUsernamePassword")}</span>
              <div style={{ flex: 1, height: 1, background: C.border }} />
            </div>
          </>
        )}

        <form onSubmit={(e) => void handleSubmit(e)}>
          <input
            type="text" placeholder={t("login.username")} autoCapitalize="off"
            value={username} onChange={(e) => setUsername(e.target.value)}
            style={{ ...reAuthInputStyle, marginBottom: "0.75rem" }}
          />
          <input
            type="password" placeholder={t("login.password")}
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
            {loading ? t("login.signingIn") : t("login.signIn")}
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

function WarnBanner({ children, onDismiss, dismissLabel }: { children: React.ReactNode; onDismiss: () => void; dismissLabel: string }) {
  return (
    <div style={{
      background: "#1c1a0a", borderBottom: `1px solid #ca8a04`,
      padding: "0.5rem 1rem", display: "flex", justifyContent: "space-between",
      alignItems: "center", gap: "0.75rem",
    }}>
      <span style={{ color: "#fbbf24", fontSize: "0.8125rem" }}>{children}</span>
      <button
        onClick={onDismiss}
        aria-label={dismissLabel}
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
  const t = useT();
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
        {t("app.queuedForSync")}
      </p>
      <p style={{ color: C.muted, fontSize: "0.875rem", marginBottom: "2rem" }}>
        {t("app.queuedForSyncBody")}
      </p>
      <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
        <button onClick={onNew} style={{
          background: C.primary, color: "#fff", border: "none",
          borderRadius: 8, padding: "0.75rem 2rem",
          fontSize: "0.9375rem", fontWeight: 600, cursor: "pointer",
          letterSpacing: "0.01em", fontFamily: FONT,
        }}>
          {t("app.newPatient")}
        </button>
      </div>
    </div>
  );
}
