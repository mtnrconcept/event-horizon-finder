import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefCallback,
} from "react";
import maplibregl, {
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type MapLayerMouseEvent,
  type MapMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  computeRange,
  discoverAllMapPins,
  discoverEventStats,
  discoverMapEvents,
  fetchCategories,
  fetchGeographies,
  fetchMapOccurrencePreviews,
  searchGeographyCities,
  type CityOption,
  type CountryOption,
  type DiscoveryStats,
  type DiscoveredEvent,
  type QuickRange,
  type RegionOption,
} from "@/lib/queries";
import type { CompactMapPin } from "@/lib/map-pins";
import {
  chunkOccurrenceIds,
  mapPreviewExcerpt,
  mapPreviewVenueNames,
  type MapOccurrencePreview,
} from "@/lib/map-occurrence-previews";
import {
  countAdvancedFilters,
  DEFAULT_ADVANCED_FILTERS,
  toDiscoveryFilters,
} from "@/lib/event-filters";
import { EventCard, EventCardSkeleton } from "@/components/event-card";
import { EventFilterPanel } from "@/components/event-filter-panel";
import { MobileDiscoveryLayout } from "@/components/discovery/MobileDiscoveryLayout";
import { GeographyFilter, type GeographySelection } from "@/components/geography-filter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trackClientEvent } from "@/lib/client-analytics";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useTranslation } from "@/lib/i18n";
import type { UiTranslationPhrase } from "@/lib/ui-translations";
import {
  buildCompactMapPointCollection,
  buildMapPointCollection,
  isMapCoordinatePlausibleForCountry,
  type MapPointCollection,
  type MapPointProperties,
} from "@/lib/map-clusters";
import {
  eventCategoryTextColor,
  eventCategoryVisual,
  registerEventCategoryImages,
} from "@/lib/event-category-style";
import {
  EVENT_CLUSTER_MAX_ZOOM,
  EVENT_CLUSTER_RADIUS,
  EVENT_SOURCE_MAX_ZOOM,
  clusterExpansionTargetZoom,
  eventClusterCircleRadiusExpression,
  eventClusterTextSizeExpression,
  loadAllClusterLeaves,
  shouldOpenClusterSelection,
} from "@/lib/map-cluster-config";
import {
  selectHighestPriorityMapHit,
  selectNearestMapHit,
  type MapHitCandidate,
  type MapHitKind,
} from "@/lib/map-interactions";
import {
  CalendarDays,
  CircleAlert,
  Clock,
  LoaderCircle,
  MapPin,
  Navigation,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Ticket,
} from "lucide-react";
import { loadAllPages } from "@/lib/load-all-pages";

export const Route = createFileRoute("/map")({
  head: () => ({ meta: [{ title: "Carte complète des événements — Global Party" }] }),
  component: MapPage,
});

const GENEVA_CENTER: [number, number] = [6.1432, 46.2044];
const PRIMARY_MAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

const RASTER_FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    basemap: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    { id: "map-background", type: "background", paint: { "background-color": "#e8eef2" } },
    { id: "poi-free-basemap", type: "raster", source: "basemap" },
  ],
};

type Category = { slug: string; name_fr: string; icon: string | null };
const MAP_EVENT_PAGE_SIZE = 1_000;
const MOBILE_LIST_BATCH_SIZE = 24;
const COUNT_FORMATTER = new Intl.NumberFormat("fr-CH");
const MAP_EVENT_SOURCE_ID = "eventa-map-events";
const MAP_CLUSTER_HALO_LAYER_ID = "eventa-map-cluster-halo";
const MAP_CLUSTER_LAYER_ID = "eventa-map-clusters";
const MAP_CLUSTER_COUNT_LAYER_ID = "eventa-map-cluster-count";
const MAP_EVENT_POINT_LAYER_ID = "eventa-map-event-points";
const MAP_EVENT_LABEL_LAYER_ID = "eventa-map-event-labels";
const MOBILE_MAP_HIT_RADIUS = 24;
const DESKTOP_MAP_HIT_RADIUS = 8;
const CLUSTER_PREVIEW_CONCURRENCY = 4;
const CLUSTER_HOVER_SAMPLE_SIZE = 12;
const MAP_HOVER_DELAY_MS = 120;

const MAP_RANGES: { value: QuickRange; label: UiTranslationPhrase }[] = [
  { value: "tonight", label: "Ce soir" },
  { value: "today", label: "Aujourd'hui" },
  { value: "tomorrow", label: "Demain" },
  { value: "weekend", label: "Ce week-end" },
  { value: "week", label: "7 jours" },
  { value: "month", label: "30 jours" },
  { value: "year", label: "Tout à venir" },
];

function mapFeatureHitKind(feature: MapGeoJSONFeature): MapHitKind | null {
  if (feature.layer.id === MAP_CLUSTER_LAYER_ID || feature.layer.id === MAP_CLUSTER_HALO_LAYER_ID)
    return "cluster";
  if (feature.layer.id === MAP_EVENT_POINT_LAYER_ID) return "event";
  return null;
}

function hideBasemapPoiLayers(map: maplibregl.Map) {
  for (const layer of map.getStyle().layers ?? []) {
    if (/^(?:eventa-map-)/.test(layer.id)) continue;
    if (/(?:^|[-_])(?:poi|transit|airport|station|ferry)(?:[-_]|$)/i.test(layer.id)) {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
  }
}

function syncClusterLayers(map: maplibregl.Map, eventPoints: MapPointCollection) {
  hideBasemapPoiLayers(map);
  const existingEventSource = map.getSource(MAP_EVENT_SOURCE_ID) as GeoJSONSource | undefined;
  if (existingEventSource) {
    existingEventSource.setData(eventPoints);
  } else {
    map.addSource(MAP_EVENT_SOURCE_ID, {
      type: "geojson",
      data: eventPoints,
      cluster: true,
      clusterMaxZoom: EVENT_CLUSTER_MAX_ZOOM,
      clusterRadius: EVENT_CLUSTER_RADIUS,
      maxzoom: EVENT_SOURCE_MAX_ZOOM,
      clusterProperties: {
        free_count: ["+", ["case", ["==", ["get", "is_free"], 1], 1, 0]],
      },
    });
  }

  registerEventCategoryImages(map);

  if (!map.getLayer(MAP_EVENT_POINT_LAYER_ID)) {
    map.addLayer({
      id: MAP_EVENT_POINT_LAYER_ID,
      type: "circle",
      source: MAP_EVENT_SOURCE_ID,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": ["get", "category_color"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 9, 12, 13, 16, 18],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 16, 3],
        "circle-opacity": ["case", ["==", ["get", "approximate"], 1], 0.68, 1],
      },
    });
  }

  if (!map.getLayer(MAP_EVENT_LABEL_LAYER_ID)) {
    map.addLayer({
      id: MAP_EVENT_LABEL_LAYER_ID,
      type: "symbol",
      source: MAP_EVENT_SOURCE_ID,
      filter: ["!", ["has", "point_count"]],
      layout: {
        "icon-image": ["get", "category_icon_image"],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.54, 12, 0.74, 16, 1],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: {
        "icon-opacity": ["case", ["==", ["get", "approximate"], 1], 0.78, 1],
      },
    });
  }

  if (!map.getLayer(MAP_CLUSTER_HALO_LAYER_ID)) {
    map.addLayer({
      id: MAP_CLUSTER_HALO_LAYER_ID,
      type: "circle",
      source: MAP_EVENT_SOURCE_ID,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "#a855f7",
        "circle-radius": ["+", eventClusterCircleRadiusExpression(), 9],
        "circle-opacity": 0.28,
        "circle-blur": 0.55,
      },
    });
  }

  if (!map.getLayer(MAP_CLUSTER_LAYER_ID)) {
    map.addLayer({
      id: MAP_CLUSTER_LAYER_ID,
      type: "circle",
      source: MAP_EVENT_SOURCE_ID,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": [
          "step",
          ["get", "point_count"],
          "#7c3aed",
          50,
          "#9333ea",
          250,
          "#c026d3",
          1_000,
          "#ea580c",
          5_000,
          "#dc2626",
        ],
        "circle-radius": eventClusterCircleRadiusExpression(),
        "circle-stroke-color": "rgba(255,255,255,0.92)",
        "circle-stroke-width": 3.5,
        "circle-opacity": 0.97,
        "circle-blur": 0,
      },
    });
  }

  if (!map.getLayer(MAP_CLUSTER_COUNT_LAYER_ID)) {
    map.addLayer({
      id: MAP_CLUSTER_COUNT_LAYER_ID,
      type: "symbol",
      source: MAP_EVENT_SOURCE_ID,
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["to-string", ["get", "point_count"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": eventClusterTextSizeExpression(),
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(38, 10, 61, 0.7)",
        "text-halo-width": 1.5,
      },
    });
  }
}

