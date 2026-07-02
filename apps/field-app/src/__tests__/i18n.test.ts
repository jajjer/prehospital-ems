/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LOCALES,
  DEFAULT_LOCALE,
  isSupportedLocale,
  dirForLocale,
  resolveInitialLocale,
  translate,
  t,
  setLocale,
  getLocaleSnapshot,
  subscribe,
  formatNumber,
  formatDateTime,
  type MessageKey,
} from "../i18n/index.js";
import { en } from "../i18n/locales/en.js";
import { sw } from "../i18n/locales/sw.js";
import { ar } from "../i18n/locales/ar.js";

function installLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
  return store;
}

describe("i18n (issue #16)", () => {
  beforeEach(() => {
    installLocalStorage();
    setLocale("en");
  });
  afterEach(() => {
    setLocale("en");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("catalog completeness", () => {
    const enKeys = Object.keys(en).sort();
    it("Swahili covers every English key", () => {
      expect(Object.keys(sw).sort()).toEqual(enKeys);
    });
    it("Arabic covers every English key", () => {
      expect(Object.keys(ar).sort()).toEqual(enKeys);
    });
    it("no locale leaves a value blank", () => {
      for (const catalog of [en, sw, ar]) {
        for (const v of Object.values(catalog)) expect(v.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe("translate", () => {
    it("returns the locale's string", () => {
      expect(translate("en", "status.live")).toBe("Live");
      expect(translate("sw", "status.live")).toBe("Mtandaoni");
      expect(translate("ar", "status.live")).toBe("متصل");
    });

    it("interpolates {placeholder} params", () => {
      expect(translate("en", "status.queued", { count: 3 })).toBe("3 queued");
      expect(translate("en", "app.clockSkew", { minutes: 7 })).toContain("~7 min");
    });

    it("leaves unknown placeholders intact", () => {
      expect(translate("en", "status.queued")).toBe("{count} queued");
    });

    it("falls back to English for an unknown locale", () => {
      expect(translate("zz", "status.live")).toBe("Live");
    });

    it("falls back to the raw key when the key is unknown", () => {
      expect(translate("en", "does.not.exist" as MessageKey)).toBe("does.not.exist");
    });
  });

  describe("active locale + reactivity", () => {
    it("t() follows setLocale and notifies subscribers", () => {
      const seen: string[] = [];
      const unsub = subscribe(() => seen.push(getLocaleSnapshot()));
      expect(t("nav.settings")).toBe("Settings");
      setLocale("sw");
      expect(getLocaleSnapshot()).toBe("sw");
      expect(t("nav.settings")).toBe("Mipangilio");
      expect(seen).toEqual(["sw"]);
      unsub();
      setLocale("ar");
      // After unsubscribe the listener stops firing, but the locale still changes.
      expect(seen).toEqual(["sw"]);
      expect(t("nav.settings")).toBe("الإعدادات");
    });

    it("ignores unsupported locales", () => {
      setLocale("sw");
      setLocale("zz");
      expect(getLocaleSnapshot()).toBe("sw");
    });

    it("persists the choice to localStorage", () => {
      const store = installLocalStorage();
      setLocale("ar");
      expect(store.get("ems_locale")).toBe("ar");
    });
  });

  describe("locale metadata", () => {
    it("knows RTL for Arabic and LTR otherwise", () => {
      expect(dirForLocale("ar")).toBe("rtl");
      expect(dirForLocale("en")).toBe("ltr");
      expect(dirForLocale("sw")).toBe("ltr");
      expect(dirForLocale("zz")).toBe("ltr");
    });
    it("isSupportedLocale reflects the shipped set", () => {
      expect(LOCALES.map((l) => l.code)).toEqual(["en", "sw", "ar"]);
      expect(isSupportedLocale("sw")).toBe(true);
      expect(isSupportedLocale("de")).toBe(false);
    });
  });

  describe("resolveInitialLocale", () => {
    it("prefers a saved supported locale", () => {
      const store = installLocalStorage();
      store.set("ems_locale", "ar");
      expect(resolveInitialLocale()).toBe("ar");
    });
    it("falls back to the device language, then the default", () => {
      installLocalStorage();
      vi.stubGlobal("navigator", { languages: ["sw-KE", "en"] });
      expect(resolveInitialLocale()).toBe("sw");
      vi.stubGlobal("navigator", { languages: ["de-DE"] });
      expect(resolveInitialLocale()).toBe(DEFAULT_LOCALE);
    });
  });

  describe("locale-aware formatting (Intl, offline)", () => {
    it("formats numbers per locale", () => {
      expect(formatNumber(1234, "en")).toBe("1,234");
      // Grouping is locale-specific (German uses a dot as the thousands separator).
      expect(formatNumber(1234, "de")).toBe("1.234");
      // Eastern-Arabic-Indic numerals are available offline via Intl (the default
      // numbering system for `ar` is platform-dependent, so request it explicitly).
      expect(formatNumber(3, "ar-u-nu-arab")).toBe("٣");
    });
    it("formats a timestamp without throwing", () => {
      const ts = Date.UTC(2026, 0, 15, 9, 30);
      expect(typeof formatDateTime(ts, "en")).toBe("string");
      expect(formatDateTime(ts, "en").length).toBeGreaterThan(0);
    });
  });
});
