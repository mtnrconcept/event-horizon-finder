import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { discoverEvents, type DiscoveredEvent } from "@/lib/queries";
import { EventCard } from "@/components/event-card";

export const Route = createFileRoute("/map")({
  head: () => ({ meta: [{ title: "Carte des événements — EVENTA" }] }),
  component: MapPage,
});

/** MapLibre adapter — swap OSM tiles for MapTiler/Stadia by changing STYLE. */
const OSM_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster" as const, source: "osm" }],
  glyphs: undefined,
};

function MapPage() {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [events, setEvents] = useState<DiscoveredEvent[]>([]);
  const [selected, setSelected] = useState<DiscoveredEvent | null>(null);

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const m = new maplibregl.Map({
      container: ref.current,
      style: OSM_STYLE as never,
      center: [2.35, 48.85],
      zoom: 4.2,
    });
    m.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = m;
    return () => { m.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    discoverEvents({ limit: 200, from: new Date(), to: new Date(Date.now() + 60 * 24 * 3600 * 1000) }).then(setEvents);
  }, []);

  useEffect(() => {
    const m = mapRef.current; if (!m) return;
    const markers: maplibregl.Marker[] = [];
    events.forEach((ev) => {
      // Distance & coords come only via geo RPC; we fall back to venue geocoding via query.
      // For now we don't have lat/lon per event on the RPC result; skip if missing.
    });
    // Fetch occurrence coords in one query
    (async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      const ids = events.map((e) => e.occurrence_id);
      if (!ids.length) return;
      const { data } = await supabase.from("event_occurrences").select("id,latitude,longitude").in("id", ids);
      const byId = new Map((data ?? []).map((r) => [r.id as string, r]));
      events.forEach((ev) => {
        const row = byId.get(ev.occurrence_id);
        if (!row?.latitude || !row?.longitude) return;
        const el = document.createElement("button");
        el.className = "flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold text-white shadow-lg";
        el.style.background = ev.is_free ? "oklch(0.72 0.18 35)" : "oklch(0.68 0.22 295)";
        el.textContent = ev.is_free ? "€0" : "€";
        el.onclick = () => setSelected(ev);
        const marker = new maplibregl.Marker({ element: el }).setLngLat([row.longitude, row.latitude]).addTo(m);
        markers.push(marker);
      });
    })();
    return () => { markers.forEach((mk) => mk.remove()); };
  }, [events]);

  return (
    <div className="relative h-[calc(100vh-4rem)] w-full md:h-[calc(100vh-4rem)]">
      <div ref={ref} className="absolute inset-0" />
      {selected && (
        <div className="absolute inset-x-3 bottom-24 z-10 md:inset-x-auto md:bottom-6 md:left-6 md:w-80">
          <div className="relative">
            <button onClick={() => setSelected(null)} className="glass absolute -top-3 right-2 z-20 h-7 w-7 rounded-full text-xs">×</button>
            <EventCard ev={selected} />
          </div>
        </div>
      )}
    </div>
  );
}