function MapSurface({
  containerRef,
  mapReady,
  mapUnavailable,
}: {
  containerRef: RefCallback<HTMLDivElement>;
  mapReady: boolean;
  mapUnavailable: string | null;
}) {
  const { tr } = useTranslation();
  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className={mapUnavailable ? "hidden" : "h-full w-full"} />
      {mapUnavailable && (
        <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_70%_20%,oklch(0.68_0.22_295_/_0.18),transparent_32%),linear-gradient(135deg,var(--color-background),var(--color-muted))] p-6">
          <div className="max-w-md text-center md:ml-[30rem]">
            <MapPin className="mx-auto mb-4 h-10 w-10 text-primary" />
            <h2 className="text-xl font-black">{tr("Carte en mode accessible")}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{mapUnavailable}</p>
            <a
              href="https://www.openstreetmap.org/#map=12/46.2044/6.1432"
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground"
            >
              {tr("Ouvrir Genève dans OpenStreetMap")}
            </a>
          </div>
        </div>
      )}
      {!mapUnavailable && !mapReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/90">
          <div className="text-center">
            <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm font-medium">{tr("Chargement de la carte…")}</p>
            <p className="text-xs text-muted-foreground">
              {tr("OpenStreetMap prend automatiquement le relais")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function formatMobileEventDate(
  event: Pick<DiscoveredEvent, "starts_at" | "timezone"> | MapOccurrencePreview,
  locale: string,
): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: event.timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(event.starts_at));
  } catch {
    return new Date(event.starts_at).toLocaleString(locale);
  }
}

function MobileSelectedEvent({ event, onClose }: { event: DiscoveredEvent; onClose: () => void }) {
  const { tr, localeTag } = useTranslation();
  return (
    <aside className="relative p-3 pr-14" aria-label={`Événement sélectionné : ${event.title}`}>
      <button
        type="button"
        aria-label={tr("Fermer la fiche")}
        onClick={onClose}
        className="absolute right-3 top-3 grid h-11 w-11 place-items-center rounded-full border bg-surface text-lg"
      >
        ×
      </button>
      <Badge className="mb-1.5 border-transparent bg-primary/15 text-primary">
        {tr("Événement sélectionné")}
      </Badge>
      <h2 className="line-clamp-1 text-base font-black">{event.title}</h2>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3.5 w-3.5 shrink-0" /> {formatMobileEventDate(event, localeTag)}
      </p>
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {event.venue_name ?? event.city_name ?? tr("Lieu à confirmer")}
        </p>
        <Link
          to="/event/$slug"
          params={{ slug: event.slug }}
          className="inline-flex min-h-11 shrink-0 items-center rounded-xl bg-primary px-3 text-xs font-black text-primary-foreground"
        >
          {tr("Voir la fiche")}
        </Link>
      </div>
    </aside>
  );
}

function SelectedClusterEvents({
  events,
  expectedCount,
  loading,
  error,
  onClose,
  onRetry,
}: {
  events: MapOccurrencePreview[];
  expectedCount: number;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const { t, tr, localeTag } = useTranslation();
  return (
    <aside className="relative max-h-80 overflow-y-auto p-3 pr-14" aria-live="polite">
      <button
        type="button"
        aria-label={tr("Fermer la fiche")}
        onClick={onClose}
        className="absolute right-3 top-3 grid h-11 w-11 place-items-center rounded-full border bg-surface text-lg"
      >
        ×
      </button>
      <Badge className="mb-2 border-transparent bg-primary/15 text-primary">
        {tr("Résultats")}
      </Badge>
      <h2 className="text-base font-black">
        {tr("{count} sorties", { count: expectedCount || events.length })}
      </h2>
      {loading && (
        <div className="mt-3 flex min-h-20 items-center justify-center gap-2 rounded-xl border bg-surface px-3 text-xs font-bold">
          <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
          {t("common.loading")}
        </div>
      )}
      {error && !loading && (
        <div className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <p>{error}</p>
          <button type="button" className="mt-2 min-h-11 font-black underline" onClick={onRetry}>
            {t("common.retry")}
          </button>
        </div>
      )}
      <div className="mt-2 grid gap-2">
        {events.map((event) => (
          <Link
            key={event.occurrence_id}
            to="/event/$slug"
            params={{ slug: event.slug }}
            className="rounded-xl border bg-background px-3 py-2 text-left hover:border-primary"
            style={{ contentVisibility: "auto", containIntrinsicSize: "0 52px" }}
          >
            <span className="block truncate text-xs font-black">{event.title}</span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {formatMobileEventDate(event, localeTag)} ·{" "}
              {event.venue_name ?? event.city_name ?? tr("Lieu à confirmer")}
            </span>
          </Link>
        ))}
      </div>
    </aside>
  );
}

function mapPreviewFromDiscoveredEvent(event: DiscoveredEvent): MapOccurrencePreview {
  return {
    occurrence_id: event.occurrence_id,
    slug: event.slug,
    title: event.title,
    short_description: event.short_description,
    description: null,
    cover_image_url: event.cover_image_url,
    starts_at: event.starts_at,
    timezone: event.timezone,
    venue_name: event.venue_name,
    city_name: event.city_name,
  };
}

function safeMapPreviewImageUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function createMapHoverFallback(): HTMLDivElement {
  const fallback = document.createElement("div");
  fallback.className = "map-event-hover-fallback";
  fallback.textContent = "✦";
  return fallback;
}

function mapClusterPointCount(value: unknown): number {
  const pointCount = Number(value);
  return Number.isFinite(pointCount) ? Math.max(2, Math.floor(pointCount)) : 2;
}

function createLoadingHoverContent(label: string): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "map-hover-loading";
  container.textContent = label;
  return container;
}

function createEventHoverContent(
  preview: MapOccurrencePreview,
  descriptionFallback: string,
): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "map-event-hover-card";

  const imageUrl = safeMapPreviewImageUrl(preview.cover_image_url);
  if (imageUrl) {
    const image = document.createElement("img");
    image.src = imageUrl;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.replaceWith(createMapHoverFallback()), {
      once: true,
    });
    container.append(image);
  } else {
    container.append(createMapHoverFallback());
  }

  const copy = document.createElement("div");
  copy.className = "map-event-hover-copy";
  const title = document.createElement("strong");
  title.textContent = preview.title;
  copy.append(title);

  const venue = preview.venue_name ?? preview.city_name;
  if (venue) {
    const venueLine = document.createElement("span");
    venueLine.textContent = venue;
    copy.append(venueLine);
  }

  const description = document.createElement("p");
  description.textContent =
    mapPreviewExcerpt(preview.short_description ?? preview.description, 150) || descriptionFallback;
  copy.append(description);
  container.append(copy);
  return container;
}

