/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState } from "react";
import { C, FONT } from "./theme.js";
import { REST_BASE } from "./config.js";

interface Props {
  onLogin: (authHeader: string) => void;
}

export function LoginScreen({ onLogin }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    setError("");
    setLoading(true);
    const authHeader = `Basic ${btoa(`${username}:${password}`)}`;
    try {
      const res = await fetch(`${REST_BASE}/session`, {
        headers: { Authorization: authHeader },
      });
      const data = await res.json() as { authenticated?: boolean };
      if (data.authenticated) {
        sessionStorage.setItem("ems_auth", authHeader);
        onLogin(authHeader);
      } else {
        setError("Invalid username or password.");
      }
    } catch {
      setError("Could not reach OpenMRS. Check network.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100dvh", background: C.bg, display: "flex",
      alignItems: "center", justifyContent: "center",
      fontFamily: FONT, padding: "1rem",
    }}>
      <div style={{ width: "100%", maxWidth: 360 }}>
        {/* Logo / header */}
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: "0.5rem",
            marginBottom: "0.5rem",
          }}>
            <span style={{
              background: C.primary, color: "#fff", borderRadius: 4,
              padding: "0.2rem 0.5rem", fontSize: "0.8125rem", fontWeight: 700,
              letterSpacing: "0.08em", textTransform: "uppercase",
            }}>EMS</span>
            <span style={{ fontWeight: 700, fontSize: "1.125rem", color: C.text }}>
              Field Capture
            </span>
          </div>
          <p style={{ color: C.muted, fontSize: "0.8125rem" }}>
            Sign in with your OpenMRS credentials
          </p>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} style={{
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: "1.5rem",
        }}>
          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", fontSize: "0.75rem", color: C.muted, marginBottom: "0.375rem", fontWeight: 500 }}>
              Username
            </label>
            <input
              type="text" autoComplete="username" autoCapitalize="off"
              value={username} onChange={(e) => setUsername(e.target.value)}
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{ display: "block", fontSize: "0.75rem", color: C.muted, marginBottom: "0.375rem", fontWeight: 500 }}>
              Password
            </label>
            <input
              type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
            />
          </div>

          {error && (
            <div style={{
              background: C.dangerBg, border: `1px solid ${C.danger}`,
              borderRadius: 6, padding: "0.625rem 0.75rem",
              color: C.danger, fontSize: "0.8125rem", marginBottom: "1rem",
            }}>
              {error}
            </div>
          )}

          <button
            type="submit" disabled={loading || !username || !password}
            style={{
              width: "100%", padding: "0.875rem",
              background: loading || !username || !password ? C.border : C.primary,
              color: "#fff", border: "none", borderRadius: 8,
              fontSize: "1rem", fontWeight: 700,
              cursor: loading || !username || !password ? "default" : "pointer",
              fontFamily: FONT, letterSpacing: "0.02em",
              transition: "background 0.15s",
            }}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#162032", border: `1px solid ${C.border}`,
  borderRadius: 6, padding: "0.625rem 0.75rem",
  color: C.text, fontFamily: FONT, fontSize: "0.9375rem",
  outline: "none", width: "100%", boxSizing: "border-box",
};
