/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
/**
 * Language selector (issue #16). Switches the active locale instantly and fully
 * offline — the catalogs are bundled, so no network is involved. Rendered in
 * Settings (reachable pre-login too, so a device can be set to its local language
 * before anyone signs in).
 */
import { LOCALES } from "./i18n/index.js";
import { useI18n } from "./i18n/react.js";
import { C, FONT } from "./theme.js";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div style={{ marginBottom: "1rem" }}>
      <label htmlFor="lang-select" style={labelStyle}>{t("lang.label")}</label>
      <select
        id="lang-select"
        value={locale}
        onChange={(e) => setLocale(e.target.value)}
        style={selectStyle}
      >
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}{l.name !== l.englishName ? ` (${l.englishName})` : ""}
          </option>
        ))}
      </select>
      <p style={{ color: C.muted, fontSize: "0.6875rem", margin: "0.25rem 0 0" }}>{t("lang.hint")}</p>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: "0.75rem", color: C.label, marginBottom: "0.375rem", fontWeight: 600,
};
const selectStyle: React.CSSProperties = {
  background: "#162032", border: `1px solid ${C.border}`,
  borderRadius: 6, padding: "0.625rem 0.75rem",
  color: C.text, fontFamily: FONT, fontSize: "0.875rem",
  outline: "none", width: "100%", boxSizing: "border-box",
};
