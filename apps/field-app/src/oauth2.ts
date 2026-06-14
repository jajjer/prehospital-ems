/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { OPENMRS_BASE } from "./config.js";

// Set VITE_OAUTH2_CLIENT_ID to enable OAuth2/OIDC. When unset the app falls
// back to Basic auth — safe for M1 LMIC deployments without an OAuth2 server.
export const OAUTH2_CLIENT_ID =
  import.meta.env.VITE_OAUTH2_CLIENT_ID as string | undefined;

const AUTHORIZATION_ENDPOINT = `${OPENMRS_BASE}/oauth2/authorize`;
const TOKEN_ENDPOINT = `${OPENMRS_BASE}/oauth2/token`;

const SK = {
  verifier: "ems_pkce_verifier",
  state:    "ems_oauth2_state",
  refresh:  "ems_refresh_token",
  expiry:   "ems_token_expiry",
} as const;

function base64url(buf: Uint8Array): string {
  let str = "";
  for (const b of buf) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Redirect the browser to OpenMRS's OAuth2 authorization endpoint. */
export async function startOAuth2Login(): Promise<void> {
  if (!OAUTH2_CLIENT_ID) return;
  const { verifier, challenge } = await generatePKCE();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(SK.verifier, verifier);
  sessionStorage.setItem(SK.state, state);
  // redirect_uri must be registered in the OpenMRS OAuth2 client config
  const redirectUri = `${window.location.origin}${window.location.pathname}`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH2_CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "openid",
  });
  window.location.href = `${AUTHORIZATION_ENDPOINT}?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

function storeTokens(data: TokenResponse): string {
  const authHeader = `Bearer ${data.access_token}`;
  sessionStorage.setItem("ems_auth", authHeader);
  if (data.refresh_token) sessionStorage.setItem(SK.refresh, data.refresh_token);
  if (data.expires_in) {
    sessionStorage.setItem(SK.expiry, String(Date.now() + data.expires_in * 1_000));
  }
  return authHeader;
}

/**
 * Exchange the authorization code (from the redirect callback) for tokens.
 * Returns the Bearer auth header string on success, or null on failure.
 */
export async function exchangeCodeForToken(
  code: string,
  state: string
): Promise<string | null> {
  if (!OAUTH2_CLIENT_ID) return null;
  const savedState = sessionStorage.getItem(SK.state);
  const verifier   = sessionStorage.getItem(SK.verifier);
  if (state !== savedState || !verifier) return null;
  sessionStorage.removeItem(SK.state);
  sessionStorage.removeItem(SK.verifier);

  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "authorization_code",
        client_id:     OAUTH2_CLIENT_ID,
        code,
        redirect_uri:  `${window.location.origin}${window.location.pathname}`,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) return null;
    return storeTokens(await res.json() as TokenResponse);
  } catch {
    return null;
  }
}

/**
 * Attempt a silent token refresh using the stored refresh token.
 * Returns the new Bearer auth header on success, or null if the refresh
 * token is absent or rejected (caller should prompt re-auth).
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (!OAUTH2_CLIENT_ID) return null;
  const refreshToken = sessionStorage.getItem(SK.refresh);
  if (!refreshToken) return null;

  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     OAUTH2_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) {
      sessionStorage.removeItem(SK.refresh);
      sessionStorage.removeItem(SK.expiry);
      return null;
    }
    return storeTokens(await res.json() as TokenResponse);
  } catch {
    return null;
  }
}

/** Remove all OAuth2 tokens from sessionStorage (call on logout). */
export function clearOAuth2Tokens(): void {
  sessionStorage.removeItem(SK.refresh);
  sessionStorage.removeItem(SK.expiry);
}
