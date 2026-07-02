/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
/**
 * Lightweight, dependency-free i18n core (issue #16).
 *
 * The UI was English-only; LMIC deployments need local languages and — like
 * everything else in this app — it must work **offline**. Rather than pull in a
 * heavy framework, this is a small, well-tested core in keeping with the app's
 * minimal-dependency, offline-first design (cf. the vendored QR generator and the
 * hand-rolled config layering).
 *
 * Offline language packs: every catalog is a plain module **bundled** into the
 * app, so the PWA precache ships them with the build — switching language never
 * needs the network. Locale-aware dates and numbers use the platform `Intl` APIs,
 * which are likewise offline.
 *
 * The active locale is a tiny external store (`subscribe`/`getLocaleSnapshot`) so
 * React can re-render on change via `useSyncExternalStore`, and the selection is
 * persisted to localStorage and mirrored onto `<html lang dir>` for RTL.
 */
import { en, type MessageKey } from "./locales/en.js";
import { sw } from "./locales/sw.js";
import { ar } from "./locales/ar.js";

export type { MessageKey };
export type Dir = "ltr" | "rtl";

export interface LocaleMeta {
  /** BCP-47 code, also passed to `Intl`. */
  code: string;
  /** Endonym — the language's own name, shown in the switcher. */
  name: string;
  /** English name, for docs / accessibility. */
  englishName: string;
  /** Writing direction; drives `<html dir>` and RTL mirroring. */
  dir: Dir;
}

/** Shipped locales. Add a locale by adding its catalog and a row here. */
export const LOCALES: readonly LocaleMeta[] = [
  { code: "en", name: "English", englishName: "English", dir: "ltr" },
  { code: "sw", name: "Kiswahili", englishName: "Swahili", dir: "ltr" },
  { code: "ar", name: "العربية", englishName: "Arabic", dir: "rtl" },
];

export const DEFAULT_LOCALE = "en";

const CATALOGS: Record<string, Record<MessageKey, string>> = { en, sw, ar };
const LOCALE_KEY = "ems_locale";

function metaFor(code: string): LocaleMeta {
  return LOCALES.find((l) => l.code === code) ?? LOCALES[0]!;
}

/** True when `code` is a shipped locale. */
export function isSupportedLocale(code: string): boolean {
  return LOCALES.some((l) => l.code === code);
}

/** Writing direction for a locale (defaults to ltr for unknown codes). */
export function dirForLocale(code: string): Dir {
  return metaFor(code).dir;
}

/**
 * Resolve the locale to start in: a previously-saved choice, else the closest
 * shipped match for the browser/device language (`ar-EG` → `ar`), else English.
 */
export function resolveInitialLocale(): string {
  try {
    const saved = globalThis.localStorage?.getItem(LOCALE_KEY);
    if (saved && isSupportedLocale(saved)) return saved;
  } catch { /* storage unavailable — fall through to navigator/default */ }
  const candidates = globalThis.navigator?.languages ?? [globalThis.navigator?.language ?? ""];
  for (const tag of candidates) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (base && isSupportedLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

// ── Active-locale store ──────────────────────────────────────────────────────
let activeLocale = resolveInitialLocale();
const listeners = new Set<() => void>();

/** The active locale code (snapshot for `useSyncExternalStore`). */
export function getLocaleSnapshot(): string {
  return activeLocale;
}

/** Subscribe to locale changes; returns an unsubscribe fn. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mirror the active locale onto `<html lang dir>` so the whole document (and CSS
 *  logical properties) flip for RTL. No-op outside a DOM. */
export function applyDocumentLocale(code: string = activeLocale): void {
  const el = globalThis.document?.documentElement;
  if (!el) return;
  el.lang = code;
  el.dir = dirForLocale(code);
}

/**
 * Switch the active locale: persist it, update `<html>`, and notify subscribers
 * (React consumers re-render). Unknown codes are ignored so a bad value can never
 * blank the UI.
 */
export function setLocale(code: string): void {
  if (!isSupportedLocale(code) || code === activeLocale) {
    if (code === activeLocale) applyDocumentLocale(code);
    return;
  }
  activeLocale = code;
  try { globalThis.localStorage?.setItem(LOCALE_KEY, code); } catch { /* quota — keep in memory */ }
  applyDocumentLocale(code);
  listeners.forEach((l) => l());
}

// ── Translation ──────────────────────────────────────────────────────────────

/** Interpolate `{name}` placeholders from `params`. Missing params are left as-is. */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole);
}

/**
 * Translate `key` in a specific locale. Falls back to English, then to the raw
 * key, so a missing translation degrades visibly-but-safely rather than crashing.
 * Pure — the single source of truth shared by the reactive `t` and by tests.
 */
export function translate(
  locale: string,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const catalog = CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE]!;
  const template = catalog[key] ?? CATALOGS[DEFAULT_LOCALE]![key] ?? key;
  return interpolate(template, params);
}

/** Translate `key` in the **active** locale. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(activeLocale, key, params);
}

// ── Locale-aware formatting (Intl — offline) ─────────────────────────────────

/** Format a number in a locale (Eastern-Arabic numerals for `ar`, etc.). */
export function formatNumber(
  value: number,
  locale: string = activeLocale,
  opts?: Intl.NumberFormatOptions,
): string {
  try {
    return new Intl.NumberFormat(locale, opts).format(value);
  } catch {
    return String(value);
  }
}

/** Format a timestamp (Unix ms or Date) as a localized date-time. */
export function formatDateTime(
  value: number | Date,
  locale: string = activeLocale,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  try {
    return new Intl.DateTimeFormat(locale, opts).format(value);
  } catch {
    return new Date(value).toISOString();
  }
}

/** Format a date-only value in a locale. */
export function formatDate(
  value: number | Date,
  locale: string = activeLocale,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  return formatDateTime(value, locale, opts);
}
