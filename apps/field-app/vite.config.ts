/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Inject a Content-Security-Policy `<meta>` into the built index.html to shrink
 * the XSS blast radius (issue #3). It is applied at **build time only**: Vite's
 * dev server relies on inline scripts and `eval` for HMR, which a strict policy
 * would break, so dev is left unconstrained and production gets the lockdown.
 *
 * The bundle ships only same-origin hashed assets and a same-origin service
 * worker, so `'self'` covers scripts, styles, workers, and the manifest. The
 * one outbound connection is to OpenMRS (and an optional remote-wipe endpoint);
 * when those are configured as absolute URLs (at build time) their origins are
 * added to `connect-src`. When OpenMRS is reached through the same-origin reverse
 * proxy (the default `/openmrs`), `'self'` already allows it. Because the policy
 * lives in the precached index.html, it applies offline too.
 *
 * Note (runtime config — issue #14): the OpenMRS base URL is now resolved at
 * runtime, so a cross-origin base set only via /config.json or the in-app
 * Settings is NOT known here and won't be in this meta CSP. The recommended
 * multi-facility deployment puts OpenMRS behind a same-origin reverse proxy
 * (base path `/openmrs`), which `'self'` already covers; if you instead point a
 * facility at a cross-origin absolute URL, add that origin to `connect-src` via
 * the host/CDN CSP response header. See SECURITY.md / README Configuration.
 *
 * `frame-ancestors`, `X-Frame-Options`, and HSTS cannot be set from a `<meta>`
 * tag and must be sent as HTTP response headers by the host/CDN — see
 * SECURITY.md for the recommended header set.
 */
function cspPlugin(env: Record<string, string>): Plugin {
  const connectSrc = new Set<string>(["'self'"]);
  for (const url of [env.VITE_OPENMRS_BASE_URL, env.VITE_WIPE_CHECK_URL]) {
    if (!url) continue;
    try {
      connectSrc.add(new URL(url).origin);
    } catch {
      // Relative/same-origin (e.g. the default "/openmrs") — already covered by 'self'.
    }
  }

  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    // React applies inline styles via the CSSOM (exempt from CSP); 'unsafe-inline'
    // covers any runtime-injected <style> without weakening script protection.
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    `connect-src ${[...connectSrc].join(" ")}`,
  ].join("; ");

  return {
    name: "ems-csp-meta",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: policy },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [
      react(),
      cspPlugin(env),
      VitePWA({
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        // Keep the per-facility runtime config (issue #14) OUT of the precache
        // manifest — precaching would pin a stale copy to the build, defeating
        // "config changes take effect without a rebuild". The service worker
        // serves it network-first with a cache fallback instead (see sw.ts).
        injectManifest: {
          globIgnores: ["**/config.json"],
        },
        manifest: {
          name: "EMS Field App",
          short_name: "EMS Field",
          description: "Offline-first prehospital EMS capture",
          theme_color: "#1d4ed8",
          background_color: "#ffffff",
          display: "standalone",
          orientation: "portrait",
          start_url: "/",
          icons: [
            {
              src: "icon-192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "icon-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any maskable",
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: "module",
        },
      }),
    ],
    server: {
      port: 3000,
      proxy: {
        "/openmrs": {
          target: "http://localhost:8069",
          changeOrigin: true,
        },
      },
    },
  };
});
