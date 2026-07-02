/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
/**
 * React bindings for the i18n core (issue #16). `I18nProvider` subscribes to the
 * external locale store via `useSyncExternalStore`, so switching language re-renders
 * every consumer of `useT` / `useLocale` — no reload, works offline.
 */
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  subscribe,
  getLocaleSnapshot,
  translate,
  setLocale,
  dirForLocale,
  formatNumber,
  formatDateTime,
  formatDate,
  applyDocumentLocale,
  type MessageKey,
  type Dir,
} from "./index.js";

/** Everything a component needs to render in the active locale. */
export interface I18n {
  locale: string;
  dir: Dir;
  /** Translate a key (active locale) with optional `{placeholder}` params. */
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  setLocale: (code: string) => void;
  formatNumber: (value: number, opts?: Intl.NumberFormatOptions) => string;
  formatDateTime: (value: number | Date, opts?: Intl.DateTimeFormatOptions) => string;
  formatDate: (value: number | Date, opts?: Intl.DateTimeFormatOptions) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribe, getLocaleSnapshot, getLocaleSnapshot);

  const value = useMemo<I18n>(() => ({
    locale,
    dir: dirForLocale(locale),
    t: (key, params) => translate(locale, key, params),
    setLocale,
    formatNumber: (v, opts) => formatNumber(v, locale, opts),
    formatDateTime: (v, opts) => formatDateTime(v, locale, opts),
    formatDate: (v, opts) => formatDate(v, locale, opts),
  }), [locale]);

  // Keep <html lang dir> in sync with the rendered locale (also covers the very
  // first paint, where main.tsx applied it pre-render).
  applyDocumentLocale(locale);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Access the full i18n API (locale, dir, setLocale, formatters). */
export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <I18nProvider>");
  return ctx;
}

/** Shorthand for the common case — just the translate function. */
export function useT(): I18n["t"] {
  return useI18n().t;
}