function createClusterHoverContent(
  previews: MapOccurrencePreview[],
  completeVenueCoverage: boolean,
  labels: { multipleVenues: string; groupedEvents: string; eventCount: string },
): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "map-cluster-hover-card";
  const venueNames = mapPreviewVenueNames(previews);

  const title = document.createElement("strong");
  title.textContent =
    completeVenueCoverage && venueNames.length === 1
      ? venueNames[0]
      : completeVenueCoverage && venueNames.length > 1
        ? labels.multipleVenues
        : labels.groupedEvents;
  container.append(title);

  if (venueNames.length > 1) {
    const venues = document.createElement("span");
    const visibleNames = venueNames.slice(0, 3);
    const remaining = Math.max(0, venueNames.length - visibleNames.length);
    venues.textContent = `${visibleNames.join(" · ")}${remaining ? ` · +${remaining}` : ""}`;
    container.append(venues);
  }

  const count = document.createElement("small");
  count.textContent = labels.eventCount;
  container.append(count);
  return container;
}

function MapPage() {
  const { t, tr, categoryLabel, formatNumber } = useTranslation();
  const navigate = useNavigate();
  const [mapContainer, setMapContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setMapContainer(node);
  }, []);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const lastFittedScopeRef = useRef<string | null>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const isMobileRef = useRef(isMobile);
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [cities, setCities] = useState<CityOption[]>([]);
  const [cityLoading, setCityLoading] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [geographyReady, setGeographyReady] = useState(false);
  const [geography, setGeography] = useState<GeographySelection>({
    countryId: null,
    regionId: null,
    cityId: null,
  });
  const { countryId, regionId, cityId } = geography;
  const [range, setRange] = useState<QuickRange>("year");
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [advancedFilters, setAdvancedFilters] = useState({ ...DEFAULT_ADVANCED_FILTERS });
  const [events, setEvents] = useState<DiscoveredEvent[]>([]);
  const [compactPins, setCompactPins] = useState<CompactMapPin[] | null>(null);
  const [discoveryStats, setDiscoveryStats] = useState<DiscoveryStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [showEvents, setShowEvents] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<DiscoveredEvent | null>(null);
  const [selectedClusterEvents, setSelectedClusterEvents] = useState<MapOccurrencePreview[]>([]);
  const [clusterSelectionOpen, setClusterSelectionOpen] = useState(false);
  const [clusterSelectionLoading, setClusterSelectionLoading] = useState(false);
  const [clusterSelectionError, setClusterSelectionError] = useState<string | null>(null);
  const [clusterSelectionExpectedCount, setClusterSelectionExpectedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [visibleMobileEventCount, setVisibleMobileEventCount] = useState(MOBILE_LIST_BATCH_SIZE);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null);
  const [readyMap, setReadyMap] = useState<maplibregl.Map | null>(null);
  const [readyStyle, setReadyStyle] = useState<{
    map: maplibregl.Map;
    revision: number;
  } | null>(null);
  const [mapUnavailable, setMapUnavailable] = useState<string | null>(null);
  const requestVersionRef = useRef(0);
  const cityRequestVersionRef = useRef(0);
  const clusterSelectionRequestRef = useRef(0);
  const clusterSelectionRetryRef = useRef<(() => void) | null>(null);
  const previewCacheRef = useRef(new Map<string, MapOccurrencePreview | null>());
  const previewInFlightRef = useRef(new Map<string, Promise<MapOccurrencePreview | null>>());
  const fullPreviewIdsRef = useRef(new Set<string>());
  const fullPreviewInFlightRef = useRef(new Map<string, Promise<MapOccurrencePreview | null>>());
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverRequestRef = useRef(0);
  const mapReady = mapInstance !== null && readyMap === mapInstance;

  const searchCities = useCallback(
    async (cityQuery: string) => {
      if (!countryId) return;
      const requestVersion = ++cityRequestVersionRef.current;
      setCityLoading(true);
      try {
        const rows = await searchGeographyCities({
          countryId,
          regionId,
          query: cityQuery,
          limit: 100,
        });
        if (requestVersion !== cityRequestVersionRef.current) return;
        setCities((current) => {
          const merged = new Map(current.map((city) => [city.id, city]));
          rows.forEach((city) => merged.set(city.id, city));
          return [...merged.values()];
        });
      } catch {
        // Keep country/region discovery available even when suggestions fail.
      } finally {
        if (requestVersion === cityRequestVersionRef.current) setCityLoading(false);
      }
    },
    [countryId, regionId],
  );

  const selectedCity = useMemo(
    () => cities.find((city) => city.id === cityId) ?? null,
    [cities, cityId],
  );
  const selectedRegion = useMemo(
    () => regions.find((region) => region.id === regionId) ?? null,
    [regions, regionId],
  );
  const selectedCountry = useMemo(
    () => countries.find((country) => country.id === countryId) ?? null,
    [countries, countryId],
  );
  const selectedCountryCode = selectedCountry?.code ?? null;
  const { from, to } = useMemo(() => computeRange(range), [range]);
  const advancedCount = countAdvancedFilters(advancedFilters);
  const unfilteredWorld =
    !countryId &&
    !regionId &&
    !cityId &&
    cats.size === 0 &&
    deferredQuery.length === 0 &&
    advancedCount === 0 &&
    range === "year";
  const eventMapPoints = useMemo(
    () =>
      unfilteredWorld && compactPins
        ? buildCompactMapPointCollection({ pins: compactPins, showEvents })
        : buildMapPointCollection({
            events,
            showEvents,
            countryCode: selectedCountryCode,
          }),
    [compactPins, events, selectedCountryCode, showEvents, unfilteredWorld],
  );
  const eventsByOccurrenceId = useMemo(
    () => new Map(events.map((event) => [event.occurrence_id, event])),
    [events],
  );
  const resolvePreviewBatch = useCallback(async (occurrenceIds: string[]) => {
    const pending: Array<Promise<MapOccurrencePreview | null>> = [];
    const missingIds = occurrenceIds.filter(
      (occurrenceId) =>
        !previewCacheRef.current.has(occurrenceId) && !previewInFlightRef.current.has(occurrenceId),
    );

    if (missingIds.length) {
      const batchPromise = fetchMapOccurrencePreviews(missingIds).then(
        (previews) => new Map(previews.map((preview) => [preview.occurrence_id, preview])),
      );
      for (const occurrenceId of missingIds) {
        const itemPromise = batchPromise.then((previews) => previews.get(occurrenceId) ?? null);
        previewInFlightRef.current.set(occurrenceId, itemPromise);
        void itemPromise.then(
          (preview) => {
            if (!fullPreviewIdsRef.current.has(occurrenceId)) {
              previewCacheRef.current.set(occurrenceId, preview);
            }
            if (previewInFlightRef.current.get(occurrenceId) === itemPromise) {
              previewInFlightRef.current.delete(occurrenceId);
            }
          },
          () => {
            if (previewInFlightRef.current.get(occurrenceId) === itemPromise) {
              previewInFlightRef.current.delete(occurrenceId);
            }
          },
        );
      }
    }

    for (const occurrenceId of occurrenceIds) {
      if (previewCacheRef.current.has(occurrenceId)) {
        pending.push(Promise.resolve(previewCacheRef.current.get(occurrenceId) ?? null));
      } else {
        const request = previewInFlightRef.current.get(occurrenceId);
        if (request) pending.push(request);
      }
    }
    return Promise.all(pending);
  }, []);
  const resolveOccurrencePreviews = useCallback(
    async (occurrenceIds: string[]) => {
      const batches = chunkOccurrenceIds(occurrenceIds);
      const uniqueIds = batches.flat();
      for (const occurrenceId of uniqueIds) {
        const localEvent = eventsByOccurrenceId.get(occurrenceId);
        if (localEvent && !previewCacheRef.current.has(occurrenceId)) {
          previewCacheRef.current.set(occurrenceId, mapPreviewFromDiscoveredEvent(localEvent));
        }
      }

      for (let offset = 0; offset < batches.length; offset += CLUSTER_PREVIEW_CONCURRENCY) {
        await Promise.all(
          batches
            .slice(offset, offset + CLUSTER_PREVIEW_CONCURRENCY)
            .map((batch) => resolvePreviewBatch(batch)),
        );
      }

      return uniqueIds.flatMap((occurrenceId) => {
        const preview = previewCacheRef.current.get(occurrenceId);
        return preview ? [preview] : [];
      });
    },
    [eventsByOccurrenceId, resolvePreviewBatch],
  );
  const resolveEventHoverPreview = useCallback(
    async (occurrenceId: string): Promise<MapOccurrencePreview | null> => {
      const localEvent = eventsByOccurrenceId.get(occurrenceId);
      if (localEvent && mapPreviewExcerpt(localEvent.short_description, 150)) {
        return mapPreviewFromDiscoveredEvent(localEvent);
      }

      const cached = previewCacheRef.current.get(occurrenceId);
      if (cached && mapPreviewExcerpt(cached.short_description ?? cached.description, 150)) {
        return cached;
      }
      if (fullPreviewIdsRef.current.has(occurrenceId)) return cached ?? null;

      const activeRequest = fullPreviewInFlightRef.current.get(occurrenceId);
      if (activeRequest) return activeRequest;

      const request = fetchMapOccurrencePreviews([occurrenceId], {
        includeDescription: true,
      }).then((previews) => previews[0] ?? null);
      fullPreviewInFlightRef.current.set(occurrenceId, request);
      void request.then(
        (preview) => {
          previewCacheRef.current.set(occurrenceId, preview);
          fullPreviewIdsRef.current.add(occurrenceId);
          if (fullPreviewInFlightRef.current.get(occurrenceId) === request) {
            fullPreviewInFlightRef.current.delete(occurrenceId);
          }
        },
        () => {
          if (fullPreviewInFlightRef.current.get(occurrenceId) === request) {
            fullPreviewInFlightRef.current.delete(occurrenceId);
          }
        },
      );
      return request;
    },
    [eventsByOccurrenceId],
  );
  const mobileListEvents = useMemo(
    () => events.slice(0, visibleMobileEventCount),
    [events, visibleMobileEventCount],
  );
  const requestMapResize = useCallback(() => mapRef.current?.resize(), []);
  const closeClusterSelection = useCallback(() => {
    clusterSelectionRequestRef.current += 1;
    clusterSelectionRetryRef.current = null;
    setClusterSelectionOpen(false);
    setClusterSelectionLoading(false);
    setClusterSelectionError(null);
    setClusterSelectionExpectedCount(0);
    setSelectedClusterEvents([]);
  }, []);

  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  useEffect(() => {
    let current = true;
    Promise.all([fetchGeographies(), fetchCategories()])
      .then(([geo, categoryRows]) => {
        if (!current) return;
        setCountries(geo.countries);
        setRegions(geo.regions);
        setCities(geo.cities);
        setCategories(categoryRows as Category[]);
        setGeographyReady(true);
      })
      .catch(() => {
        if (current) {
          setError("Les filtres géographiques n'ont pas pu être chargés.");
          // Preserve worldwide discovery if the geography catalogue is down.
          setGeographyReady(true);
        }
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    const activeMapContainer = mapContainer;
    if (!activeMapContainer || mapRef.current) return;

    // MapLibre must follow the exact DOM node reported by the callback ref.
    // Hydration and responsive layout changes replace that node entirely.
    activeMapContainer.dataset.mapLayout = activeMapContainer.closest(".mobile-discovery-shell")
      ? "mobile"
      : "desktop";
    lastFittedScopeRef.current = null;
    setReadyMap(null);
    setReadyStyle(null);
    setMapUnavailable(null);
    try {
      const canvas = document.createElement("canvas");
      const webgl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!webgl) {
        setMapUnavailable("La carte interactive nécessite WebGL, indisponible dans ce navigateur.");
        return;
      }
    } catch {
      setMapUnavailable("La carte interactive ne peut pas démarrer dans ce navigateur.");
      return;
    }
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: activeMapContainer,
        style: PRIMARY_MAP_STYLE,
        center: GENEVA_CENTER,
        zoom: 12,
        clickTolerance: 8,
        fadeDuration: 0,
      });
    } catch {
      setMapUnavailable("La carte interactive ne peut pas démarrer dans ce navigateur.");
      return;
    }
    let primaryStyleLoaded = false;
    const markMapReady = () => {
      setReadyMap(map);
    };
    const fallbackTimer = window.setTimeout(() => {
      if (primaryStyleLoaded) return;
      map.setStyle(RASTER_FALLBACK_STYLE);
    }, 8_000);
    // A raster provider can be slow or blocked while the WebGL canvas is
    // already usable. Do not let the loading veil hide the map indefinitely.
    const revealTimer = window.setTimeout(() => {
      map.resize();
      setReadyMap(map);
    }, 2_500);
    map.once("render", markMapReady);
    map.on("load", markMapReady);
    map.on("style.load", () => {
      primaryStyleLoaded = true;
      setReadyStyle((current) => ({
        map,
        revision: current?.map === map ? current.revision + 1 : 1,
      }));
      markMapReady();
    });
    map.on("styledata", () => {
      if (map.isStyleLoaded()) setReadyMap(map);
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;
    setMapInstance(map);
    let firstResizeFrame = 0;
    let secondResizeFrame = 0;
    const resizeMap = () => {
      window.cancelAnimationFrame(firstResizeFrame);
      window.cancelAnimationFrame(secondResizeFrame);
      firstResizeFrame = window.requestAnimationFrame(() => {
        secondResizeFrame = window.requestAnimationFrame(() => map.resize());
      });
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeMap);
    resizeObserver?.observe(activeMapContainer);
    window.visualViewport?.addEventListener("resize", resizeMap);
    window.addEventListener("orientationchange", resizeMap);
    resizeMap();

    return () => {
      window.clearTimeout(fallbackTimer);
      window.clearTimeout(revealTimer);
      window.cancelAnimationFrame(firstResizeFrame);
      window.cancelAnimationFrame(secondResizeFrame);
      resizeObserver?.disconnect();
      window.visualViewport?.removeEventListener("resize", resizeMap);
      window.removeEventListener("orientationchange", resizeMap);
      map.remove();
      if (mapRef.current === map) {
        mapRef.current = null;
        setMapInstance((current) => (current === map ? null : current));
        setReadyMap((current) => (current === map ? null : current));
        setReadyStyle((current) => (current?.map === map ? null : current));
      }
    };
  }, [mapContainer]);

  useEffect(() => {
    const map = mapInstance;
    if (!map || !mapReady) return;
    const scopeKey = `${countryId ?? "world"}:${regionId ?? "all"}:${cityId ?? "all"}`;
    if (lastFittedScopeRef.current === scopeKey) return;
    if (!countryId && !regionId && !cityId) {
      lastFittedScopeRef.current = scopeKey;
      map.fitBounds(
        [
          [-170, -55],
          [170, 75],
        ],
        { padding: 40, duration: 700 },
      );
      return;
    }
    if (
      selectedCity?.latitude != null &&
      selectedCity.longitude != null &&
      isMapCoordinatePlausibleForCountry(
        selectedCountryCode,
        selectedCity.latitude,
        selectedCity.longitude,
      )
    ) {
      lastFittedScopeRef.current = scopeKey;
      map.flyTo({
        center: [selectedCity.longitude, selectedCity.latitude],
        zoom: selectedCity.slug === "geneve" ? 12 : 11,
      });
      return;
    }
    const locatedEvents = events.filter((event) =>
      isMapCoordinatePlausibleForCountry(selectedCountryCode, event.latitude, event.longitude),
    );
    if ((countryId || regionId) && !locatedEvents.length) return;
    lastFittedScopeRef.current = scopeKey;
    if (!locatedEvents.length) {
      map.fitBounds(
        [
          [-170, -55],
          [170, 75],
        ],
        { padding: 40, duration: 700 },
      );
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    locatedEvents.forEach((event) => bounds.extend([event.longitude!, event.latitude!]));
    map.fitBounds(bounds, { padding: 60, maxZoom: regionId ? 9 : 6, duration: 700 });
  }, [
    cityId,
    countryId,
    events,
    mapInstance,
    mapReady,
    regionId,
    selectedCity,
    selectedCountryCode,
  ]);

  const mapDiscoveryParams = useMemo(
    () => ({
      countryId,
      regionId,
      cityId,
      categorySlugs: cats.size ? [...cats] : null,
      query: deferredQuery,
      from,
      to,
      ...toDiscoveryFilters(advancedFilters),
    }),
    [advancedFilters, cats, cityId, countryId, deferredQuery, from, regionId, to],
  );

  const localDiscoveryStats = useMemo<DiscoveryStats>(
    () => ({
      total_count: unfilteredWorld && compactPins ? compactPins.length : events.length,
      free_count:
        unfilteredWorld && compactPins
          ? compactPins.reduce((count, pin) => count + pin[4], 0)
          : events.filter((event) => event.is_free).length,
      verified_count: events.filter((event) => event.is_verified).length,
    }),
    [compactPins, events, unfilteredWorld],
  );
  const mapStats = discoveryStats ?? localDiscoveryStats;
  const totalEventCount = mapStats.total_count;
  const loadedPointCount = unfilteredWorld && compactPins ? compactPins.length : events.length;

  useEffect(() => {
    if (!geographyReady) return;
    let current = true;
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setStatsLoading(true);
    setDiscoveryStats(null);
    setCompactPins(null);
    setVisibleMobileEventCount(MOBILE_LIST_BATCH_SIZE);
    setError(null);
    const loadDetailedPages = () =>
      loadAllPages<DiscoveredEvent>({
        pageSize: MAP_EVENT_PAGE_SIZE,
        getKey: (event) => event.occurrence_id,
        shouldContinue: () => current && requestVersion === requestVersionRef.current,
        fetchPage: ({ limit, offset }) =>
          discoverMapEvents({
            ...mapDiscoveryParams,
            limit,
            offset,
          }),
        onFirstPage: (nextEvents) => {
          if (!current || requestVersion !== requestVersionRef.current) return;
          setEvents(nextEvents);
        },
      });

    const loadPoints = async () => {
      if (!unfilteredWorld) {
        const nextEvents = await loadDetailedPages();
        return { nextEvents, nextPins: null };
      }

      const firstPagePromise = discoverMapEvents({
        ...mapDiscoveryParams,
        limit: MAP_EVENT_PAGE_SIZE,
        offset: 0,
      }).then((nextEvents) => {
        if (!current || requestVersion !== requestVersionRef.current) return;
        setEvents(nextEvents);
        return nextEvents;
      });

      try {
        const [nextPins, nextEvents] = await Promise.all([
          discoverAllMapPins({ from, to }),
          firstPagePromise,
        ]);
        return { nextEvents: nextEvents ?? [], nextPins };
      } catch {
        // The detailed endpoint remains an uncapped fallback if the compact
        // worldwide endpoint is temporarily unavailable.
        const nextEvents = await loadDetailedPages();
        return { nextEvents, nextPins: null };
      }
    };

    void loadPoints()
      .then(({ nextEvents, nextPins }) => {
        if (!current || requestVersion !== requestVersionRef.current) return;
        setEvents(nextEvents);
        setCompactPins(nextPins);
        setSelectedEvent(null);
        closeClusterSelection();
      })
      .catch(() => {
        if (!current) return;
        setEvents([]);
        setError("Impossible de charger les points de la carte. Réessaie dans un instant.");
      })
      .finally(() => {
        if (current && requestVersion === requestVersionRef.current) setLoading(false);
      });

    // Keep aggregates independent from point loading so an unavailable count
    // endpoint never prevents the map itself from rendering.
    void discoverEventStats(mapDiscoveryParams, { requireCoordinates: true })
      .then((nextStats) => {
        if (!current || requestVersion !== requestVersionRef.current) return;
        setDiscoveryStats(nextStats);
      })
      .catch(() => {
        if (!current || requestVersion !== requestVersionRef.current) return;
        setDiscoveryStats(null);
      })
      .finally(() => {
        if (current && requestVersion === requestVersionRef.current) setStatsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [
    closeClusterSelection,
    from,
    geography,
    geographyReady,
    mapDiscoveryParams,
    reloadKey,
    to,
    unfilteredWorld,
  ]);

  const loadMoreMobileList = () => {
    setVisibleMobileEventCount((count) => count + MOBILE_LIST_BATCH_SIZE);
  };

  useEffect(() => {
    const map = mapInstance;
    if (!map || !mapReady || readyStyle?.map !== map) return;

    const syncLayers = () => {
      syncClusterLayers(map, eventMapPoints);
    };
    const removeHoverPopup = () => {
      hoverRequestRef.current += 1;
      if (hoverTimerRef.current != null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      hoverPopupRef.current?.remove();
      hoverPopupRef.current = null;
    };
    const showHoverPopup = (coordinates: [number, number], content: HTMLElement) => {
      hoverPopupRef.current?.remove();
      hoverPopupRef.current = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: "eventa-map-popup",
        maxWidth: "340px",
        offset: 22,
      })
        .setLngLat(coordinates)
        .setDOMContent(content)
        .addTo(map);
    };
    const scheduleHoverPreview = (
      coordinates: [number, number],
      loadContent: () => Promise<HTMLElement>,
    ) => {
      const requestVersion = ++hoverRequestRef.current;
      if (hoverTimerRef.current != null) window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        if (requestVersion !== hoverRequestRef.current) return;
        showHoverPopup(coordinates, createLoadingHoverContent(t("common.loading")));
        void loadContent()
          .then((content) => {
            if (requestVersion !== hoverRequestRef.current) return;
            showHoverPopup(coordinates, content);
          })
          .catch(() => {
            if (requestVersion !== hoverRequestRef.current) return;
            showHoverPopup(
              coordinates,
              createLoadingHoverContent(tr("Aperçu momentanément indisponible")),
            );
          });
      }, MAP_HOVER_DELAY_MS);
    };
    const loadClusterSelection = async (
      source: GeoJSONSource,
      clusterId: number,
      pointCount: number,
    ) => {
      const requestVersion = ++clusterSelectionRequestRef.current;
      clusterSelectionRetryRef.current = () => {
        void loadClusterSelection(source, clusterId, pointCount);
      };
      setSelectedEvent(null);
      setClusterSelectionOpen(true);
      setClusterSelectionLoading(true);
      setClusterSelectionError(null);
      setClusterSelectionExpectedCount(pointCount);
      setSelectedClusterEvents([]);

      try {
        const leaves = await loadAllClusterLeaves(pointCount, (limit, offset) =>
          source.getClusterLeaves(clusterId, limit, offset),
        );
        const occurrenceIds = leaves.flatMap((leaf) => {
          const occurrenceId = leaf.properties?.entity_id;
          return typeof occurrenceId === "string" ? [occurrenceId] : [];
        });
        const previews = await resolveOccurrencePreviews(occurrenceIds);
        if (requestVersion !== clusterSelectionRequestRef.current) return;
        setSelectedClusterEvents(previews);
        setClusterSelectionLoading(false);
        if (!previews.length) {
          setClusterSelectionError(
            "Les événements de ce lieu n’ont pas pu être chargés. Réessaie dans un instant.",
          );
        }
      } catch {
        if (requestVersion !== clusterSelectionRequestRef.current) return;
        setClusterSelectionLoading(false);
        setClusterSelectionError(
          "Impossible de charger les événements regroupés. Vérifie ta connexion puis réessaie.",
        );
      }
    };
    const expandCluster = async (feature: MapGeoJSONFeature) => {
      if (!feature || feature.geometry.type !== "Point") return;
      const clusterId = Number(feature.properties?.cluster_id);
      if (!Number.isFinite(clusterId)) return;
      const source = map.getSource(MAP_EVENT_SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;
      const [longitude, latitude] = feature.geometry.coordinates;
      const pointCount = mapClusterPointCount(feature.properties?.point_count);

      setSelectedEvent(null);
      if (map.getZoom() >= EVENT_CLUSTER_MAX_ZOOM) {
        void loadClusterSelection(source, clusterId, pointCount);
        return;
      }

      try {
        const expansionZoom = await source.getClusterExpansionZoom(clusterId);
        if (shouldOpenClusterSelection(map.getZoom(), expansionZoom)) {
          void loadClusterSelection(source, clusterId, pointCount);
          return;
        }
        closeClusterSelection();
        map.easeTo({
          center: [Number(longitude), Number(latitude)],
          zoom: clusterExpansionTargetZoom(map.getZoom(), expansionZoom),
          duration: 450,
        });
      } catch {
        setError("Impossible d’ouvrir ce groupe de points. Réessaie dans un instant.");
      }
    };
    const openPoint = (feature: MapGeoJSONFeature) => {
      const properties = feature.properties as Partial<MapPointProperties> | undefined;
      const entityId = typeof properties?.entity_id === "string" ? properties.entity_id : "";

      if (properties?.kind === "event") {
        const selected = eventsByOccurrenceId.get(entityId);
        const slug = typeof properties.slug === "string" ? properties.slug : "";
        if (selected) {
          closeClusterSelection();
          setSelectedEvent(selected);
        } else if (slug) {
          closeClusterSelection();
          void navigate({ to: "/event/$slug", params: { slug } });
        } else {
          return;
        }
        void trackClientEvent("map_pin_click", {
          entityType: "event_occurrence",
          entityId,
          cityId,
          metadata: {
            precision: selected?.location_precision ?? (properties.approximate ? "city" : "exact"),
          },
        });
      }
    };
    const handlePointMouseEnter = (event: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      if (isMobileRef.current) return;
      const feature = event.features?.[0];
      if (!feature || feature.geometry.type !== "Point") return;
      const properties = feature.properties as Partial<MapPointProperties> | undefined;
      const occurrenceId = typeof properties?.entity_id === "string" ? properties.entity_id : "";
      const [longitude, latitude] = feature.geometry.coordinates;
      if (!occurrenceId || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return;

      scheduleHoverPreview([Number(longitude), Number(latitude)], async () => {
        const preview = await resolveEventHoverPreview(occurrenceId);
        if (!preview) throw new Error("Missing event preview");
        return createEventHoverContent(preview, tr("Description à venir."));
      });
    };
    const handleClusterMouseEnter = (event: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      if (isMobileRef.current) return;
      const feature = event.features?.find((candidate) => candidate.properties?.cluster_id != null);
      if (!feature || feature.geometry.type !== "Point") return;
      const source = map.getSource(MAP_EVENT_SOURCE_ID) as GeoJSONSource | undefined;
      const clusterId = Number(feature.properties?.cluster_id);
      const pointCount = mapClusterPointCount(feature.properties?.point_count);
      const [longitude, latitude] = feature.geometry.coordinates;
      if (
        !source ||
        !Number.isFinite(clusterId) ||
        !Number.isFinite(longitude) ||
        !Number.isFinite(latitude)
      ) {
        return;
      }

      scheduleHoverPreview([Number(longitude), Number(latitude)], async () => {
        const terminalCluster = map.getZoom() >= EVENT_CLUSTER_MAX_ZOOM;
        const sampleSize = Math.min(pointCount, CLUSTER_HOVER_SAMPLE_SIZE);
        const leaves = terminalCluster
          ? await loadAllClusterLeaves(pointCount, (limit, offset) =>
              source.getClusterLeaves(clusterId, limit, offset),
            )
          : await source.getClusterLeaves(clusterId, sampleSize, 0);
        const occurrenceIds = leaves.flatMap((leaf) => {
          const occurrenceId = leaf.properties?.entity_id;
          return typeof occurrenceId === "string" ? [occurrenceId] : [];
        });
        const previews = await resolveOccurrencePreviews(occurrenceIds);
        const uniqueOccurrenceCount = new Set(occurrenceIds).size;
        const completeVenueCoverage =
          leaves.length >= pointCount &&
          previews.length === uniqueOccurrenceCount &&
          previews.every((preview) => Boolean(preview.venue_name ?? preview.city_name));
        return createClusterHoverContent(previews, completeVenueCoverage, {
          multipleVenues: tr("Plusieurs lieux"),
          groupedEvents: tr("Événements regroupés"),
          eventCount: tr("{count} sorties", { count: formatNumber(pointCount) }),
        });
      });
    };
    const interactiveLayers = [
      MAP_CLUSTER_HALO_LAYER_ID,
      MAP_CLUSTER_LAYER_ID,
      MAP_EVENT_POINT_LAYER_ID,
    ] as const;
    const handleMapClick = (event: MapMouseEvent) => {
      removeHoverPopup();
      const renderedLayers = interactiveLayers.filter((layerId) => map.getLayer(layerId));
      if (!renderedLayers.length) return;

      const directCandidates = map
        .queryRenderedFeatures(event.point, { layers: [...renderedLayers] })
        .flatMap<MapHitCandidate<MapGeoJSONFeature>>((feature) => {
          const kind = mapFeatureHitKind(feature);
          return kind ? [{ kind, x: event.point.x, y: event.point.y, value: feature }] : [];
        });
      const directHit = selectHighestPriorityMapHit(directCandidates);
      if (directHit) {
        if (directHit.kind === "cluster") void expandCluster(directHit.value);
        else openPoint(directHit.value);
        return;
      }

      const hitRadius = isMobileRef.current ? MOBILE_MAP_HIT_RADIUS : DESKTOP_MAP_HIT_RADIUS;
      const tolerantLayers = [MAP_EVENT_POINT_LAYER_ID].filter((layerId) => map.getLayer(layerId));
      const nearbyFeatures = map.queryRenderedFeatures(
        [
          [event.point.x - hitRadius, event.point.y - hitRadius],
          [event.point.x + hitRadius, event.point.y + hitRadius],
        ],
        { layers: tolerantLayers },
      );
      const candidates: MapHitCandidate<MapGeoJSONFeature>[] = [];

      for (const feature of nearbyFeatures) {
        const kind = mapFeatureHitKind(feature);
        if (!kind || feature.geometry.type !== "Point") continue;
        const [longitude, latitude] = feature.geometry.coordinates;
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
        const screenPoint = map.project([Number(longitude), Number(latitude)]);
        candidates.push({ kind, x: screenPoint.x, y: screenPoint.y, value: feature });
      }

      const selected = selectNearestMapHit(candidates, event.point, hitRadius);
      if (!selected) return;
      if (selected.kind === "cluster") {
        void expandCluster(selected.value);
      } else {
        openPoint(selected.value);
      }
    };
    const resetCursor = () => {
      map.getCanvas().style.cursor = "";
      removeHoverPopup();
    };
    const clusterHoverLayers = [MAP_CLUSTER_HALO_LAYER_ID] as const;
    syncLayers();
    map.on("click", handleMapClick);
    clusterHoverLayers.forEach((layerId) => map.on("mouseenter", layerId, handleClusterMouseEnter));
    clusterHoverLayers.forEach((layerId) => map.on("mouseleave", layerId, resetCursor));
    map.on("mouseenter", MAP_EVENT_POINT_LAYER_ID, handlePointMouseEnter);
    map.on("mouseleave", MAP_EVENT_POINT_LAYER_ID, resetCursor);

    return () => {
      map.off("click", handleMapClick);
      clusterHoverLayers.forEach((layerId) =>
        map.off("mouseenter", layerId, handleClusterMouseEnter),
      );
      clusterHoverLayers.forEach((layerId) => map.off("mouseleave", layerId, resetCursor));
      map.off("mouseenter", MAP_EVENT_POINT_LAYER_ID, handlePointMouseEnter);
      map.off("mouseleave", MAP_EVENT_POINT_LAYER_ID, resetCursor);
      closeClusterSelection();
      resetCursor();
    };
  }, [
    cityId,
    closeClusterSelection,
    eventMapPoints,
    eventsByOccurrenceId,
    formatNumber,
    mapInstance,
    mapReady,
    navigate,
    readyStyle,
    resolveEventHoverPreview,
    resolveOccurrencePreviews,
    t,
    tr,
  ]);

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
    setGeography({ countryId: null, regionId: null, cityId: null });
    setShowEvents(true);
  };

  const approximateCount =
    unfilteredWorld && compactPins
      ? compactPins.reduce((count, pin) => count + pin[5], 0)
      : events.filter((event) => event.location_precision === "city").length;
  const mobileActiveFilterCount =
    advancedCount + cats.size + Number(range !== "year") + Number(!showEvents);

  if (isMobile) {
    const hasMoreMobileEvents = visibleMobileEventCount < events.length;
    const mobileSelection = selectedEvent ? (
      <MobileSelectedEvent event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    ) : clusterSelectionOpen ? (
      <SelectedClusterEvents
        events={selectedClusterEvents}
        expectedCount={clusterSelectionExpectedCount}
        loading={clusterSelectionLoading}
        error={clusterSelectionError}
        onClose={closeClusterSelection}
        onRetry={() => clusterSelectionRetryRef.current?.()}
      />
    ) : null;

    return (
      <MobileDiscoveryLayout
        resultCount={totalEventCount}
        activeFilterCount={mobileActiveFilterCount}
        hasSelection={Boolean(mobileSelection)}
        onMapResizeNeeded={requestMapResize}
        search={
          <div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("home.searchPlaceholder")}
                aria-label={t("home.searchAria")}
                className="h-11 rounded-2xl bg-surface pl-9 text-sm"
              />
            </div>
            <p className="mt-1 truncate px-1 text-[10px] text-muted-foreground">
              {loading
                ? "Chargement des événements…"
                : statsLoading
                  ? `${COUNT_FORMATTER.format(loadedPointCount)} points chargés · calcul du total…`
                  : `${formatNumber(totalEventCount)} événements · ${formatNumber(loadedPointCount)} points chargés · ${selectedCity?.name ?? selectedRegion?.name ?? selectedCountry?.name ?? t("home.world")}`}
            </p>
            {error && (
              <div className="mt-1 flex items-center justify-between gap-2 rounded-xl bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
                <span className="truncate">{error}</span>
                <button
                  type="button"
                  className="min-h-11 shrink-0 font-bold underline"
                  onClick={() => setReloadKey((key) => key + 1)}
                >
                  {t("common.retry")}
                </button>
              </div>
            )}
          </div>
        }
        map={
          <MapSurface
            containerRef={containerRef}
            mapReady={mapReady}
            mapUnavailable={mapUnavailable}
          />
        }
        selection={mobileSelection}
        list={
          <div className="p-3 pb-5">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary">
                  {tr("Résultats")}
                </p>
                <h1 className="text-xl font-black">
                  {tr("{count} sorties", {
                    count: statsLoading ? "…" : formatNumber(totalEventCount),
                  })}
                </h1>
              </div>
              <span className="text-[10px] text-muted-foreground">
                {tr("{shown} affichées · {loaded} points chargés", {
                  shown: COUNT_FORMATTER.format(mobileListEvents.length),
                  loaded: COUNT_FORMATTER.format(loadedPointCount),
                })}
              </span>
            </div>

            {loading && events.length === 0 ? (
              <div className="grid gap-3">
                {Array.from({ length: 4 }, (_, index) => (
                  <EventCardSkeleton key={index} />
                ))}
              </div>
            ) : mobileListEvents.length > 0 ? (
              <div className="grid gap-3">
                {mobileListEvents.map((event) => (
                  <div
                    key={event.occurrence_id}
                    style={{ contentVisibility: "auto", containIntrinsicSize: "0 360px" }}
                  >
                    <EventCard ev={event} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border p-6 text-center">
                <MapPin className="mx-auto mb-3 h-7 w-7 text-primary" />
                <p className="font-bold">{tr("Aucun événement trouvé")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {tr("Essaie une autre date, ville ou catégorie.")}
                </p>
              </div>
            )}

            {hasMoreMobileEvents && (
              <button
                type="button"
                onClick={loadMoreMobileList}
                className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 px-4 text-sm font-black text-primary disabled:opacity-60"
              >
                {tr("Afficher plus de sorties")}
              </button>
            )}
          </div>
        }
        filters={
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-sm font-black">{t("home.destination")}</h3>
              <GeographyFilter
                countries={countries}
                regions={regions}
                cities={cities}
                value={geography}
                cityLoading={cityLoading}
                onCityQuery={searchCities}
                onChange={setGeography}
                compact
              />
            </section>

            <section>
              <h3 className="mb-2 text-sm font-black">{t("home.date")}</h3>
              <select
                value={range}
                onChange={(event) => setRange(event.target.value as QuickRange)}
                aria-label={t("home.date")}
                className="h-12 w-full rounded-2xl border bg-surface px-3 text-sm outline-none focus:border-primary"
              >
                {MAP_RANGES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {tr(item.label)}
                  </option>
                ))}
              </select>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-black">{t("home.categories")}</h3>
              <div className="flex flex-wrap gap-2">
                {categories.map((category) => {
                  const visual = eventCategoryVisual(category.slug);
                  const active = cats.has(category.slug);
                  return (
                    <button
                      key={category.slug}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleCategory(category.slug)}
                      className="min-h-11 rounded-full border px-3 text-xs font-semibold transition-colors"
                      style={{
                        borderColor: visual.color,
                        color: active ? eventCategoryTextColor(category.slug) : visual.color,
                        background: active ? visual.color : `${visual.color}18`,
                      }}
                    >
                      {visual.icon} {categoryLabel(category.slug, category.name_fr)}
                    </button>
                  );
                })}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-black">{t("home.advanced")}</h3>
              <div className="rounded-2xl border p-3">
                <EventFilterPanel value={advancedFilters} onChange={setAdvancedFilters} compact />
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-black">{tr("Points sur la carte")}</h3>
              <div className="grid grid-cols-1 gap-2">
                <LayerToggle
                  active={showEvents}
                  icon={CalendarDays}
                  label={`Événements (${statsLoading ? "…" : COUNT_FORMATTER.format(totalEventCount)})`}
                  onClick={() => setShowEvents((value) => !value)}
                />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {tr("{count} positions approximatives sont affichées avec une opacité réduite.", {
                  count: approximateCount,
                })}
              </p>
            </section>

            <div className="grid grid-cols-2 gap-2 border-t pt-4">
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border text-xs font-bold"
              >
                <RotateCcw className="h-4 w-4" /> {t("common.reset")}
              </button>
              <button
                type="button"
                onClick={() => mapRef.current?.flyTo({ center: GENEVA_CENTER, zoom: 12 })}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border text-xs font-bold"
              >
                <Navigation className="h-4 w-4" /> {tr("Recentrer")}
              </button>
            </div>
          </div>
        }
      />
    );
  }

  return (
    <div className="relative h-[calc(100vh-4rem)] w-full">
      <div className="absolute inset-0">
        <MapSurface
          containerRef={containerRef}
          mapReady={mapReady}
          mapUnavailable={mapUnavailable}
        />
      </div>

      <div className="map-overlay-panel absolute left-3 right-3 top-3 z-10 max-h-[calc(100vh-6.5rem)] overflow-y-auto rounded-3xl p-3 md:left-6 md:right-auto md:w-[30rem]">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <Badge className="mb-2 border-transparent bg-primary/15 text-primary">
              <MapPin className="mr-1 h-3.5 w-3.5" /> {tr("Carte clusterisée")}
            </Badge>
            <h1 className="text-xl font-black">
              {tr("Sorties")} ·{" "}
              {selectedCity?.name ??
                selectedRegion?.name ??
                selectedCountry?.name ??
                "monde entier"}
            </h1>
            <p className="text-xs text-muted-foreground">
              {loading
                ? "Chargement de tous les points…"
                : statsLoading
                  ? `${COUNT_FORMATTER.format(loadedPointCount)} points chargés · calcul du total…`
                  : `${COUNT_FORMATTER.format(totalEventCount)} événements au total · ${COUNT_FORMATTER.format(mapStats.free_count)} gratuits`}
            </p>
            {!loading && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {tr("{count} points d’événements chargés sur la carte", {
                  count: COUNT_FORMATTER.format(loadedPointCount),
                })}
              </p>
            )}
            {!loading && mapReady && eventMapPoints.features.length > 0 && (
              <p className="mt-1 text-[11px] font-medium text-primary">
                {tr("Les nombres regroupent les points · clique pour zoomer")}
              </p>
            )}
          </div>
          <Button
            size="icon"
            variant="secondary"
            aria-label={tr("Recentrer sur Genève")}
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
            placeholder={t("home.searchPlaceholder")}
            aria-label={t("home.searchAria")}
            className="h-11 rounded-2xl bg-background pl-9"
          />
        </div>

        <div className="mb-2">
          <GeographyFilter
            countries={countries}
            regions={regions}
            cities={cities}
            value={geography}
            cityLoading={cityLoading}
            onCityQuery={searchCities}
            onChange={setGeography}
            compact
          />
        </div>

        <div className="grid grid-cols-1 gap-2">
          <select
            value={range}
            onChange={(event) => setRange(event.target.value as QuickRange)}
            aria-label={t("home.date")}
            className="h-11 rounded-2xl border bg-background px-3 text-sm outline-none focus:border-primary"
          >
            {MAP_RANGES.map((item) => (
              <option key={item.value} value={item.value}>
                {tr(item.label)}
              </option>
            ))}
          </select>
        </div>

        <div className="no-scrollbar my-3 flex gap-1.5 overflow-x-auto pb-1">
          {categories.map((category) => {
            const visual = eventCategoryVisual(category.slug);
            const active = cats.has(category.slug);
            return (
              <button
                key={category.slug}
                type="button"
                aria-pressed={active}
                onClick={() => toggleCategory(category.slug)}
                className="shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors"
                style={{
                  borderColor: visual.color,
                  color: active ? eventCategoryTextColor(category.slug) : visual.color,
                  background: active ? visual.color : `${visual.color}18`,
                }}
              >
                {visual.icon} {categoryLabel(category.slug, category.name_fr)}
              </button>
            );
          })}
        </div>

        <details className="rounded-2xl border bg-surface/75" open={advancedCount > 0}>
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-semibold">
            <span className="inline-flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-primary" /> {t("home.advanced")}
            </span>
            <Badge variant={advancedCount ? "default" : "outline"}>
              {advancedCount || t("common.all")}
            </Badge>
          </summary>
          <div className="border-t p-3">
            <EventFilterPanel value={advancedFilters} onChange={setAdvancedFilters} compact />
          </div>
        </details>

        <div className="mt-3 grid grid-cols-1 gap-2">
          <LayerToggle
            active={showEvents}
            icon={CalendarDays}
            label={`Événements (${statsLoading ? "…" : COUNT_FORMATTER.format(totalEventCount)})`}
            onClick={() => setShowEvents((value) => !value)}
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span>
            {tr("{count} positions approximatives atténuées", { count: approximateCount })}
          </span>
          <button
            type="button"
            onClick={resetFilters}
            className="inline-flex shrink-0 items-center gap-1 font-semibold hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" /> {t("common.reset")}
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
              {t("common.retry")}
            </button>
          </div>
        )}

        {mapUnavailable && events.length > 0 && (
          <div className="mt-3 rounded-2xl border bg-background/75 p-3">
            <p className="mb-2 text-xs font-bold">{tr("Événements accessibles sans WebGL")}</p>
            <div className="grid gap-1.5">
              {events.slice(0, 12).map((event) => (
                <Link
                  key={event.occurrence_id}
                  to="/event/$slug"
                  params={{ slug: event.slug }}
                  className="rounded-xl border px-3 py-2 text-xs hover:border-primary hover:bg-accent"
                >
                  <span className="block truncate font-semibold">{event.title}</span>
                  <span className="block truncate text-muted-foreground">
                    {event.venue_name ?? event.city_name ?? tr("Lieu à confirmer")}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {selectedEvent && (
        <div className="absolute inset-x-3 bottom-20 z-10 md:inset-x-auto md:bottom-6 md:left-[32rem] md:w-80">
          <div className="map-overlay-panel relative rounded-2xl p-1">
            <button
              type="button"
              aria-label={tr("Fermer la fiche")}
              onClick={() => setSelectedEvent(null)}
              className="absolute -top-3 right-2 z-20 h-8 w-8 rounded-full border bg-background text-xs shadow-lg"
            >
              ×
            </button>
            <EventCard ev={selectedEvent} />
          </div>
        </div>
      )}

      {clusterSelectionOpen && (
        <div className="map-overlay-panel absolute bottom-6 left-[32rem] z-10 w-80 rounded-3xl">
          <SelectedClusterEvents
            events={selectedClusterEvents}
            expectedCount={clusterSelectionExpectedCount}
            loading={clusterSelectionLoading}
            error={clusterSelectionError}
            onClose={closeClusterSelection}
            onRetry={() => clusterSelectionRetryRef.current?.()}
          />
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
      className="flex min-h-11 items-center justify-center gap-2 rounded-2xl border px-2 text-xs font-semibold"
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
