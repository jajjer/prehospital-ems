import { useState } from "react";
import { CaptureForm } from "./CaptureForm.js";
import { QueueStatus } from "./QueueStatus.js";

export function App() {
  const [submitted, setSubmitted] = useState(false);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "1rem", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "1rem" }}>
        EMS Field Capture
      </h1>
      {submitted ? (
        <div>
          <p style={{ color: "#166534", marginBottom: "1rem" }}>
            ✓ Queued for sync
          </p>
          <button onClick={() => setSubmitted(false)} style={btnStyle}>
            New patient
          </button>
        </div>
      ) : (
        <CaptureForm onSubmit={() => setSubmitted(true)} />
      )}
      <QueueStatus />
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "0.5rem 1rem",
  cursor: "pointer",
  fontSize: "0.875rem",
};
