import { useState, useEffect } from "react";
import { db } from "@prehospital-ems/sync-engine";

export function QueueStatus() {
  const [queueCount, setQueueCount] = useState(0);
  const [deadCount, setDeadCount] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const refresh = () => {
      void db.writeQueue.count().then(setQueueCount);
      void db.deadLetter.count().then(setDeadCount);
    };
    refresh();
    const id = setInterval(refresh, 3_000);

    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      clearInterval(id);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return (
    <div style={{ marginTop: "2rem", fontSize: "0.75rem", color: "#6b7280", borderTop: "1px solid #e5e7eb", paddingTop: "1rem" }}>
      <div>Network: <strong style={{ color: online ? "#166534" : "#dc2626" }}>{online ? "online" : "offline"}</strong></div>
      <div>Queued: {queueCount}</div>
      {deadCount > 0 && (
        <div style={{ color: "#dc2626" }}>Dead-lettered: {deadCount} — check console</div>
      )}
    </div>
  );
}
