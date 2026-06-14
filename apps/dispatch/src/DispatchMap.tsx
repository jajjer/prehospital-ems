/**
 * This Source Code Form is subject to the terms of the Mozilla Public License,
 * v. 2.0. If a copy of the MPL was not distributed with this file, You can
 * obtain one at http://mozilla.org/MPL/2.0/. OpenMRS is also distributed under
 * the terms of the Healthcare Disclaimer located at http://openmrs.org/license.
 */
import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MAP_CENTER, MAP_STYLE_URL } from "./config.js";
import { C } from "./theme.js";
import type { ActiveCall } from "./fhir.js";

interface Props {
  calls: ActiveCall[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function DispatchMap({ calls, selectedId, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);
  const markersRef   = useRef(new Map<string, maplibregl.Marker>());

  // Initialize map once
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: MAP_CENTER,
      zoom: 11,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
  }, []);

  // Rebuild markers whenever calls or selection changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const m of markersRef.current.values()) m.remove();
    markersRef.current.clear();

    for (const call of calls) {
      if (!call.gps) continue;
      const isSelected = call.encounterId === selectedId;

      const el = document.createElement("div");
      el.style.cssText = [
        "width:28px;height:28px;border-radius:50%;",
        `background:${isSelected ? C.danger : C.primary};`,
        "border:2px solid #fff;cursor:pointer;",
        "box-shadow:0 2px 8px rgba(0,0,0,0.5);",
        "display:flex;align-items:center;justify-content:center;",
        "color:#fff;font-weight:700;font-size:12px;",
        "transition:background 0.15s;",
      ].join("");
      el.textContent = "!";
      el.addEventListener("click", () => onSelect(call.encounterId));

      const popup = new maplibregl.Popup({ offset: 20, closeButton: false, maxWidth: "200px" })
        .setHTML(
          `<div style="font-family:system-ui;font-size:12px;line-height:1.5">
            <strong>${call.mrn}</strong><br/>
            ${call.gender.charAt(0).toUpperCase()} &bull;
            ${new Date(call.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>`
        );

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([call.gps.lng, call.gps.lat])
        .setPopup(popup)
        .addTo(map);

      markersRef.current.set(call.encounterId, marker);
    }
  }, [calls, selectedId, onSelect]);

  // Pan to selected call
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const call = calls.find((c) => c.encounterId === selectedId);
    if (call?.gps) {
      map.flyTo({ center: [call.gps.lng, call.gps.lat], zoom: 14, duration: 600 });
    }
  }, [selectedId, calls]);

  const withGps = calls.filter((c) => c.gps).length;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {withGps === 0 && calls.length > 0 && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "none",
        }}>
          <div style={{
            background: "rgba(15,23,42,0.85)", borderRadius: 8,
            padding: "0.75rem 1.25rem", color: "#94a3b8", fontSize: "0.8125rem",
          }}>
            No GPS data — active calls captured without location
          </div>
        </div>
      )}
    </div>
  );
}
