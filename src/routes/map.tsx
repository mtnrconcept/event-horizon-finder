import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { discoverEvents, fetchCities, type DiscoveredEvent } from "@/lib/queries";
import { EventCard } from "@/components/event-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MapPin, Navigation, Ticket } from "lucide-react";

export const Route = createFileRoute("/map")({
  head: () => ({ meta: [{ title: "Carte des événements à Genève — EVENTA" }] }),
  component: MapPage,
});

const GENEVA_CENTER: [number, number] = [6.1432, 46.2044];

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

type City = {
  id: string;
  slug: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
};
type OccurrencePoint = { id: string; latitude: number | null; longitude: number | null };

function MapPage() {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [cities, setCities] = useState<City[]>([]);
  const [cityId, setCityId] = useState<string | null>(null);
  const [events, setEvents] = useState<DiscoveredEvent[]>([]);
  const [selected, setSelected] = useState<DiscoveredEvent | null>(null);
  const [loading, setLoading] = useState(true);

  const selectedCity = useMemo(
    () =>
      cities.find((city) => city.id === cityId) ??
      cities.find((city) => city.slug === "geneve") ??
      null,
    [cities, cityId],
  );

  useEffect(() => {
    fetchCities().then((data) => {
      const next = data as City[];
      setCities(next);
      setCityId(next.find((city) => city.slug === "geneve")?.id ?? next[0]?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const m = new maplibregl.Map({
      container: ref.current,
      style: OSM_STYLE as never,
      center: GENEVA_CENTER,
      zoom: 12,
    });
    m.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = m;
    return () => {
      m.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const m = mapRef.current;
    if (!m || !selectedCity?.latitude || !selectedCity.longitude) return;
    m.flyTo({
      center: [selectedCity.longitude, selectedCity.latitude],
      zoom: selectedCity.slug === "geneve" ? 12 : 11,
    });
  }, [selectedCity]);

  useEffect(() => {
    setLoading(true);
    discoverEvents({
      cityId,
      limit: 250,
      from: new Date(),
      to: new Date(Date.now() + 75 * 24 * 3600 * 1000),
    })
      .then(setEvents)
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [cityId]);

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    let cancelled = false;
    const markers: maplibregl.Marker[] = [];

    (async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      const ids = events.map((e) => e.occurrence_id);
      if (!ids.length) return;
      const { data } = await supabase
        .from("event_occurrences")
        .select("id,latitude,longitude")
        .in("id", ids);
      if (cancelled) return;

      const byId = new Map(((data as OccurrencePoint[] | null) ?? []).map((row) => [row.id, row]));
      const bounds = new maplibregl.LngLatBounds();
      events.forEach((ev) => {
        const row = byId.get(ev.occurrence_id);
        if (!row?.latitude || !row?.longitude) return;
        const el = document.createElement("button");
        el.className =
          "flex h-10 w-10 items-center justify-center rounded-full border-2 border-white text-xs font-black text-white shadow-xl transition-transform hover:scale-110";
        el.style.background = ev.is_free ? "oklch(0.72 0.18 35)" : "oklch(0.68 0.22 295)";
        el.textContent = ev.is_free ? "0" : "CHF";
        el.onclick = () => setSelected(ev);
        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([row.longitude, row.latitude])
          .addTo(m);
        markers.push(marker);
        bounds.extend([row.longitude, row.latitude]);
      });
      if (!bounds.isEmpty()) m.fitBounds(bounds, { padding: 80, maxZoom: 13, duration: 700 });
    })();

    return () => {
      cancelled = true;
      markers.forEach((mk) => mk.remove());
    };
  }, [events]);

  const freeCount = events.filter((event) => event.is_free).length;

  return (
    <div className="relative h-[calc(100vh-4rem)] w-full md:h-[calc(100vh-4rem)]">
      <div ref={ref} className="absolute inset-0" />

      <div className="glass absolute left-3 right-3 top-3 z-10 rounded-3xl p-3 shadow-[var(--shadow-card)] md:left-6 md:right-auto md:w-[26rem]">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <Badge className="mb-2 border-transparent bg-primary/15 text-primary">
              <MapPin className="mr-1 h-3.5 w-3.5" /> Carte live
            </Badge>
            <h1 className="text-xl font-black">Événements à {selectedCity?.name ?? "Genève"}</h1>
            <p className="text-xs text-muted-foreground">
              {loading
                ? "Chargement des points…"
                : `${events.length} sorties géolocalisées · ${freeCount} gratuites`}
            </p>
          </div>
          <Button
            size="icon"
            variant="secondary"
            onClick={() => mapRef.current?.flyTo({ center: GENEVA_CENTER, zoom: 12 })}
          >
            <Navigation className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex gap-2">
          <select
            value={cityId ?? ""}
            onChange={(event) => setCityId(event.target.value || null)}
            className="h-11 flex-1 rounded-2xl border bg-surface/80 px-3 text-sm outline-none focus:border-primary"
          >
            <option value="">Toutes les villes</option>
            {cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>
          <Badge variant="outline" className="h-11 rounded-2xl px-3">
            <Ticket className="mr-1.5 h-3.5 w-3.5" /> {freeCount} free
          </Badge>
        </div>
      </div>

      {selected && (
        <div className="absolute inset-x-3 bottom-24 z-10 md:inset-x-auto md:bottom-6 md:left-6 md:w-80">
          <div className="relative">
            <button
              onClick={() => setSelected(null)}
              className="glass absolute -top-3 right-2 z-20 h-7 w-7 rounded-full text-xs"
            >
              ×
            </button>
            <EventCard ev={selected} />
          </div>
        </div>
      )}
    </div>
  );
}
