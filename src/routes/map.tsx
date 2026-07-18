import { createFileRoute, Link } from "@tanstack/react-router";
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
  type MapMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  computeRange,
  discoverEventStats,
  discoverMapEvents,
  fetchCategories,
  fetchGeographies,
  searchGeographyCities,
  type CityOption,
  type CountryOption,
  type DiscoveryStats,
  type DiscoveredEvent,
  type QuickRange,
  type RegionOption,
} from "@/lib/queries";
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
  MapPin,
  LoaderCircle,
  Navigation,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Ticket,
} from "lucide-react";

export const Route = createFileRoute("/map")({
  head: () => ({ meta: [{ title: "Carte complète des événements — Global Party" }] }),
  component: MapPage,
});

const GENEVA_CENTER: [number, number] = [6.1432, 46.2044];
const MAPBOX_ACCESS_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined;
const MAPBOX_STYLE = MAPBOX_ACCESS_TOKEN
  ? `https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=${MAPBOX_ACCESS_TOKEN}`
  : null;

const POI_FREE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    basemap: {
      type: "raster",
      tiles: ["https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors © CARTO",
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

function formatMobileEventDate(event: DiscoveredEvent, locale: string): string {
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
  onClose,
}: {
  events: DiscoveredEvent[];
  onClose: () => void;
}) {
  const { tr, localeTag } = useTranslation();
  return (
    <aside className="relative max-h-64 overflow-y-auto p-3 pr-14">
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
      <h2 className="text-base font-black">{tr("{count} sorties", { count: events.length })}</h2>
      <div className="mt-2 grid gap-2">
        {events.slice(0, 25).map((event) => (
          <Link
            key={event.occurrence_id}
            to="/event/$slug"
            params={{ slug: event.slug }}
            className="rounded-xl border bg-background/70 px-3 py-2 text-left hover:border-primary"
          >
            <span className="block truncate text-xs font-black">{event.title}</span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {formatMobileEventDate(event, localeTag)} · {event.venue_name ?? event.city_name}
            </span>
          </Link>
        ))}
      </div>
    </aside>
  );
}

function MapPage() {
  const { t, tr, categoryLabel, formatNumber } = useTranslation();
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
  const [discoveryStats, setDiscoveryStats] = useState<DiscoveryStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [showEvents, setShowEvents] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<DiscoveredEvent | null>(null);
  const [selectedClusterEvents, setSelectedClusterEvents] = useState<DiscoveredEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageMayHaveMoreEvents, setPageMayHaveMoreEvents] = useState(false);
  const [nextEventOffset, setNextEventOffset] = useState(0);
  const [visibleMobileEventCount, setVisibleMobileEventCount] = useState(MOBILE_LIST_BATCH_SIZE);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const [mapUnavailable, setMapUnavailable] = useState<string | null>(null);
  const requestVersionRef = useRef(0);
  const cityRequestVersionRef = useRef(0);

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
  const eventMapPoints = useMemo(
    () =>
      buildMapPointCollection({
        events,
        showEvents,
        countryCode: selectedCountryCode,
      }),
    [events, selectedCountryCode, showEvents],
  );
  const eventsByOccurrenceId = useMemo(
    () => new Map(events.map((event) => [event.occurrence_id, event])),
    [events],
  );
  const mobileListEvents = useMemo(
    () => events.slice(0, visibleMobileEventCount),
    [events, visibleMobileEventCount],
  );
  const requestMapResize = useCallback(() => mapRef.current?.resize(), []);

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
        const geneva = geo.cities.find((city) => city.slug === "geneve");
        if (geneva) {
          setGeography({
            countryId: geneva.country_id,
            regionId: geneva.region_id,
            cityId: geneva.id,
          });
        }
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
    setMapReady(false);
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
        style: MAPBOX_STYLE ?? POI_FREE_STYLE,
        center: GENEVA_CENTER,
        zoom: 12,
        clickTolerance: 8,
        fadeDuration: 0,
      });
    } catch {
      setMapUnavailable("La carte interactive ne peut pas démarrer dans ce navigateur.");
      return;
    }
    let switchedToFallback = false;
    let hasRendered = false;
    const markMapReady = () => {
      hasRendered = true;
      setMapReady(true);
    };
    const fallbackTimer = window.setTimeout(() => {
      if (!MAPBOX_STYLE || map.isStyleLoaded()) return;
      switchedToFallback = true;
      map.setStyle(POI_FREE_STYLE);
    }, 6_000);
    // A raster provider can be slow or blocked while the WebGL canvas is
    // already usable. Do not let the loading veil hide the map indefinitely.
    const revealTimer = window.setTimeout(() => {
      map.resize();
      setMapReady(true);
    }, 2_500);
    const unavailableTimer = window.setTimeout(() => {
      if (hasRendered || map.isStyleLoaded()) return;
      setMapUnavailable(
        "Le fond de carte n'a pas pu démarrer. Vérifie la protection anti-pistage du navigateur.",
      );
    }, 12_000);
    map.once("render", markMapReady);
    map.on("load", markMapReady);
    map.on("style.load", markMapReady);
    map.on("styledata", () => {
      if (map.isStyleLoaded()) setMapReady(true);
    });
    map.on("error", () => {
      if (MAPBOX_STYLE && !switchedToFallback && !map.isStyleLoaded()) {
        switchedToFallback = true;
        map.setStyle(POI_FREE_STYLE);
      }
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;
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
      window.clearTimeout(unavailableTimer);
      window.cancelAnimationFrame(firstResizeFrame);
      window.cancelAnimationFrame(secondResizeFrame);
      resizeObserver?.disconnect();
      window.visualViewport?.removeEventListener("resize", resizeMap);
      window.removeEventListener("orientationchange", resizeMap);
      map.remove();
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [mapContainer]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const scopeKey = `${countryId ?? "world"}:${regionId ?? "all"}:${cityId ?? "all"}`;
    if (lastFittedScopeRef.current === scopeKey) return;
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
  }, [cityId, countryId, events, mapReady, regionId, selectedCity, selectedCountryCode]);

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
      total_count: events.length,
      free_count: events.filter((event) => event.is_free).length,
      verified_count: events.filter((event) => event.is_verified).length,
    }),
    [events],
  );
  const mapStats = discoveryStats ?? localDiscoveryStats;
  const totalEventCount = mapStats.total_count;
  const hasMoreEvents = discoveryStats
    ? nextEventOffset < discoveryStats.total_count
    : pageMayHaveMoreEvents;
  const nextMapPageCount = discoveryStats
    ? Math.min(MAP_EVENT_PAGE_SIZE, Math.max(discoveryStats.total_count - nextEventOffset, 0))
    : MAP_EVENT_PAGE_SIZE;

  useEffect(() => {
    if (!geographyReady) return;
    let current = true;
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setStatsLoading(true);
    setLoadingMore(false);
    setDiscoveryStats(null);
    setPageMayHaveMoreEvents(false);
    setNextEventOffset(0);
    setVisibleMobileEventCount(MOBILE_LIST_BATCH_SIZE);
    setError(null);
    discoverMapEvents({
      ...mapDiscoveryParams,
      limit: MAP_EVENT_PAGE_SIZE,
      offset: 0,
    })
      .then((nextEvents) => {
        if (!current || requestVersion !== requestVersionRef.current) return;
        setEvents(nextEvents);
        setNextEventOffset(nextEvents.length);
        setPageMayHaveMoreEvents(nextEvents.length === MAP_EVENT_PAGE_SIZE);
        setSelectedEvent(null);
        setSelectedClusterEvents([]);
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
  }, [geography, geographyReady, mapDiscoveryParams, reloadKey]);

  const loadMoreEvents = async () => {
    if (loading || loadingMore || !hasMoreEvents) return;
    const requestVersion = requestVersionRef.current;
    const offset = nextEventOffset;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await discoverMapEvents({
        ...mapDiscoveryParams,
        limit: MAP_EVENT_PAGE_SIZE,
        offset,
      });
      if (requestVersion !== requestVersionRef.current) return;
      setEvents((current) => {
        const known = new Set(current.map((event) => event.occurrence_id));
        return [...current, ...page.filter((event) => !known.has(event.occurrence_id))];
      });
      setNextEventOffset(offset + page.length);
      setPageMayHaveMoreEvents(page.length === MAP_EVENT_PAGE_SIZE);
    } catch {
      if (requestVersion === requestVersionRef.current) {
        setError("Impossible de charger la page suivante de points.");
      }
    } finally {
      if (requestVersion === requestVersionRef.current) setLoadingMore(false);
    }
  };

  const loadMoreMobileList = async () => {
    if (visibleMobileEventCount < events.length) {
      setVisibleMobileEventCount((count) => count + MOBILE_LIST_BATCH_SIZE);
      return;
    }
    if (!hasMoreEvents) return;
    await loadMoreEvents();
    setVisibleMobileEventCount((count) => count + MOBILE_LIST_BATCH_SIZE);
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayers = () => {
      if (map.isStyleLoaded()) syncClusterLayers(map, eventMapPoints);
    };
    const expandCluster = async (feature: MapGeoJSONFeature) => {
      if (!feature || feature.geometry.type !== "Point") return;
      const clusterId = Number(feature.properties?.cluster_id);
      if (!Number.isFinite(clusterId)) return;
      const source = map.getSource(MAP_EVENT_SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;

      try {
        const expansionZoom = await source.getClusterExpansionZoom(clusterId);
        const [longitude, latitude] = feature.geometry.coordinates;
        setSelectedEvent(null);
        if (expansionZoom > EVENT_CLUSTER_MAX_ZOOM) {
          const leaves = await source.getClusterLeaves(clusterId, 25, 0);
          const leafEvents = leaves.flatMap((leaf) => {
            const entityId = String(leaf.properties?.entity_id ?? "");
            const event = eventsByOccurrenceId.get(entityId);
            return event ? [event] : [];
          });
          if (leafEvents.length > 1) {
            setSelectedClusterEvents(leafEvents);
            return;
          }
        }
        setSelectedClusterEvents([]);
        map.easeTo({
          center: [Number(longitude), Number(latitude)],
          zoom: clusterExpansionTargetZoom(map.getZoom(), expansionZoom),
          duration: 450,
        });
      } catch {
        // The style may have switched to the OSM fallback during the async lookup.
      }
    };
    const openPoint = (feature: MapGeoJSONFeature) => {
      const properties = feature.properties as Partial<MapPointProperties> | undefined;
      const entityId = typeof properties?.entity_id === "string" ? properties.entity_id : "";

      if (properties?.kind === "event") {
        const selected = eventsByOccurrenceId.get(entityId);
        if (!selected) return;
        setSelectedClusterEvents([]);
        setSelectedEvent(selected);
        void trackClientEvent("map_pin_click", {
          entityType: "event_occurrence",
          entityId: selected.occurrence_id,
          cityId,
          metadata: { precision: selected.location_precision },
        });
      }
    };
    const interactiveLayers = [
      MAP_CLUSTER_HALO_LAYER_ID,
      MAP_CLUSTER_LAYER_ID,
      MAP_EVENT_POINT_LAYER_ID,
    ] as const;
    const handleMapClick = (event: MapMouseEvent) => {
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
    const showPointerCursor = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const resetCursor = () => {
      map.getCanvas().style.cursor = "";
    };
    syncLayers();
    map.on("style.load", syncLayers);
    map.on("click", handleMapClick);
    interactiveLayers.forEach((layerId) => {
      map.on("mouseenter", layerId, showPointerCursor);
      map.on("mouseleave", layerId, resetCursor);
    });

    return () => {
      map.off("style.load", syncLayers);
      map.off("click", handleMapClick);
      interactiveLayers.forEach((layerId) => {
        map.off("mouseenter", layerId, showPointerCursor);
        map.off("mouseleave", layerId, resetCursor);
      });
      resetCursor();
    };
  }, [cityId, eventMapPoints, eventsByOccurrenceId, mapReady]);

  const toggleCategory = (slug: string) => {
    setCats((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const resetFilters = () => {
    const geneva = cities.find((city) => city.slug === "geneve");
    setRange("year");
    setCats(new Set());
    setQuery("");
    setAdvancedFilters({ ...DEFAULT_ADVANCED_FILTERS, genres: [] });
    setGeography(
      geneva
        ? {
            countryId: geneva.country_id,
            regionId: geneva.region_id,
            cityId: geneva.id,
          }
        : { countryId: null, regionId: null, cityId: null },
    );
    setShowEvents(true);
  };

  const approximateCount = events.filter((event) => event.location_precision === "city").length;
  const mobileActiveFilterCount =
    advancedCount + cats.size + Number(range !== "year") + Number(!showEvents);

  if (isMobile) {
    const hasMoreMobileEvents = visibleMobileEventCount < events.length || hasMoreEvents;
    const mobileSelection = selectedEvent ? (
      <MobileSelectedEvent event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    ) : selectedClusterEvents.length ? (
      <SelectedClusterEvents
        events={selectedClusterEvents}
        onClose={() => setSelectedClusterEvents([])}
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
                  ? `${COUNT_FORMATTER.format(events.length)} points chargés · calcul du total…`
                  : `${formatNumber(totalEventCount)} événements · ${formatNumber(events.length)} points chargés · ${selectedCity?.name ?? selectedRegion?.name ?? selectedCountry?.name ?? t("home.world")}`}
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
                  loaded: COUNT_FORMATTER.format(events.length),
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
                disabled={loadingMore}
                onClick={() => void loadMoreMobileList()}
                className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 px-4 text-sm font-black text-primary disabled:opacity-60"
              >
                {loadingMore && <LoaderCircle className="h-4 w-4 animate-spin" />}
                {loadingMore ? t("common.loading") : tr("Afficher plus de sorties")}
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

      <div className="glass absolute left-3 right-3 top-3 z-10 max-h-[calc(100vh-6.5rem)] overflow-y-auto rounded-3xl p-3 shadow-[var(--shadow-card)] md:left-6 md:right-auto md:w-[30rem]">
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
                ? "Chargement des premiers points…"
                : statsLoading
                  ? `${COUNT_FORMATTER.format(events.length)} points chargés · calcul du total…`
                  : `${COUNT_FORMATTER.format(totalEventCount)} événements au total · ${COUNT_FORMATTER.format(mapStats.free_count)} gratuits`}
            </p>
            {!loading && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {tr("{count} points d’événements chargés sur la carte", {
                  count: COUNT_FORMATTER.format(events.length),
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
            className="h-11 rounded-2xl bg-background/80 pl-9"
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
            className="h-11 rounded-2xl border bg-background/80 px-3 text-sm outline-none focus:border-primary"
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

        <details className="rounded-2xl border" open={advancedCount > 0}>
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

        {hasMoreEvents && (
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMoreEvents()}
            className="mt-3 flex min-h-10 w-full items-center justify-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 px-3 text-xs font-semibold text-primary hover:bg-primary/15 disabled:cursor-wait disabled:opacity-70"
          >
            {loadingMore && <LoaderCircle className="h-4 w-4 animate-spin" />}
            {loadingMore
              ? "Chargement des points…"
              : `Afficher ${COUNT_FORMATTER.format(nextMapPageCount)} événements suivants`}
          </button>
        )}

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
          <div className="relative">
            <button
              type="button"
              aria-label={tr("Fermer la fiche")}
              onClick={() => setSelectedEvent(null)}
              className="glass absolute -top-3 right-2 z-20 h-7 w-7 rounded-full text-xs"
            >
              ×
            </button>
            <EventCard ev={selectedEvent} />
          </div>
        </div>
      )}

      {selectedClusterEvents.length > 0 && (
        <div className="glass absolute bottom-6 left-[32rem] z-10 w-80 rounded-3xl shadow-[var(--shadow-card)]">
          <SelectedClusterEvents
            events={selectedClusterEvents}
            onClose={() => setSelectedClusterEvents([])}
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
