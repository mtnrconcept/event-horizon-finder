import { createFileRoute } from "@tanstack/react-router";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  computeRange,
  discoverMapEvents,
  fetchCategories,
  fetchCities,
  fetchMapVenues,
  type DiscoveredEvent,
  type DiscoveredVenue,
  type QuickRange,
} from "@/lib/queries";
import {
  countAdvancedFilters,
  DEFAULT_ADVANCED_FILTERS,
  toDiscoveryFilters,
} from "@/lib/event-filters";
import { EventCard } from "@/components/event-card";
import { EventFilterPanel } from "@/components/event-filter-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trackClientEvent } from "@/lib/client-analytics";
import {
  Building2,
  CalendarDays,
  CircleAlert,
  MapPin,
  Navigation,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Ticket,
  Users,
} from "lucide-react";

export const Route = createFileRoute("/map")({
  head: () => ({ meta: [{ title: "Carte complète des événements et lieux — EVENTA" }] }),
  component: MapPage,
});

const GENEVA_CENTER: [number, number] = [6.1432, 46.2044];
const MAPBOX_ACCESS_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined;
const MAPBOX_STYLE = MAPBOX_ACCESS_TOKEN
  ? `https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=${MAPBOX_ACCESS_TOKEN}`
  : null;

const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

type City = {
  id: string;
  slug: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
};
type Category = { slug: string; name_fr: string; icon: string | null };

const MAP_RANGES: { value: QuickRange; label: string }[] = [
  { value: "tonight", label: "Ce soir" },
  { value: "today", label: "Aujourd'hui" },
  { value: "tomorrow", label: "Demain" },
  { value: "weekend", label: "Ce week-end" },
  { value: "week", label: "7 jours" },
  { value: "month", label: "30 jours" },
  { value: "year", label: "Tout à venir" },
];

function MapPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRegistryRef = useRef(
    new Map<string, { marker: maplibregl.Marker; signature: string }>(),
  );
  const [cities, setCities] = useState<City[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [cityId, setCityId] = useState<string | null>(null);
  const [range, setRange] = useState<QuickRange>("year");
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [advancedFilters, setAdvancedFilters] = useState({ ...DEFAULT_ADVANCED_FILTERS });
  const [events, setEvents] = useState<DiscoveredEvent[]>([]);
  const [venues, setVenues] = useState<DiscoveredVenue[]>([]);
  const [showEvents, setShowEvents] = useState(true);
  const [showVenues, setShowVenues] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<DiscoveredEvent | null>(null);
  const [selectedVenue, setSelectedVenue] = useState<DiscoveredVenue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [mapReady, setMapReady] = useState(false);

  const selectedCity = useMemo(
    () =>
      cities.find((city) => city.id === cityId) ??
      cities.find((city) => city.slug === "geneve") ??
      null,
    [cities, cityId],
  );
  const { from, to } = useMemo(() => computeRange(range), [range]);
  const advancedCount = countAdvancedFilters(advancedFilters);
  const visibleVenues = useMemo(() => {
    if (!deferredQuery) return venues;
    const needle = deferredQuery.toLocaleLowerCase("fr");
    return venues.filter((venue) =>
      [venue.name, venue.address, venue.city_name].some((value) =>
        value?.toLocaleLowerCase("fr").includes(needle),
      ),
    );
  }, [venues, deferredQuery]);

  useEffect(() => {
    Promise.all([fetchCities(), fetchCategories()]).then(([cityRows, categoryRows]) => {
      const nextCities = cityRows as City[];
      setCities(nextCities);
      setCategories(categoryRows as Category[]);
      setCityId(nextCities.find((city) => city.slug === "geneve")?.id ?? nextCities[0]?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const markerRegistry = markerRegistryRef.current;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAPBOX_STYLE ?? OSM_STYLE,
      center: GENEVA_CENTER,
      zoom: 12,
    });
    let switchedToFallback = false;
    const fallbackTimer = window.setTimeout(() => {
      if (!MAPBOX_STYLE || map.isStyleLoaded()) return;
      switchedToFallback = true;
      map.setStyle(OSM_STYLE);
    }, 6_000);
    map.on("load", () => setMapReady(true));
    map.on("styledata", () => {
      if (map.isStyleLoaded()) setMapReady(true);
    });
    map.on("error", () => {
      if (MAPBOX_STYLE && !switchedToFallback && !map.isStyleLoaded()) {
        switchedToFallback = true;
        map.setStyle(OSM_STYLE);
      }
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;
    return () => {
      window.clearTimeout(fallbackTimer);
      markerRegistry.clear();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || selectedCity?.latitude == null || selectedCity.longitude == null) return;
    map.flyTo({
      center: [selectedCity.longitude, selectedCity.latitude],
      zoom: selectedCity.slug === "geneve" ? 12 : 11,
    });
  }, [mapReady, selectedCity]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    Promise.all([
      discoverMapEvents({
        cityId,
        categorySlugs: cats.size ? [...cats] : null,
        query: deferredQuery,
        from,
        to,
        limit: 1500,
        ...toDiscoveryFilters(advancedFilters),
      }),
      fetchMapVenues(cityId),
    ])
      .then(([nextEvents, nextVenues]) => {
        if (!current) return;
        setEvents(nextEvents);
        setVenues(nextVenues);
        setSelectedEvent(null);
        setSelectedVenue(null);
      })
      .catch(() => {
        if (!current) return;
        setEvents([]);
        setVenues([]);
        setError("Impossible de charger les points de la carte. Réessaie dans un instant.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [cityId, cats, deferredQuery, from, to, advancedFilters, reloadKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const registry = markerRegistryRef.current;
    const desiredMarkerIds = new Set<string>();

    const removeStaleMarkers = () => {
      registry.forEach((entry, id) => {
        if (desiredMarkerIds.has(id)) return;
        entry.marker.remove();
        registry.delete(id);
      });
    };

    const replaceMarker = (
      id: string,
      signature: string,
      longitude: number,
      latitude: number,
      createButton: () => HTMLButtonElement,
    ) => {
      desiredMarkerIds.add(id);
      const existing = registry.get(id);
      if (existing?.signature === signature) return;
      existing?.marker.remove();

      // MapLibre owns the host transform; visual hover/rotation lives on the
      // child button so it can never override the marker's geographic position.
      const host = document.createElement("div");
      host.className = "eventa-map-marker-host";
      const button = createButton();
      const stopMapGesture = (event: Event) => event.stopPropagation();
      button.addEventListener("pointerdown", stopMapGesture);
      button.addEventListener("mousedown", stopMapGesture);
      button.addEventListener("touchstart", stopMapGesture, { passive: true });
      host.append(button);
      const marker = new maplibregl.Marker({ element: host, anchor: "center" })
        .setLngLat([longitude, latitude])
        .addTo(map);
      registry.set(id, { marker, signature });
    };

    if (showEvents) {
      events.forEach((event) => {
        if (event.latitude == null || event.longitude == null) return;
        const id = `event:${event.occurrence_id}`;
        const signature = [
          event.longitude,
          event.latitude,
          event.title,
          event.is_free,
          event.price_from,
          event.location_precision,
          cityId,
        ].join("|");
        replaceMarker(id, signature, event.longitude, event.latitude, () => {
          const markerButton = document.createElement("button");
          markerButton.type = "button";
          markerButton.className = "eventa-map-event-marker";
          markerButton.style.background = event.is_free
            ? "oklch(0.72 0.18 35)"
            : "oklch(0.68 0.22 295)";
          markerButton.style.borderStyle = event.location_precision === "city" ? "dashed" : "solid";
          markerButton.style.opacity = event.location_precision === "city" ? "0.86" : "1";
          markerButton.textContent = event.is_free
            ? "0"
            : event.price_from != null
              ? `${Math.round(event.price_from)}`
              : "★";
          markerButton.title = `${event.title}${event.location_precision === "city" ? " · position approximative" : ""}`;
          markerButton.setAttribute("aria-label", markerButton.title);
          markerButton.addEventListener("click", (clickEvent) => {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            setSelectedVenue(null);
            setSelectedEvent(event);
            void trackClientEvent("map_pin_click", {
              entityType: "event_occurrence",
              entityId: event.occurrence_id,
              cityId,
              metadata: { precision: event.location_precision },
            });
          });
          return markerButton;
        });
      });
    }

    if (showVenues) {
      visibleVenues.forEach((venue) => {
        const id = `venue:${venue.id}`;
        const signature = [
          venue.longitude,
          venue.latitude,
          venue.name,
          venue.location_precision,
          cityId,
        ].join("|");
        replaceMarker(id, signature, venue.longitude, venue.latitude, () => {
          const markerButton = document.createElement("button");
          markerButton.type = "button";
          markerButton.className = "eventa-map-venue-marker";
          markerButton.style.borderStyle = venue.location_precision === "city" ? "dashed" : "solid";
          markerButton.style.opacity = venue.location_precision === "city" ? "0.8" : "1";
          const label = document.createElement("span");
          label.textContent = "L";
          markerButton.append(label);
          markerButton.title = `${venue.name}${venue.location_precision === "city" ? " · position approximative" : ""}`;
          markerButton.setAttribute("aria-label", markerButton.title);
          markerButton.addEventListener("click", (clickEvent) => {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            setSelectedEvent(null);
            setSelectedVenue(venue);
            void trackClientEvent("map_pin_click", {
              entityType: "venue",
              entityId: venue.id,
              cityId,
              metadata: { precision: venue.location_precision },
            });
          });
          return markerButton;
        });
      });
    }

    removeStaleMarkers();
  }, [cityId, events, mapReady, visibleVenues, showEvents, showVenues]);

  const toggleCategory = (slug: string) => {
    setCats((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const resetFilters = () => {
    setRange("year");
    setCats(new Set());
    setQuery("");
    setAdvancedFilters({ ...DEFAULT_ADVANCED_FILTERS, genres: [] });
    setShowEvents(true);
    setShowVenues(true);
  };

  const freeCount = events.filter((event) => event.is_free).length;
  const approximateCount =
    events.filter((event) => event.location_precision === "city").length +
    visibleVenues.filter((venue) => venue.location_precision === "city").length;

  return (
    <div className="relative h-[calc(100vh-4rem)] w-full">
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" />
        {!mapReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/90">
            <div className="text-center">
              <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm font-medium">Chargement de la carte…</p>
              <p className="text-xs text-muted-foreground">
                OpenStreetMap prend automatiquement le relais
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="glass absolute left-3 right-3 top-3 z-10 max-h-[calc(100vh-6.5rem)] overflow-y-auto rounded-3xl p-3 shadow-[var(--shadow-card)] md:left-6 md:right-auto md:w-[30rem]">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <Badge className="mb-2 border-transparent bg-primary/15 text-primary">
              <MapPin className="mr-1 h-3.5 w-3.5" /> Carte complète
            </Badge>
            <h1 className="text-xl font-black">
              Sorties et lieux à {selectedCity?.name ?? "proximité"}
            </h1>
            <p className="text-xs text-muted-foreground">
              {loading
                ? "Chargement de tous les points…"
                : `${events.length} événements · ${visibleVenues.length} lieux · ${freeCount} gratuits`}
            </p>
          </div>
          <Button
            size="icon"
            variant="secondary"
            aria-label="Recentrer sur Genève"
            onClick={() => mapRef.current?.flyTo({ center: GENEVA_CENTER, zoom: 12 })}
          >
            <Navigation className="h-4 w-4" />
          </Button>
        </div>

        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Événement, artiste ou lieu…"
            className="h-11 rounded-2xl bg-background/80 pl-9"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <select
            value={cityId ?? ""}
            onChange={(event) => setCityId(event.target.value || null)}
            aria-label="Ville"
            className="h-11 rounded-2xl border bg-background/80 px-3 text-sm outline-none focus:border-primary"
          >
            <option value="">Toutes les villes</option>
            {cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>
          <select
            value={range}
            onChange={(event) => setRange(event.target.value as QuickRange)}
            aria-label="Dates"
            className="h-11 rounded-2xl border bg-background/80 px-3 text-sm outline-none focus:border-primary"
          >
            {MAP_RANGES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>

        <div className="no-scrollbar my-3 flex gap-1.5 overflow-x-auto pb-1">
          {categories.map((category) => (
            <button
              key={category.slug}
              type="button"
              aria-pressed={cats.has(category.slug)}
              onClick={() => toggleCategory(category.slug)}
              className="shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium hover:bg-accent"
              style={
                cats.has(category.slug)
                  ? { borderColor: "var(--color-primary)", color: "var(--color-primary)" }
                  : undefined
              }
            >
              {category.icon ? `${category.icon} ` : ""}
              {category.name_fr}
            </button>
          ))}
        </div>

        <details className="rounded-2xl border" open={advancedCount > 0}>
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-semibold">
            <span className="inline-flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-primary" /> Filtres avancés
            </span>
            <Badge variant={advancedCount ? "default" : "outline"}>{advancedCount || "Tous"}</Badge>
          </summary>
          <div className="border-t p-3">
            <EventFilterPanel value={advancedFilters} onChange={setAdvancedFilters} compact />
          </div>
        </details>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <LayerToggle
            active={showEvents}
            icon={CalendarDays}
            label={`Événements (${events.length})`}
            onClick={() => setShowEvents((value) => !value)}
          />
          <LayerToggle
            active={showVenues}
            icon={Building2}
            label={`Lieux (${visibleVenues.length})`}
            onClick={() => setShowVenues((value) => !value)}
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span>{approximateCount} positions ville signalées en pointillés</span>
          <button
            type="button"
            onClick={resetFilters}
            className="inline-flex shrink-0 items-center gap-1 font-semibold hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" /> Réinitialiser
          </button>
        </div>

        {error && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 p-3 text-xs text-destructive">
            <span className="flex items-center gap-1.5">
              <CircleAlert className="h-4 w-4 shrink-0" /> {error}
            </span>
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Réessayer
            </button>
          </div>
        )}
      </div>

      {selectedEvent && (
        <div className="absolute inset-x-3 bottom-20 z-10 md:inset-x-auto md:bottom-6 md:left-[32rem] md:w-80">
          <div className="relative">
            <button
              type="button"
              aria-label="Fermer la fiche"
              onClick={() => setSelectedEvent(null)}
              className="glass absolute -top-3 right-2 z-20 h-7 w-7 rounded-full text-xs"
            >
              ×
            </button>
            <EventCard ev={selectedEvent} />
          </div>
        </div>
      )}

      {selectedVenue && (
        <div className="glass absolute inset-x-3 bottom-20 z-10 rounded-3xl p-5 shadow-[var(--shadow-card)] md:inset-x-auto md:bottom-6 md:left-[32rem] md:w-80">
          <button
            type="button"
            aria-label="Fermer la fiche"
            onClick={() => setSelectedVenue(null)}
            className="absolute right-3 top-3 h-7 w-7 rounded-full border text-xs"
          >
            ×
          </button>
          <Badge variant="outline" className="mb-3">
            <Building2 className="mr-1 h-3.5 w-3.5" /> Lieu
          </Badge>
          <h2 className="pr-8 text-xl font-black">{selectedVenue.name}</h2>
          <p className="mt-2 flex items-start gap-2 text-sm text-muted-foreground">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
            {selectedVenue.address ?? selectedVenue.city_name ?? "Adresse non précisée"}
          </p>
          {selectedVenue.capacity != null && (
            <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4" /> Jusqu'à {selectedVenue.capacity.toLocaleString("fr-CH")}{" "}
              personnes
            </p>
          )}
          {selectedVenue.location_precision === "city" && (
            <p className="mt-3 rounded-2xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Position approximative au niveau de la ville — l'adresse exacte n'est pas encore
              renseignée.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LayerToggle({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof Ticket;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="flex h-10 items-center justify-center gap-2 rounded-2xl border px-2 text-xs font-semibold"
      style={
        active
          ? {
              borderColor: "var(--color-primary)",
              color: "var(--color-primary)",
              background: "var(--color-accent)",
            }
          : { opacity: 0.65 }
      }
    >
      <Icon className="h-4 w-4" /> {label}
    </button>
  );
}
