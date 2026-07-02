/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useState } from "react";
import { setupPin, unlockWithPin, MIN_PIN_LENGTH, MAX_PIN_ATTEMPTS } from "@prehospital-ems/sync-engine";
import { C, FONT } from "./theme.js";
import { useI18n } from "./i18n/react.js";

interface Props {
  /** "create" provisions a new PIN; "unlock" verifies an existing one. */
  mode: "create" | "unlock";
  /** Called after a PIN is successfully created or entered. */
  onDone: () => void;
}

const MAX_PIN_LENGTH = 8;

/**
 * Offline app-lock screen (issue #2). Works with no connectivity — it only
 * derives/verifies the at-rest key locally. Locking never drops the offline
 * queue; it only re-arms the encryption gate.
 */
export function LockScreen({ mode, onDone }: Props) {
  const { t, formatNumber } = useI18n();
  // In "create" mode the user enters a PIN, then re-enters it to confirm.
  const [stage, setStage] = useState<"enter" | "confirm">("enter");
  const [pin, setPin] = useState("");
  const [firstPin, setFirstPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const creating = mode === "create";
  const title = creating
    ? (stage === "enter" ? t("lock.createTitle") : t("lock.confirmTitle"))
    : t("lock.enterTitle");
  const subtitle = creating
    ? t("lock.createSubtitle")
    : t("lock.unlockSubtitle");

  function press(digit: string) {
    if (busy) return;
    setError("");
    setPin((p) => (p.length >= MAX_PIN_LENGTH ? p : p + digit));
  }

  function backspace() {
    if (busy) return;
    setPin((p) => p.slice(0, -1));
  }

  async function submit() {
    if (pin.length < MIN_PIN_LENGTH || busy) return;
    setBusy(true);
    setError("");
    try {
      if (creating) {
        if (stage === "enter") {
          setFirstPin(pin);
          setPin("");
          setStage("confirm");
          return;
        }
        if (pin !== firstPin) {
          setError(t("lock.pinMismatch"));
          setFirstPin("");
          setPin("");
          setStage("enter");
          return;
        }
        await setupPin(pin);
        onDone();
        return;
      }

      const result = await unlockWithPin(pin);
      if (result.ok) {
        onDone();
        return;
      }
      if (result.wiped) {
        // Too many failed attempts: data has been wiped. Reload to a clean state.
        window.location.reload();
        return;
      }
      setPin("");
      setError(
        result.remaining !== undefined
          ? (result.remaining === 1
            ? t("lock.wrongPinRemainingOne")
            : t("lock.wrongPinRemaining", { count: formatNumber(result.remaining) }))
          : t("lock.wrongPin"),
      );
    } catch {
      setError(t("lock.genericError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      minHeight: "100dvh", background: C.bg, color: C.text, fontFamily: FONT,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "1.5rem", boxSizing: "border-box",
    }}>
      <div style={{ width: "100%", maxWidth: 320, textAlign: "center" }}>
        <div style={{
          background: C.primary, color: "#fff", borderRadius: 6, display: "inline-block",
          padding: "0.15rem 0.5rem", fontSize: "0.75rem", fontWeight: 700,
          letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "1.25rem",
        }}>EMS</div>

        <h1 style={{ fontSize: "1.25rem", fontWeight: 700, margin: "0 0 0.4rem" }}>{title}</h1>
        <p style={{ color: C.muted, fontSize: "0.875rem", margin: "0 0 1.75rem", lineHeight: 1.4 }}>
          {subtitle}
        </p>

        {/* PIN dots */}
        <div style={{ display: "flex", justifyContent: "center", gap: "0.625rem", marginBottom: "1.5rem", minHeight: 16 }}>
          {Array.from({ length: Math.max(pin.length, MIN_PIN_LENGTH) }).map((_, i) => (
            <span key={i} style={{
              width: 14, height: 14, borderRadius: "50%",
              background: i < pin.length ? C.text : "transparent",
              border: `2px solid ${i < pin.length ? C.text : C.border}`,
              boxSizing: "border-box",
            }} />
          ))}
        </div>

        <div style={{ color: C.danger, fontSize: "0.8125rem", minHeight: "1.25rem", marginBottom: "0.75rem" }}>
          {error}
        </div>

        {/* Keypad */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem" }}>
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
            <KeyButton key={d} onClick={() => press(d)}>{d}</KeyButton>
          ))}
          <KeyButton onClick={backspace} aria-label={t("lock.delete")}>⌫</KeyButton>
          <KeyButton onClick={() => press("0")}>0</KeyButton>
          <KeyButton
            onClick={() => void submit()}
            disabled={pin.length < MIN_PIN_LENGTH || busy}
            variant="primary"
            aria-label={creating && stage === "enter" ? t("lock.next") : creating ? t("lock.setPin") : t("lock.unlock")}
          >
            {busy ? "…" : "→"}
          </KeyButton>
        </div>

        {!creating && (
          <p style={{ color: C.muted, fontSize: "0.6875rem", marginTop: "1.5rem", lineHeight: 1.4 }}>
            {t("lock.eraseWarning", { count: formatNumber(MAX_PIN_ATTEMPTS) })}
          </p>
        )}
      </div>
    </div>
  );
}

function KeyButton({
  children, onClick, disabled, variant, "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary";
  "aria-label"?: string;
}) {
  const primary = variant === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{
        height: 64, borderRadius: 12,
        background: primary ? (disabled ? C.border : C.primary) : C.surface,
        border: `1px solid ${C.border}`,
        color: primary ? "#fff" : C.text,
        fontFamily: FONT, fontSize: primary ? "1.5rem" : "1.5rem", fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        userSelect: "none", touchAction: "manipulation",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {children}
    </button>
  );
}
