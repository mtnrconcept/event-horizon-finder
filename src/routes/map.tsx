import { createFileRoute, Link } from "@tanstack/react-router";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import maplibregl, {
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type MapLayerMouseEvent,
  type MapMouseEvent,
  type MapSourceDataEvent,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  computeRange,
  discoverMapEventsInBounds,
  discoverMapPinsInBounds,
  fetchMapOccurrenceDetail,
  fetchMapOccurrencePreviews,
  type DiscoveredEvent,
  type QuickRange,
} from "@/lib/queries";
import type { CompactMapPinBatch } from "@/lib/map-pins";
import {
  chunkOccurrenceIds,
  mapPreviewExcerpt,
  type MapOccurrencePreview,
} from "@/lib/map-occurrence-previews";
import {
  formatMapDetailPrice,
  mapDetailLocationParts,
  safeExternalUrl,
  type MapDetailOccurrence,
  type MapOccurrenceDetail,
} from "@/lib/map-event-details";
import {
  countAdvancedFilters,
  DEFAULT_ADVANCED_FILTERS,
  toDiscoveryFilters,
} from "@/lib/event-filters";
import { EventCard, EventCardSkeleton } from "@/components/event-card";
import { EventArtworkImage } from "@/components/event-artwork-image";
import { EventFilterPanel } from "@/components/event-filter-panel";
import { MobileDiscoveryLayout } from "@/components/discovery/MobileDiscoveryLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trackClientEvent } from "@/lib/client-analytics";
import { BRAND_ARRIVAL_COMPLETE_EVENT } from "@/lib/brand-arrival-events";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useTranslation } from "@/lib/i18n";
import type { UiTranslationPhrase } from "@/lib/ui-translations";
import {
  pruneSearchSelections,
  resolveSearchTaxonomyFilters,
  SEARCH_CATEGORIES,
  searchCategoryLabel,
} from "@/lib/event-search-taxonomy";
import {
  applyTranslationToMapDetail,
  applyTranslationToMapPreview,
  getEventContentTranslations,
  useEventContentTranslation,
} from "@/lib/event-content-translations";
import {
  buildCompactMapPointCollection,
  coincidentMapPointOccurrenceIds,
  spreadCoincidentMapPoints,
  type MapPointCollection,
  type MapPointProperties,
} from "@/lib/map-clusters";
import {
  clearSessionMapPinCache,
  loadSessionMapPins,
  MAP_SERVER_CLUSTER_MAX_ZOOM,
  readSessionMapPins,
} from "@/lib/map-pin-session-cache";
import { isTransientMapRequestError } from "@/lib/map-network-retry";
import {
  isRenderableMapSurfaceSize,
  mapSurfaceSizesMatch,
  readMapSurfaceSize,
} from "@/lib/map-surface";
import {
  mapViewportBoundsKey,
  normalizeMapViewportBounds,
  type MapViewportBounds,
} from "@/lib/map-viewport";
import {
  MAP_EVENT_PAGE_SIZE,
  MAP_INITIAL_GEOLOCATION_OPTIONS,
  MAP_REFINEMENT_GEOLOCATION_OPTIONS,
  MOBILE_LIST_BATCH_SIZE,
} from "@/lib/map-loading";
import {
  eventCategoryTextColor,
  eventCategoryVisual,
  registerEventCategoryImages,
} from "@/lib/event-category-style";
import {
  beginMapSourceUpdate,
  completeMapSourceUpdate,
  EVENT_CLUSTER_MAX_ZOOM,
  EVENT_CLUSTER_RADIUS,
  EVENT_CLUSTER_TERMINAL_ZOOM,
  EVENT_SOURCE_MAX_ZOOM,
  CLUSTER_SELECTION_PAGE_SIZE,
  clusterLeafPageRequest,
  isMapSourceRevisionReady,
  clusterExpansionTargetZoom,
  eventClusterCircleRadiusExpression,
  eventClusterCountExpression,
  eventClusterTextSizeExpression,
  shouldClusterMapPointsInClient,
  shouldOpenClusterSelection,
  shouldRequestTerminalClusterReload,
  serverClusterExpansionTargetZoom,
} from "@/lib/map-cluster-config";
import {
  mapEventPinOccurrenceId,
  resolveMapEventPinSelection,
  selectHighestPriorityMapHit,
  selectNearestMapHit,
  type MapHitCandidate,
  type MapHitKind,
} from "@/lib/map-interactions";
import {
  Accessibility,
  BadgeCheck,
  Building2,
  CalendarRange,
  CalendarDays,
  CircleAlert,
  Clock,
  DoorOpen,
  ExternalLink,
  Globe2,
  House,
  LoaderCircle,
  MapPin,
  Music,
  Navigation,
  PawPrint,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Ticket,
  UserRound,
  Users,
  Video,
  Wifi,
} from "lucide-react";

export const Route = createFileRoute("/map")({
  head: () => ({ meta: [{ title: "Carte complète des événements — Global Party" }] }),
  component: MapPage,
});

const PRIMARY_MAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
const INITIAL_GEOLOCATION_ZOOM = 11.5;
const MAP_VIEWPORT_REFRESH_DELAY_MS = 320;
const MAP_PRIMARY_STYLE_TIMEOUT_MS = 3_500;
const MAP_REVEAL_TIMEOUT_MS = 2_000;

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

const COUNT_FORMATTER = new Intl.NumberFormat("fr-CH");
const MAP_EVENT_SOURCE_ID = "eventa-map-events";
const MAP_CLUSTER_HALO_LAYER_ID = "eventa-map-cluster-halo";
const MAP_CLUSTER_LAYER_ID = "eventa-map-clusters";
const MAP_CLUSTER_COUNT_LAYER_ID = "eventa-map-cluster-count";
const MAP_EVENT_POINT_LAYER_ID = "eventa-map-event-points";
const MAP_EVENT_LABEL_LAYER_ID = "eventa-map-event-labels";
const MAP_EVENT_LAYER_IDS = [
  MAP_EVENT_LABEL_LAYER_ID,
  MAP_EVENT_POINT_LAYER_ID,
  MAP_CLUSTER_COUNT_LAYER_ID,
  MAP_CLUSTER_LAYER_ID,
  MAP_CLUSTER_HALO_LAYER_ID,
] as const;
const MAP_EVENT_SOURCE_CLIENT_CLUSTERING = new WeakMap<maplibregl.Map, boolean>();
const MAP_EVENT_SOURCE_REVISION = new WeakMap<maplibregl.Map, number>();
const MAP_EVENT_SOURCE_PENDING_REVISION = new WeakMap<maplibregl.Map, number>();
const MAP_EVENT_SOURCE_SETTLE_CLEANUP = new WeakMap<maplibregl.Map, () => void>();
const MOBILE_MAP_HIT_RADIUS = 24;
const DESKTOP_MAP_HIT_RADIUS = 8;
const CLUSTER_PREVIEW_CONCURRENCY = 4;
const DETAIL_LIST_BATCH_SIZE = 24;
const MAP_EVENT_DETAIL_CACHE_LIMIT = 24;
const MAP_EVENT_DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;
const EMPTY_MAP_PIN_BATCH: CompactMapPinBatch = {
  pins: [],
  totalCount: 0,
  freeCount: 0,
  clustered: false,
  truncated: false,
};

type MapEventDetailCacheEntry = {
  detail: MapOccurrenceDetail;
  expiresAt: number;
};

function readMapEventDetailCache(
  cache: Map<string, MapEventDetailCacheEntry>,
  occurrenceId: string,
): MapOccurrenceDetail | null {
  const entry = cache.get(occurrenceId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(occurrenceId);
    return null;
  }
  cache.delete(occurrenceId);
  cache.set(occurrenceId, entry);
  return entry.detail;
}

function writeMapEventDetailCache(
  cache: Map<string, MapEventDetailCacheEntry>,
  occurrenceId: string,
  detail: MapOccurrenceDetail,
) {
  cache.delete(occurrenceId);
  cache.set(occurrenceId, {
    detail,
    expiresAt: Date.now() + MAP_EVENT_DETAIL_CACHE_TTL_MS,
  });
  while (cache.size > MAP_EVENT_DETAIL_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

const MAP_RANGES: { value: QuickRange; label: UiTranslationPhrase }[] = [
  { value: "tonight", label: "Ce soir" },
  { value: "today", label: "Aujourd'hui" },
  { value: "tomorrow", label: "Demain" },
  { value: "weekend", label: "Ce week-end" },
  { value: "week", label: "7 jours" },
  { value: "month", label: "30 jours" },
  { value: "year", label: "12 prochains mois" },
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
      if (map.getLayoutProperty(layer.id, "visibility") !== "none") {
        map.setLayoutProperty(layer.id, "visibility", "none");
      }
    }
  }
}

function syncClusterLayers(
  map: maplibregl.Map,
  eventPoints: MapPointCollection,
  serverClustered: boolean,
) {
  hideBasemapPoiLayers(map);
  const sourceRevision = beginMapSourceUpdate(
    MAP_EVENT_SOURCE_REVISION,
    MAP_EVENT_SOURCE_PENDING_REVISION,
    map,
  );
  MAP_EVENT_SOURCE_SETTLE_CLEANUP.get(map)?.();
  let listening = true;
  const cleanupSourceSettlement = () => {
    if (!listening) return;
    listening = false;
    map.off("sourcedata", handleSourceData);
    map.off("idle", handleMapIdle);
    if (MAP_EVENT_SOURCE_SETTLE_CLEANUP.get(map) === cleanupSourceSettlement) {
      MAP_EVENT_SOURCE_SETTLE_CLEANUP.delete(map);
    }
  };
  const completeSourceSettlement = () => {
    if (!map.getSource(MAP_EVENT_SOURCE_ID) || !map.isSourceLoaded(MAP_EVENT_SOURCE_ID)) return;
    if (
      completeMapSourceUpdate(
        MAP_EVENT_SOURCE_REVISION,
        MAP_EVENT_SOURCE_PENDING_REVISION,
        map,
        sourceRevision,
      )
    ) {
      cleanupSourceSettlement();
    }
  };
  function handleSourceData(event: MapSourceDataEvent) {
    if (event.sourceId === MAP_EVENT_SOURCE_ID) completeSourceSettlement();
  }
  function handleMapIdle() {
    completeSourceSettlement();
  }
  map.on("sourcedata", handleSourceData);
  map.on("idle", handleMapIdle);
  MAP_EVENT_SOURCE_SETTLE_CLEANUP.set(map, cleanupSourceSettlement);

  const clientClustered = shouldClusterMapPointsInClient(serverClustered);
  const previousClientClustered = MAP_EVENT_SOURCE_CLIENT_CLUSTERING.get(map);
  let existingEventSource = map.getSource(MAP_EVENT_SOURCE_ID) as GeoJSONSource | undefined;

  if (existingEventSource && previousClientClustered !== clientClustered) {
    for (const layerId of MAP_EVENT_LAYER_IDS) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    }
    map.removeSource(MAP_EVENT_SOURCE_ID);
    existingEventSource = undefined;
  }

  if (existingEventSource) {
    existingEventSource.setData(eventPoints);
  } else {
    map.addSource(MAP_EVENT_SOURCE_ID, {
      type: "geojson",
      data: eventPoints,
      cluster: clientClustered,
      clusterMaxZoom: EVENT_CLUSTER_MAX_ZOOM,
      clusterRadius: EVENT_CLUSTER_RADIUS,
      maxzoom: EVENT_SOURCE_MAX_ZOOM,
      clusterProperties: {
        event_count: ["+", ["get", "event_count"]],
        free_count: ["+", ["get", "free_count"]],
      },
    });
  }
  MAP_EVENT_SOURCE_CLIENT_CLUSTERING.set(map, clientClustered);

  registerEventCategoryImages(map);

  if (!map.getLayer(MAP_EVENT_POINT_LAYER_ID)) {
    map.addLayer({
      id: MAP_EVENT_POINT_LAYER_ID,
      type: "circle",
      source: MAP_EVENT_SOURCE_ID,
      filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "kind"], "event"]],
      paint: {
        "circle-color": ["get", "category_color"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 10, 12, 14, 16, 19],
        "circle-blur": 0.45,
        "circle-stroke-width": 0,
        "circle-opacity": ["case", ["==", ["get", "approximate"], 1], 0.16, 0.24],
      },
    });
  }

  if (!map.getLayer(MAP_EVENT_LABEL_LAYER_ID)) {
    map.addLayer({
      id: MAP_EVENT_LABEL_LAYER_ID,
      type: "symbol",
      source: MAP_EVENT_SOURCE_ID,
      filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "kind"], "event"]],
      layout: {
        "icon-image": ["get", "category_icon_image"],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.62, 12, 0.78, 16, 1.02],
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
      filter: [
        "any",
        ["has", "point_count"],
        ["==", ["get", "kind"], "server_cluster"],
        ["==", ["get", "kind"], "coincident_cluster"],
      ],
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
      filter: [
        "any",
        ["has", "point_count"],
        ["==", ["get", "kind"], "server_cluster"],
        ["==", ["get", "kind"], "coincident_cluster"],
      ],
      paint: {
        "circle-color": [
          "step",
          eventClusterCountExpression(),
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
      filter: [
        "any",
        ["has", "point_count"],
        ["==", ["get", "kind"], "server_cluster"],
        ["==", ["get", "kind"], "coincident_cluster"],
      ],
      layout: {
        "text-field": ["to-string", eventClusterCountExpression()],
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

function isMapEventSourceInteractionReady(map: maplibregl.Map, expectedRevision: number): boolean {
  return (
    isMapSourceRevisionReady(
      MAP_EVENT_SOURCE_REVISION,
      MAP_EVENT_SOURCE_PENDING_REVISION,
      map,
      expectedRevision,
    ) &&
    Boolean(map.getSource(MAP_EVENT_SOURCE_ID)) &&
    map.isSourceLoaded(MAP_EVENT_SOURCE_ID)
  );
}

function MapSurface({
  containerRef,
  mapReady,
  mapUnavailable,
  fallbackCenter,
}: {
  containerRef: RefCallback<HTMLDivElement>;
  mapReady: boolean;
  mapUnavailable: string | null;
  fallbackCenter: { latitude: number; longitude: number } | null;
}) {
  const { tr } = useTranslation();
  const openStreetMapHref = fallbackCenter
    ? `https://www.openstreetmap.org/#map=12/${fallbackCenter.latitude}/${fallbackCenter.longitude}`
    : "https://www.openstreetmap.org";
  return (
    <div className="map-surface relative h-full w-full">
      <div ref={containerRef} className={mapUnavailable ? "hidden" : "map-surface__viewport"} />
      {mapUnavailable && (
        <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_70%_20%,oklch(0.68_0.22_295_/_0.18),transparent_32%),linear-gradient(135deg,var(--color-background),var(--color-muted))] p-6">
          <div className="max-w-md text-center md:ml-[30rem]">
            <MapPin className="mx-auto mb-4 h-10 w-10 text-primary" />
            <h2 className="text-xl font-black">{tr("Carte en mode accessible")}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{mapUnavailable}</p>
            <a
              href={openStreetMapHref}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground"
            >
              {tr("Ouvrir ma zone dans OpenStreetMap")}
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

type GeolocationStatus = "requesting" | "ready" | "denied" | "unavailable" | "error";

function LocationPermissionGate({
  status,
  onRetry,
}: {
  status: Exclude<GeolocationStatus, "ready">;
  onRetry: () => void;
}) {
  const { tr } = useTranslation();
  const requesting = status === "requesting";
  const message =
    status === "denied"
      ? tr(
          "La localisation est désactivée. Autorise-la dans les réglages du navigateur, puis réessaie.",
        )
      : status === "unavailable"
        ? tr("Ce navigateur ne peut pas fournir ta position actuelle.")
        : status === "error"
          ? tr("Ta position n’a pas pu être déterminée. Vérifie le GPS et la connexion.")
          : tr("Autorise la localisation pour ouvrir la carte autour de toi.");

  return (
    <main className="grid min-h-[calc(100dvh-4rem)] place-items-center bg-[radial-gradient(circle_at_50%_15%,oklch(0.62_0.25_295_/_0.18),transparent_38%),var(--color-background)] p-5">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="map-location-title"
        aria-describedby="map-location-description"
        className="w-full max-w-md rounded-[2rem] border border-primary/35 bg-surface p-6 text-center shadow-2xl"
      >
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-primary/15 text-primary">
          {requesting ? (
            <LoaderCircle className="h-8 w-8 animate-spin" aria-hidden="true" />
          ) : (
            <Navigation className="h-8 w-8" aria-hidden="true" />
          )}
        </div>
        <h1 id="map-location-title" className="mt-5 text-2xl font-black">
          {tr("Localisation requise")}
        </h1>
        <p
          id="map-location-description"
          role="status"
          aria-live="polite"
          className="mt-3 text-sm leading-relaxed text-muted-foreground"
        >
          {message}
        </p>
        {!requesting && (
          <Button type="button" onClick={onRetry} className="mt-6 min-h-12 w-full rounded-2xl">
            <Navigation className="h-4 w-4" aria-hidden="true" />
            {tr("Activer ma localisation")}
          </Button>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          {tr("Ta position sert uniquement à centrer la carte et n’est pas enregistrée.")}
        </p>
      </section>
    </main>
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

function detailPlainText(value: string | null | undefined): string {
  return mapPreviewExcerpt(value, 50_000);
}

const DETAIL_TIME_ZONE_VALIDITY = new Map<string, boolean>();
const DETAIL_DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function detailTimeZone(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (!value) continue;
    let isValid = DETAIL_TIME_ZONE_VALIDITY.get(value);
    if (isValid == null) {
      try {
        new Intl.DateTimeFormat("fr", { timeZone: value }).format(new Date(0));
        isValid = true;
      } catch {
        isValid = false;
      }
      DETAIL_TIME_ZONE_VALIDITY.set(value, isValid);
    }
    if (isValid) return value;
  }
  return "UTC";
}

function formatDetailDateTime(
  value: string,
  occurrence: Pick<
    MapDetailOccurrence,
    "timezone" | "all_day" | "local_start_date" | "local_end_date"
  >,
  locale: string,
  localCalendarDate: string | null | undefined = occurrence.local_start_date,
): string {
  if (occurrence.all_day && localCalendarDate && /^\d{4}-\d{2}-\d{2}$/.test(localCalendarDate)) {
    const [year, month, day] = localCalendarDate.split("-").map(Number);
    const formatterKey = `${locale}:UTC:calendar-date`;
    let formatter = DETAIL_DATE_FORMATTERS.get(formatterKey);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale, {
        timeZone: "UTC",
        dateStyle: "full",
      });
      DETAIL_DATE_FORMATTERS.set(formatterKey, formatter);
    }
    return formatter.format(new Date(Date.UTC(year, month - 1, day)));
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    const timeZone = detailTimeZone(occurrence.timezone);
    const formatterKey = `${locale}:${timeZone}:${occurrence.all_day ? "date" : "datetime"}`;
    let formatter = DETAIL_DATE_FORMATTERS.get(formatterKey);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale, {
        timeZone,
        dateStyle: "full",
        ...(occurrence.all_day ? {} : { timeStyle: "short" as const }),
      });
      DETAIL_DATE_FORMATTERS.set(formatterKey, formatter);
    }
    return formatter.format(date);
  } catch {
    return date.toLocaleString(locale);
  }
}

function scrapedValue(detail: MapOccurrenceDetail | null, key: string) {
  return detail?.scraped_details?.[key];
}

function scrapedText(detail: MapOccurrenceDetail | null, key: string): string | null {
  const value = scrapedValue(detail, key);
  if (typeof value === "string") return detailPlainText(value) || null;
  if (typeof value === "number") return String(value);
  return null;
}

function scrapedBoolean(detail: MapOccurrenceDetail | null, key: string): boolean | null {
  const value = scrapedValue(detail, key);
  return typeof value === "boolean" ? value : null;
}

function scrapedNumber(detail: MapOccurrenceDetail | null, key: string): number | null {
  const value = scrapedValue(detail, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function MapDetailSection({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: typeof Ticket;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-border bg-surface p-4 sm:p-5 ${className ?? ""}`}
    >
      <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wide">
        <Icon className="h-4 w-4 text-primary" /> {title}
      </h3>
      <div className="mt-3 text-sm leading-6 text-foreground/85">{children}</div>
    </section>
  );
}

function SelectedMapEventDialog({
  open,
  event: sourceEvent,
  detail: sourceDetail,
  loading,
  error,
  onOpenChange,
  onRetry,
}: {
  open: boolean;
  event: MapOccurrencePreview | null;
  detail: MapOccurrenceDetail | null;
  loading: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
}) {
  const { t, tr, locale, localeTag, categoryLabel, formatNumber } = useTranslation();
  const translation = useEventContentTranslation(
    sourceDetail?.event_id ?? sourceEvent?.event_id,
    locale,
    "full",
  );
  const safeTranslation = sourceDetail?.uses_publication_projection ? undefined : translation;
  const event = sourceEvent ? applyTranslationToMapPreview(sourceEvent, safeTranslation) : null;
  const detail = sourceDetail ? applyTranslationToMapDetail(sourceDetail, safeTranslation) : null;
  const [showOccurrenceList, setShowOccurrenceList] = useState(false);
  const [visibleOccurrenceCount, setVisibleOccurrenceCount] = useState(DETAIL_LIST_BATCH_SIZE);
  const [visibleOfferCount, setVisibleOfferCount] = useState(DETAIL_LIST_BATCH_SIZE);
  const [visiblePerformerCount, setVisiblePerformerCount] = useState(DETAIL_LIST_BATCH_SIZE);
  const [visibleMediaCount, setVisibleMediaCount] = useState(DETAIL_LIST_BATCH_SIZE);
  const selectionId = detail?.occurrence_id ?? event?.occurrence_id ?? null;
  useEffect(() => {
    setShowOccurrenceList(false);
    setVisibleOccurrenceCount(DETAIL_LIST_BATCH_SIZE);
    setVisibleOfferCount(DETAIL_LIST_BATCH_SIZE);
    setVisiblePerformerCount(DETAIL_LIST_BATCH_SIZE);
    setVisibleMediaCount(DETAIL_LIST_BATCH_SIZE);
  }, [open, selectionId]);
  const selectedOccurrence = detail?.selected_occurrence ?? null;
  const title =
    (safeTranslation ? detail?.title : event?.title) ??
    detail?.title ??
    event?.title ??
    tr("Événement sélectionné");
  const imageUrl =
    safeMapPreviewImageUrl(detail?.cover_image_url ?? event?.cover_image_url ?? null) ??
    detail?.media.find((item) => item.media_type.toLowerCase().startsWith("image"))?.url ??
    null;
  const artworkEventId = detail?.event_id ?? event?.event_id ?? "";
  const description = detailPlainText(detail?.description ?? event?.description);
  const shortDescription = mapPreviewExcerpt(
    detail?.short_description ?? event?.short_description,
    800,
  );
  const occurrenceStatusLabels: Record<string, string> = {
    scheduled: tr("Programmé"),
    cancelled: tr("Annulé"),
    postponed: tr("Reporté"),
    sold_out: tr("Complet"),
  };
  const ticketStatusLabels: Record<string, string> = {
    available: tr("Disponible"),
    limited: tr("Places limitées"),
    sold_out: tr("Complet"),
    free: t("common.free"),
    on_sale_soon: tr("Bientôt en vente"),
    unknown: tr("À confirmer"),
  };
  const eventStatusLabels: Record<string, string> = {
    published: tr("Publié"),
    cancelled: tr("Annulé"),
    postponed: tr("Reporté"),
    sold_out: tr("Complet"),
  };
  const statusLabel = detail ? (eventStatusLabels[detail.status] ?? detail.status) : null;
  const locationParts = detail ? mapDetailLocationParts(detail) : [];
  const venueCoordinates = [
    [detail?.venue?.latitude, detail?.venue?.longitude],
    [selectedOccurrence?.latitude, selectedOccurrence?.longitude],
  ].find(
    (coordinates): coordinates is [number, number] =>
      coordinates[0] != null &&
      coordinates[1] != null &&
      Number.isFinite(coordinates[0]) &&
      Number.isFinite(coordinates[1]),
  );
  const itineraryUrl = venueCoordinates
    ? `https://www.openstreetmap.org/?mlat=${venueCoordinates[0]}&mlon=${venueCoordinates[1]}#map=17/${venueCoordinates[0]}/${venueCoordinates[1]}`
    : null;
  const scrapedTicketUrl = safeExternalUrl(scrapedText(detail, "ticket_or_registration_url"));
  const sourceUrl = safeExternalUrl(scrapedText(detail, "source_url"));
  const licenseUrl = safeExternalUrl(scrapedText(detail, "source_license_url"));
  const venueWebsite =
    detail?.venue?.website ?? safeExternalUrl(scrapedText(detail, "venue_website"));
  const organizerWebsite =
    detail?.organizer?.website ?? safeExternalUrl(scrapedText(detail, "organizer_url"));
  const onlineEvent = scrapedBoolean(detail, "online_event");
  const bookingRequired = scrapedBoolean(detail, "booking_required");
  const indoor = scrapedBoolean(detail, "indoor");
  const petsAllowed = scrapedBoolean(detail, "pets_allowed");
  const rawCapacity = scrapedNumber(detail, "capacity_raw");
  const sourceIsFree = scrapedBoolean(detail, "is_free_raw") ?? false;
  const sourcePriceLabel = detail
    ? formatMapDetailPrice(
        {
          price_min: scrapedNumber(detail, "price_min_raw"),
          price_max: scrapedNumber(detail, "price_max_raw"),
          currency: scrapedText(detail, "currency_raw"),
          is_free: sourceIsFree,
        },
        localeTag,
        t("common.free"),
      )
    : null;
  const displayLanguage = detail?.language ?? scrapedText(detail, "language_raw");
  const hasAccessInfo = Boolean(
    detail?.accessibility && Object.values(detail.accessibility).some((value) => value !== null),
  );
  const supplementaryRows = detail
    ? [
        [tr("Type"), scrapedText(detail, "event_type")],
        [tr("Sous-type"), scrapedText(detail, "event_subtype")],
        [tr("Public"), scrapedText(detail, "audience")],
      ].filter((row): row is [string, string] => Boolean(row[1]))
    : [];
  const ageMinimum = scrapedText(detail, "age_min");
  const ageMaximum = scrapedText(detail, "age_max");
  const ageLabel =
    detail?.age_restriction ??
    (ageMinimum || ageMaximum
      ? tr("De {min} à {max} ans", {
          min: ageMinimum ?? "0",
          max: ageMaximum ?? "+",
        })
      : null);
  const mainLinks = (() => {
    if (!detail) return [];
    const links: Array<{ label: string; url: string; ticket: boolean }> = [];
    const knownUrls = new Set<string>();
    const addLink = (label: string, url: string | null, ticket: boolean) => {
      if (!url || knownUrls.has(url)) return;
      knownUrls.add(url);
      links.push({ label, url, ticket });
    };
    const primaryOffer = detail.offers.find((offer) => offer.ticket_url);
    addLink(primaryOffer?.name || tr("Billetterie"), primaryOffer?.ticket_url ?? null, true);
    addLink(tr("Réserver / s’inscrire"), scrapedTicketUrl, true);
    addLink(tr("Site officiel"), detail.official_url, false);
    return links;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={tr("Fermer la fiche")}
        className="map-event-dialog grid h-[min(94dvh,54rem)] max-w-4xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-3xl border-border bg-background p-0 shadow-2xl sm:rounded-3xl"
      >
        {event || detail ? (
          <>
            <div className="relative h-[min(12rem,24dvh)] shrink-0 overflow-hidden bg-gradient-to-br from-primary via-secondary to-primary/70 sm:h-[min(15rem,28dvh)]">
              <div className="absolute inset-0 grid place-items-center text-4xl text-primary-foreground">
                ✦
              </div>
              {imageUrl && artworkEventId && (
                <EventArtworkImage
                  key={artworkEventId}
                  eventId={artworkEventId}
                  sourceUrl={imageUrl}
                  alt=""
                  loading="eager"
                  referrerPolicy="no-referrer"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-background via-background/25 to-black/15" />
            </div>

            <div className="min-h-0 overflow-y-auto overscroll-contain p-4 pt-3 sm:p-6 sm:pt-3">
              <DialogDescription className="sr-only">
                {tr("Informations complètes de l’événement sélectionné")}
              </DialogDescription>
              <div className="flex flex-wrap items-center gap-2 pr-10">
                <Badge className="border-transparent bg-primary/15 text-primary">
                  {tr("Événement sélectionné")}
                </Badge>
                {detail?.category && (
                  <Badge variant="outline">
                    {categoryLabel(detail.category.slug, detail.category.name_fr)}
                  </Badge>
                )}
                {(detail?.is_free || sourceIsFree) && <Badge>{t("common.free")}</Badge>}
                {detail?.is_verified && (
                  <Badge variant="outline" className="gap-1">
                    <BadgeCheck className="h-3 w-3" /> {tr("Vérifié")}
                  </Badge>
                )}
                {statusLabel && (
                  <Badge variant={detail?.status === "cancelled" ? "destructive" : "outline"}>
                    {statusLabel}
                  </Badge>
                )}
              </div>

              <DialogTitle className="mt-3 pr-8 text-2xl font-black leading-tight sm:text-3xl">
                {title}
              </DialogTitle>
              {shortDescription && (
                <p className="mt-2 whitespace-pre-line text-sm leading-6 text-muted-foreground sm:text-base">
                  {shortDescription}
                </p>
              )}

              <div role="status" aria-live="polite" aria-busy={loading} className="mt-4">
                {loading && (
                  <div className="flex items-center gap-2 rounded-xl border bg-surface px-3 py-2 text-xs font-bold text-muted-foreground">
                    <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
                    {tr("Chargement de toutes les informations…")}
                  </div>
                )}
                {detail && !loading && !error && (
                  <span className="sr-only">
                    {tr("Informations complètes de l’événement sélectionné")}
                  </span>
                )}
                {error && !loading && (
                  <div
                    role="alert"
                    className="rounded-2xl border border-destructive/50 bg-destructive/10 p-4 text-sm text-foreground"
                  >
                    <p>{error}</p>
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-3 min-h-11"
                      onClick={onRetry}
                    >
                      {t("common.retry")}
                    </Button>
                  </div>
                )}
              </div>

              {mainLinks.length > 0 && (
                <div className="mt-5 flex flex-wrap gap-2">
                  {mainLinks.map((link) => (
                    <a
                      key={`${link.label}-${link.url}`}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => {
                        if (!link.ticket || !detail) return;
                        void trackClientEvent("ticket_click", {
                          entityType: "event",
                          entityId: detail.event_id,
                          metadata: { surface: "map_modal" },
                        });
                      }}
                      className={
                        link.ticket
                          ? "inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-black text-primary-foreground"
                          : "inline-flex min-h-11 items-center gap-2 rounded-xl border bg-surface px-4 py-2 text-sm font-black hover:border-primary"
                      }
                    >
                      {link.ticket ? (
                        <Ticket className="h-4 w-4" />
                      ) : (
                        <Globe2 className="h-4 w-4" />
                      )}
                      {link.label} <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ))}
                </div>
              )}

              {detail ? (
                <div className="mt-6 grid gap-3 md:grid-cols-2">
                  <MapDetailSection icon={CalendarRange} title={tr("Date et horaires")}>
                    <div className="grid gap-3">
                      <div className="rounded-xl bg-muted/50 p-3">
                        <p className="font-black">
                          {formatDetailDateTime(
                            selectedOccurrence!.starts_at,
                            selectedOccurrence!,
                            localeTag,
                          )}
                        </p>
                        {selectedOccurrence?.ends_at && (
                          <p className="mt-1 text-muted-foreground">
                            {tr("Fin : {date}", {
                              date: formatDetailDateTime(
                                selectedOccurrence.ends_at,
                                selectedOccurrence,
                                localeTag,
                                selectedOccurrence.local_end_date,
                              ),
                            })}
                          </p>
                        )}
                        {selectedOccurrence?.doors_open_at && (
                          <p className="mt-1 flex items-center gap-1.5 text-muted-foreground">
                            <DoorOpen className="h-4 w-4" />
                            {tr("Ouverture des portes : {date}", {
                              date: formatDetailDateTime(
                                selectedOccurrence.doors_open_at,
                                selectedOccurrence,
                                localeTag,
                                null,
                              ),
                            })}
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                          <Badge variant="outline">
                            {tr("Fuseau : {timezone}", {
                              timezone: detailTimeZone(
                                selectedOccurrence?.timezone,
                                detail.city?.timezone,
                              ),
                            })}
                          </Badge>
                          {selectedOccurrence?.all_day && (
                            <Badge variant="outline">{tr("Toute la journée")}</Badge>
                          )}
                          {selectedOccurrence?.time_precision && (
                            <Badge variant="outline">{selectedOccurrence.time_precision}</Badge>
                          )}
                          {selectedOccurrence?.status && (
                            <Badge variant="outline">
                              {occurrenceStatusLabels[selectedOccurrence.status] ??
                                selectedOccurrence.status}
                            </Badge>
                          )}
                          {selectedOccurrence?.ticket_status && (
                            <Badge variant="outline">
                              {ticketStatusLabels[selectedOccurrence.ticket_status] ??
                                selectedOccurrence.ticket_status}
                            </Badge>
                          )}
                        </div>
                      </div>
                      {detail.occurrences.length > 1 && (
                        <div>
                          <button
                            type="button"
                            className="min-h-11 font-black text-primary hover:underline"
                            onClick={() => setShowOccurrenceList(true)}
                          >
                            {tr("Toutes les dates ({count})", {
                              count: formatNumber(detail.occurrences.length),
                            })}
                          </button>
                          {showOccurrenceList && (
                            <>
                              <ol className="mt-2 grid gap-2">
                                {detail.occurrences
                                  .slice(0, visibleOccurrenceCount)
                                  .map((occurrence) => (
                                    <li
                                      key={occurrence.id}
                                      className="rounded-lg border bg-background px-3 py-2"
                                      style={{
                                        contentVisibility: "auto",
                                        containIntrinsicSize: "0 76px",
                                      }}
                                    >
                                      <time
                                        dateTime={occurrence.starts_at}
                                        className="font-semibold"
                                      >
                                        {formatDetailDateTime(
                                          occurrence.starts_at,
                                          occurrence,
                                          localeTag,
                                        )}
                                      </time>
                                      {occurrence.ends_at && (
                                        <p className="text-xs text-muted-foreground">
                                          {tr("Fin : {date}", {
                                            date: formatDetailDateTime(
                                              occurrence.ends_at,
                                              occurrence,
                                              localeTag,
                                              occurrence.local_end_date,
                                            ),
                                          })}
                                        </p>
                                      )}
                                      {occurrence.id === detail.occurrence_id && (
                                        <Badge className="mt-1.5">{tr("Date sélectionnée")}</Badge>
                                      )}
                                    </li>
                                  ))}
                              </ol>
                              {visibleOccurrenceCount < detail.occurrences.length && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="mt-2 min-h-11"
                                  onClick={() =>
                                    setVisibleOccurrenceCount(
                                      (count) => count + DETAIL_LIST_BATCH_SIZE,
                                    )
                                  }
                                >
                                  {tr("Voir plus")}
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </MapDetailSection>

                  <MapDetailSection icon={MapPin} title={tr("Lieu et accès")}>
                    <div className="grid gap-2">
                      {locationParts.length ? (
                        <address className="not-italic">
                          {locationParts.map((part) => (
                            <span key={part} className="block">
                              {part}
                            </span>
                          ))}
                        </address>
                      ) : (
                        <address className="not-italic">{tr("Lieu à confirmer")}</address>
                      )}
                      {detail.venue?.description && (
                        <p className="whitespace-pre-line text-muted-foreground">
                          {detailPlainText(detail.venue.description)}
                        </p>
                      )}
                      {(selectedOccurrence?.capacity ?? detail.venue?.capacity ?? rawCapacity) !=
                        null && (
                        <p className="flex items-center gap-2">
                          <Users className="h-4 w-4 text-primary" />
                          {tr("Capacité : {count}", {
                            count: formatNumber(
                              selectedOccurrence?.capacity ??
                                detail.venue?.capacity ??
                                rawCapacity ??
                                0,
                            ),
                          })}
                        </p>
                      )}
                      {onlineEvent != null && (
                        <p className="flex items-center gap-2">
                          <Wifi className="h-4 w-4 text-primary" />
                          {onlineEvent ? tr("Événement en ligne") : tr("Événement sur place")}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-3 pt-1 text-xs font-bold text-primary">
                        {itineraryUrl && (
                          <a
                            href={itineraryUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 hover:underline"
                          >
                            <Navigation className="h-3.5 w-3.5" /> {tr("Itinéraire")}
                          </a>
                        )}
                        {venueWebsite && (
                          <a
                            href={venueWebsite}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 hover:underline"
                          >
                            {tr("Site du lieu")} <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                    </div>
                  </MapDetailSection>

                  <MapDetailSection
                    icon={Ticket}
                    title={tr("Billets et réservation")}
                    className="md:col-span-2"
                  >
                    <div className="grid gap-3">
                      {detail.offers.length ? (
                        detail.offers.slice(0, visibleOfferCount).map((offer) => (
                          <article
                            key={offer.id}
                            className="rounded-xl border bg-background p-3"
                            style={{ contentVisibility: "auto", containIntrinsicSize: "0 116px" }}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <h4 className="font-black">{offer.name}</h4>
                                <p className="text-muted-foreground">
                                  {formatMapDetailPrice(offer, localeTag, t("common.free")) ??
                                    sourcePriceLabel ??
                                    tr("Prix sur le site")}
                                </p>
                              </div>
                              {offer.status && (
                                <Badge variant="outline">
                                  {ticketStatusLabels[offer.status] ?? offer.status}
                                </Badge>
                              )}
                            </div>
                            {offer.ticket_url && (
                              <a
                                href={offer.ticket_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-2 inline-flex min-h-11 items-center gap-1 font-black text-primary hover:underline"
                              >
                                {tr("Billetterie")} <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            )}
                          </article>
                        ))
                      ) : (
                        <p>{sourcePriceLabel ?? tr("Prix sur le site")}</p>
                      )}
                      {visibleOfferCount < detail.offers.length && (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          onClick={() =>
                            setVisibleOfferCount((count) => count + DETAIL_LIST_BATCH_SIZE)
                          }
                        >
                          {tr("Voir plus")}
                        </Button>
                      )}
                      {bookingRequired != null && (
                        <p className="font-semibold">
                          {bookingRequired
                            ? tr("Réservation obligatoire")
                            : tr("Réservation non obligatoire")}
                        </p>
                      )}
                      {scrapedTicketUrl &&
                        !detail.offers.some((offer) => offer.ticket_url === scrapedTicketUrl) && (
                          <a
                            href={scrapedTicketUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex min-h-11 items-center gap-1 font-black text-primary hover:underline"
                          >
                            {tr("Réserver / s’inscrire")} <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                    </div>
                  </MapDetailSection>

                  {(detail.organizer || organizerWebsite) && (
                    <MapDetailSection icon={Building2} title={tr("Organisateur et contacts")}>
                      <div className="grid gap-2">
                        {detail.organizer && (
                          <>
                            <p className="font-black">{detail.organizer.name}</p>
                            {detail.organizer.description && (
                              <p className="whitespace-pre-line text-muted-foreground">
                                {detailPlainText(detail.organizer.description)}
                              </p>
                            )}
                          </>
                        )}
                        {organizerWebsite && (
                          <a
                            href={organizerWebsite}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-bold text-primary hover:underline"
                          >
                            {tr("Site officiel")} <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                    </MapDetailSection>
                  )}

                  {description && description !== shortDescription && (
                    <MapDetailSection
                      icon={UserRound}
                      title={tr("Description complète")}
                      className="md:col-span-2"
                    >
                      <div className="grid gap-3 whitespace-pre-line">{description}</div>
                    </MapDetailSection>
                  )}

                  {(supplementaryRows.length > 0 ||
                    detail.genres.length > 0 ||
                    displayLanguage ||
                    ageLabel ||
                    indoor != null ||
                    petsAllowed != null) && (
                    <MapDetailSection icon={Music} title={tr("Programme et informations")}>
                      <dl className="grid gap-3">
                        {detail.genres.length > 0 && (
                          <div>
                            <dt className="text-xs font-black uppercase text-muted-foreground">
                              {tr("Styles et genres")}
                            </dt>
                            <dd className="mt-1 flex flex-wrap gap-1.5">
                              {detail.genres.map((genre) => (
                                <Badge key={genre} variant="outline">
                                  {genre}
                                </Badge>
                              ))}
                            </dd>
                          </div>
                        )}
                        {supplementaryRows.map(([label, value]) => (
                          <div key={label}>
                            <dt className="text-xs font-black uppercase text-muted-foreground">
                              {label}
                            </dt>
                            <dd className="mt-1 whitespace-pre-line">{value}</dd>
                          </div>
                        ))}
                        {displayLanguage && (
                          <div>
                            <dt className="text-xs font-black uppercase text-muted-foreground">
                              {tr("Langue")}
                            </dt>
                            <dd className="mt-1">{displayLanguage}</dd>
                          </div>
                        )}
                        {ageLabel && (
                          <div>
                            <dt className="text-xs font-black uppercase text-muted-foreground">
                              {tr("Âge")}
                            </dt>
                            <dd className="mt-1">{ageLabel}</dd>
                          </div>
                        )}
                        {(indoor != null || petsAllowed != null) && (
                          <div className="flex flex-wrap gap-2">
                            {indoor != null && (
                              <Badge variant="outline" className="gap-1">
                                <House className="h-3.5 w-3.5" />
                                {indoor ? tr("En intérieur") : tr("En extérieur")}
                              </Badge>
                            )}
                            {petsAllowed != null && (
                              <Badge variant="outline" className="gap-1">
                                <PawPrint className="h-3.5 w-3.5" />
                                {petsAllowed ? tr("Animaux admis") : tr("Animaux non admis")}
                              </Badge>
                            )}
                          </div>
                        )}
                      </dl>
                    </MapDetailSection>
                  )}

                  {hasAccessInfo && (
                    <MapDetailSection icon={Accessibility} title={tr("Accessibilité")}>
                      {detail.accessibility && (
                        <dl className="grid gap-2 sm:grid-cols-2">
                          {[
                            [tr("Accès fauteuil roulant"), detail.accessibility.wheelchair],
                            [tr("Boucle auditive"), detail.accessibility.hearing_loop],
                            [tr("Langue des signes"), detail.accessibility.sign_language],
                            [tr("Espace calme"), detail.accessibility.quiet_space],
                          ].map(([label, value]) =>
                            value == null ? null : (
                              <div key={String(label)} className="flex justify-between gap-3">
                                <dt>{label}</dt>
                                <dd className="font-black">{value ? tr("Oui") : tr("Non")}</dd>
                              </div>
                            ),
                          )}
                          {detail.accessibility.notes && (
                            <div className="sm:col-span-2">
                              <dt className="font-black">{tr("Notes")}</dt>
                              <dd className="mt-1 whitespace-pre-line">
                                {detailPlainText(detail.accessibility.notes)}
                              </dd>
                            </div>
                          )}
                        </dl>
                      )}
                    </MapDetailSection>
                  )}

                  {detail.performers.length > 0 && (
                    <MapDetailSection icon={Users} title={tr("Artistes et intervenants")}>
                      <div className="grid gap-3">
                        {detail.performers.slice(0, visiblePerformerCount).map((performer) => (
                          <article
                            key={performer.id}
                            className="flex items-start gap-3"
                            style={{ contentVisibility: "auto", containIntrinsicSize: "0 72px" }}
                          >
                            {performer.image_url && (
                              <EventArtworkImage
                                eventId={`performer:${performer.id}`}
                                sourceUrl={performer.image_url}
                                alt=""
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                className="h-12 w-12 rounded-full object-cover"
                              />
                            )}
                            <div>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <h4 className="font-black">{performer.name}</h4>
                                {performer.is_headliner && <Badge>{tr("Tête d’affiche")}</Badge>}
                              </div>
                              {performer.type && (
                                <p className="text-xs text-muted-foreground">{performer.type}</p>
                              )}
                              {performer.bio && (
                                <p className="mt-1 whitespace-pre-line text-muted-foreground">
                                  {detailPlainText(performer.bio)}
                                </p>
                              )}
                            </div>
                          </article>
                        ))}
                        {visiblePerformerCount < detail.performers.length && (
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            onClick={() =>
                              setVisiblePerformerCount((count) => count + DETAIL_LIST_BATCH_SIZE)
                            }
                          >
                            {tr("Voir plus")}
                          </Button>
                        )}
                      </div>
                    </MapDetailSection>
                  )}

                  {detail.media.length > 0 && (
                    <MapDetailSection icon={Video} title={tr("Médias")} className="md:col-span-2">
                      <div className="grid gap-3 sm:grid-cols-2">
                        {detail.media.slice(0, visibleMediaCount).map((media, index) => (
                          <article
                            key={media.id}
                            className="overflow-hidden rounded-xl border"
                            style={{ contentVisibility: "auto", containIntrinsicSize: "0 220px" }}
                          >
                            {media.media_type.toLowerCase().startsWith("image") ? (
                              <a href={media.url} target="_blank" rel="noopener noreferrer">
                                <EventArtworkImage
                                  eventId={`${artworkEventId}:media:${media.id}`}
                                  sourceUrl={media.url}
                                  alt={`${title} — ${media.attribution ?? index + 1}`}
                                  loading="lazy"
                                  referrerPolicy="no-referrer"
                                  className="aspect-video w-full object-cover"
                                />
                              </a>
                            ) : (
                              <a
                                href={media.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex min-h-24 items-center justify-center gap-2 p-3 font-black text-primary"
                              >
                                <Video className="h-5 w-5" /> {tr("Ouvrir le média")}
                              </a>
                            )}
                            {(media.attribution || media.license) && (
                              <p className="px-3 py-2 text-xs text-muted-foreground">
                                {[media.attribution, media.license].filter(Boolean).join(" · ")}
                              </p>
                            )}
                          </article>
                        ))}
                        {visibleMediaCount < detail.media.length && (
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 sm:col-span-2"
                            onClick={() =>
                              setVisibleMediaCount((count) => count + DETAIL_LIST_BATCH_SIZE)
                            }
                          >
                            {tr("Voir plus")}
                          </Button>
                        )}
                      </div>
                    </MapDetailSection>
                  )}

                  {(detail.official_url ||
                    sourceUrl ||
                    licenseUrl ||
                    scrapedText(detail, "source") ||
                    scrapedText(detail, "source_license")) && (
                    <MapDetailSection
                      icon={Globe2}
                      title={tr("Origine des informations")}
                      className="md:col-span-2"
                    >
                      <div className="grid gap-3">
                        {scrapedText(detail, "source") && (
                          <p>
                            <span className="font-black">{tr("Source")} : </span>
                            {scrapedText(detail, "source")}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-3 text-sm font-bold text-primary">
                          {detail.official_url && (
                            <a
                              href={detail.official_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              {tr("Site officiel")} <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                          {sourceUrl && (
                            <a
                              href={sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              {tr("Annonce d’origine")} <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                          {licenseUrl && (
                            <a
                              href={licenseUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              {tr("Licence")} <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </div>
                        {scrapedText(detail, "source_license") && (
                          <p className="text-xs text-muted-foreground">
                            <span className="font-black">{tr("Licence")} : </span>
                            {scrapedText(detail, "source_license")}
                          </p>
                        )}
                      </div>
                    </MapDetailSection>
                  )}
                </div>
              ) : (
                !loading &&
                !error && (
                  <p className="mt-6 text-sm text-muted-foreground">
                    {shortDescription || tr("Description à venir.")}
                  </p>
                )
              )}
            </div>
          </>
        ) : (
          <div className="grid min-h-64 place-items-center p-8 text-center">
            <div>
              <DialogTitle className="text-xl font-black">
                {tr("Événement sélectionné")}
              </DialogTitle>
              <DialogDescription
                role="status"
                aria-live="polite"
                aria-busy={loading}
                className="mt-2 text-sm"
              >
                {error ?? t("common.loading")}
              </DialogDescription>
              {loading && (
                <LoaderCircle className="mx-auto mt-6 h-8 w-8 animate-spin text-primary" />
              )}
              {error && !loading && (
                <Button type="button" className="mt-6 min-h-11" onClick={onRetry}>
                  {t("common.retry")}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SelectedClusterEvents({
  events,
  expectedCount,
  loading,
  loadingMore,
  hasMore,
  error,
  onClose,
  onRetry,
  onLoadMore,
  onSelect,
}: {
  events: MapOccurrencePreview[];
  expectedCount: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onSelect: (event: MapOccurrencePreview) => void;
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
          <button
            type="button"
            key={event.occurrence_id}
            onClick={() => onSelect(event)}
            className="min-h-11 w-full rounded-xl border bg-background px-3 py-2 text-left hover:border-primary"
            style={{ contentVisibility: "auto", containIntrinsicSize: "0 52px" }}
          >
            <span className="block truncate text-xs font-black">{event.title}</span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {formatMobileEventDate(event, localeTag)} ·{" "}
              {event.venue_name ?? event.city_name ?? tr("Lieu à confirmer")}
            </span>
          </button>
        ))}
      </div>
      {hasMore && !loading && !error && (
        <Button
          type="button"
          variant="outline"
          className="mt-3 min-h-11 w-full"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? t("common.loading") : tr("Afficher plus de sorties")}
        </Button>
      )}
    </aside>
  );
}

function mapPreviewFromDiscoveredEvent(event: DiscoveredEvent): MapOccurrencePreview {
  return {
    occurrence_id: event.occurrence_id,
    event_id: event.event_id,
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

function MapFallbackEventLink({ event: sourceEvent }: { event: DiscoveredEvent }) {
  const { tr, locale } = useTranslation();
  const translation = useEventContentTranslation(sourceEvent.event_id, locale, "summary");
  const event = translation
    ? {
        ...sourceEvent,
        title: translation.title,
        venue_name: translation.content.venue?.name ?? sourceEvent.venue_name,
      }
    : sourceEvent;
  return (
    <Link
      to="/event/$slug"
      params={{ slug: event.slug }}
      className="rounded-xl border px-3 py-2 text-xs hover:border-primary hover:bg-accent"
    >
      <span className="block truncate font-semibold">{event.title}</span>
      <span className="block truncate text-muted-foreground">
        {event.venue_name ?? event.city_name ?? tr("Lieu à confirmer")}
      </span>
    </Link>
  );
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

function mapClusterPointCount(value: unknown): number {
  const pointCount = Number(value);
  return Number.isFinite(pointCount) ? Math.max(1, Math.floor(pointCount)) : 1;
}

function createClusterHoverContent(labels: {
  groupedEvents: string;
  eventCount: string;
}): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "map-cluster-hover-card";

  const title = document.createElement("strong");
  title.textContent = labels.groupedEvents;
  container.append(title);

  const count = document.createElement("small");
  count.textContent = labels.eventCount;
  container.append(count);
  return container;
}

function MapPage() {
  const { t, tr, formatNumber, locale } = useTranslation();
  const [mapContainer, setMapContainer] = useState<HTMLDivElement | null>(null);
  const [mapLayoutRevision, setMapLayoutRevision] = useState(0);
  const containerRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setMapContainer(node);
  }, []);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userLocationRef = useRef<{ latitude: number; longitude: number; accuracy: number } | null>(
    null,
  );
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const lastMapCameraRef = useRef<{ center: [number, number]; zoom: number } | null>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const isMobileRef = useRef(isMobile);
  const [geolocationStatus, setGeolocationStatus] = useState<GeolocationStatus>("requesting");
  const [locationRequestKey, setLocationRequestKey] = useState(0);
  const [userLocation, setUserLocation] = useState<{
    latitude: number;
    longitude: number;
    accuracy: number;
  } | null>(null);
  const [viewportBounds, setViewportBounds] = useState<MapViewportBounds | null>(null);
  const [viewportZoom, setViewportZoom] = useState(INITIAL_GEOLOCATION_ZOOM);
  const [range, setRange] = useState<QuickRange>("year");
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [advancedFilters, setAdvancedFilters] = useState({ ...DEFAULT_ADVANCED_FILTERS });
  const [events, setEvents] = useState<DiscoveredEvent[]>([]);
  const [compactPinBatch, setCompactPinBatch] = useState<CompactMapPinBatch>(EMPTY_MAP_PIN_BATCH);
  const compactPins = compactPinBatch.pins;
  const [listRequested, setListRequested] = useState(false);
  const [mobileListLoading, setMobileListLoading] = useState(false);
  const [mobileListLoadingMore, setMobileListLoadingMore] = useState(false);
  const [mobileListHasMore, setMobileListHasMore] = useState(false);
  const [mobileListError, setMobileListError] = useState<string | null>(null);
  const [mobileListReloadKey, setMobileListReloadKey] = useState(0);
  const [showEvents, setShowEvents] = useState(true);
  const [selectedMapEvent, setSelectedMapEvent] = useState<MapOccurrencePreview | null>(null);
  const [selectedMapEventDetail, setSelectedMapEventDetail] = useState<MapOccurrenceDetail | null>(
    null,
  );
  const [eventSelectionOpen, setEventSelectionOpen] = useState(false);
  const [eventSelectionLoading, setEventSelectionLoading] = useState(false);
  const [eventSelectionError, setEventSelectionError] = useState<string | null>(null);
  const [selectedClusterEvents, setSelectedClusterEvents] = useState<MapOccurrencePreview[]>([]);
  const [clusterSelectionOpen, setClusterSelectionOpen] = useState(false);
  const [clusterSelectionLoading, setClusterSelectionLoading] = useState(false);
  const [clusterSelectionLoadingMore, setClusterSelectionLoadingMore] = useState(false);
  const [clusterSelectionHasMore, setClusterSelectionHasMore] = useState(false);
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
  const pinLoadingRef = useRef(true);
  const terminalClusterReloadPendingRef = useRef(false);
  const retryMapPinsWhenOnlineRef = useRef(false);
  const mobileListRequestVersionRef = useRef(0);
  const eventSelectionRequestRef = useRef(0);
  const eventSelectionRetryRef = useRef<(() => void) | null>(null);
  const clusterSelectionRequestRef = useRef(0);
  const clusterSelectionRetryRef = useRef<(() => void) | null>(null);
  const clusterSelectionLoadMoreRef = useRef<(() => void) | null>(null);
  const previewCacheRef = useRef(new Map<string, MapOccurrencePreview | null>());
  const previewInFlightRef = useRef(new Map<string, Promise<MapOccurrencePreview | null>>());
  const eventDetailCacheRef = useRef(new Map<string, MapEventDetailCacheEntry>());
  const eventDetailInFlightRef = useRef(new Map<string, Promise<MapOccurrenceDetail | null>>());
  const eventDetailAbortRef = useRef(new Map<string, AbortController>());
  const selectedOccurrenceIdRef = useRef<string | null>(null);
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null);
  const hoverRequestRef = useRef(0);
  const mapReady = mapInstance !== null && readyMap === mapInstance;
  const { from, to } = useMemo(() => computeRange(range), [range]);
  const advancedCount = countAdvancedFilters(advancedFilters);
  const eventMapPoints = useMemo(
    () =>
      spreadCoincidentMapPoints(
        buildCompactMapPointCollection({ pins: compactPins, showEvents }),
        compactPinBatch.clustered ? 0 : viewportZoom,
        EVENT_CLUSTER_TERMINAL_ZOOM,
      ),
    [compactPinBatch.clustered, compactPins, showEvents, viewportZoom],
  );
  const eventsByOccurrenceId = useMemo(
    () => new Map(events.map((event) => [event.occurrence_id, event])),
    [events],
  );
  const localizePreviews = useCallback(
    async (previews: MapOccurrencePreview[]): Promise<MapOccurrencePreview[]> => {
      if (!previews.length) return previews;
      const translations = await getEventContentTranslations(
        previews.map((preview) => preview.event_id),
        locale,
        "summary",
      );
      return previews.map((preview) =>
        applyTranslationToMapPreview(preview, translations.get(preview.event_id)),
      );
    },
    [locale],
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
            previewCacheRef.current.set(occurrenceId, preview);
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

      const previews = uniqueIds.flatMap((occurrenceId) => {
        const preview = previewCacheRef.current.get(occurrenceId);
        return preview ? [preview] : [];
      });
      return previews;
    },
    [eventsByOccurrenceId, resolvePreviewBatch],
  );
  const abortEventDetail = useCallback((occurrenceId: string | null) => {
    if (!occurrenceId) return;
    eventDetailAbortRef.current
      .get(occurrenceId)
      ?.abort(new DOMException("Map event selection changed", "AbortError"));
    eventDetailAbortRef.current.delete(occurrenceId);
    eventDetailInFlightRef.current.delete(occurrenceId);
  }, []);
  const resolveEventDetail = useCallback(
    async (occurrenceId: string): Promise<MapOccurrenceDetail | null> => {
      const cached = readMapEventDetailCache(eventDetailCacheRef.current, occurrenceId);
      if (cached) return cached;

      const activeRequest = eventDetailInFlightRef.current.get(occurrenceId);
      if (activeRequest) return activeRequest;

      const controller = new AbortController();
      eventDetailAbortRef.current.set(occurrenceId, controller);
      const request = fetchMapOccurrenceDetail(occurrenceId, controller.signal);
      eventDetailInFlightRef.current.set(occurrenceId, request);
      void request.then(
        (detail) => {
          if (detail) writeMapEventDetailCache(eventDetailCacheRef.current, occurrenceId, detail);
          if (eventDetailInFlightRef.current.get(occurrenceId) === request) {
            eventDetailInFlightRef.current.delete(occurrenceId);
          }
          if (eventDetailAbortRef.current.get(occurrenceId) === controller) {
            eventDetailAbortRef.current.delete(occurrenceId);
          }
        },
        () => {
          if (eventDetailInFlightRef.current.get(occurrenceId) === request) {
            eventDetailInFlightRef.current.delete(occurrenceId);
          }
          if (eventDetailAbortRef.current.get(occurrenceId) === controller) {
            eventDetailAbortRef.current.delete(occurrenceId);
          }
        },
      );
      return request;
    },
    [],
  );
  const mobileListEvents = useMemo(
    () => events.slice(0, visibleMobileEventCount),
    [events, visibleMobileEventCount],
  );
  const requestMapResize = useCallback(() => mapRef.current?.resize(), []);
  const closeClusterSelection = useCallback(() => {
    clusterSelectionRequestRef.current += 1;
    clusterSelectionRetryRef.current = null;
    clusterSelectionLoadMoreRef.current = null;
    setClusterSelectionOpen(false);
    setClusterSelectionLoading(false);
    setClusterSelectionLoadingMore(false);
    setClusterSelectionHasMore(false);
    setClusterSelectionError(null);
    setClusterSelectionExpectedCount(0);
    setSelectedClusterEvents([]);
  }, []);
  const closeEventSelection = useCallback(() => {
    eventSelectionRequestRef.current += 1;
    eventSelectionRetryRef.current = null;
    abortEventDetail(selectedOccurrenceIdRef.current);
    selectedOccurrenceIdRef.current = null;
    setEventSelectionOpen(false);
    setEventSelectionLoading(false);
    setEventSelectionError(null);
    setSelectedMapEvent(null);
    setSelectedMapEventDetail(null);
  }, [abortEventDetail]);
  const openEventSelection = useCallback(
    function openSelectedMapEvent(
      occurrenceId: string,
      initialPreview: MapOccurrencePreview | null = null,
      preserveClusterSelection = false,
    ) {
      if (!occurrenceId) return;

      if (selectedOccurrenceIdRef.current !== occurrenceId) {
        abortEventDetail(selectedOccurrenceIdRef.current);
      }
      selectedOccurrenceIdRef.current = occurrenceId;
      const requestVersion = ++eventSelectionRequestRef.current;
      const localEvent = eventsByOccurrenceId.get(occurrenceId);
      const immediatePreview =
        initialPreview ??
        (localEvent ? mapPreviewFromDiscoveredEvent(localEvent) : null) ??
        previewCacheRef.current.get(occurrenceId) ??
        null;
      const cachedDetail = readMapEventDetailCache(eventDetailCacheRef.current, occurrenceId);

      if (!preserveClusterSelection) closeClusterSelection();
      eventSelectionRetryRef.current = () => {
        openSelectedMapEvent(occurrenceId, initialPreview, preserveClusterSelection);
      };
      setEventSelectionOpen(true);
      setSelectedMapEvent(immediatePreview);
      setSelectedMapEventDetail(cachedDetail);
      setEventSelectionError(null);
      setEventSelectionLoading(!cachedDetail);

      if (cachedDetail) return;

      void resolveMapEventPinSelection(
        occurrenceId,
        resolveEventDetail,
        () => requestVersion === eventSelectionRequestRef.current,
      ).then((result) => {
        if (result.status === "stale") return;
        setEventSelectionLoading(false);
        if (result.status === "ready") {
          setSelectedMapEventDetail(result.selection);
          return;
        }
        setEventSelectionError(tr("Détails momentanément indisponibles"));
      });
    },
    [abortEventDetail, closeClusterSelection, eventsByOccurrenceId, resolveEventDetail, tr],
  );

  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  useEffect(
    () => () => {
      for (const controller of eventDetailAbortRef.current.values()) {
        controller.abort(new DOMException("Map closed", "AbortError"));
      }
      eventDetailAbortRef.current.clear();
      eventDetailInFlightRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    let active = true;
    let hasPosition = false;
    let watchId: number | null = null;
    if (!window.isSecureContext || !navigator.geolocation) {
      setGeolocationStatus("unavailable");
      return;
    }

    setGeolocationStatus("requesting");
    const acceptPosition = (position: GeolocationPosition) => {
      if (!active) return;
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        if (!hasPosition) setGeolocationStatus("error");
        return;
      }
      hasPosition = true;
      const nextLocation = {
        latitude,
        longitude,
        accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : 0,
      };
      userLocationRef.current = nextLocation;
      setUserLocation(nextLocation);
      setGeolocationStatus("ready");
    };
    const handleInitialError = (locationError: GeolocationPositionError) => {
      if (!active || hasPosition) return;
      setGeolocationStatus(
        locationError.code === locationError.PERMISSION_DENIED ? "denied" : "error",
      );
    };

    navigator.geolocation.getCurrentPosition(
      (position) => {
        acceptPosition(position);
        if (!active) return;
        watchId = navigator.geolocation.watchPosition(
          acceptPosition,
          () => undefined,
          MAP_REFINEMENT_GEOLOCATION_OPTIONS,
        );
      },
      handleInitialError,
      MAP_INITIAL_GEOLOCATION_OPTIONS,
    );

    return () => {
      active = false;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
    };
  }, [locationRequestKey]);

  useEffect(() => {
    const activeMapContainer = mapContainer;
    const initialLocation = userLocationRef.current;
    if (
      !activeMapContainer ||
      mapRef.current ||
      geolocationStatus !== "ready" ||
      !initialLocation
    ) {
      return;
    }

    if (!isRenderableMapSurfaceSize(readMapSurfaceSize(activeMapContainer))) {
      let layoutFrame = 0;
      const waitForLayout = () => {
        if (isRenderableMapSurfaceSize(readMapSurfaceSize(activeMapContainer))) {
          setMapLayoutRevision((revision) => revision + 1);
          return;
        }
        layoutFrame = window.requestAnimationFrame(waitForLayout);
      };
      layoutFrame = window.requestAnimationFrame(waitForLayout);
      return () => window.cancelAnimationFrame(layoutFrame);
    }

    // MapLibre must follow the exact DOM node reported by the callback ref.
    // Hydration and responsive layout changes replace that node entirely.
    activeMapContainer.dataset.mapLayout = activeMapContainer.closest(".mobile-discovery-shell")
      ? "mobile"
      : "desktop";
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
    const initialCamera = lastMapCameraRef.current ?? {
      center: [initialLocation.longitude, initialLocation.latitude] as [number, number],
      zoom: INITIAL_GEOLOCATION_ZOOM,
    };
    try {
      map = new maplibregl.Map({
        container: activeMapContainer,
        style: PRIMARY_MAP_STYLE,
        center: initialCamera.center,
        zoom: initialCamera.zoom,
        clickTolerance: 8,
        fadeDuration: 0,
      });
    } catch {
      setMapUnavailable("La carte interactive ne peut pas démarrer dans ce navigateur.");
      return;
    }
    let primaryStyleLoaded = false;
    let rasterFallbackApplied = false;
    let primaryStyleErrorCount = 0;
    const markMapReady = () => {
      setReadyMap(map);
    };
    const applyRasterFallback = () => {
      if (primaryStyleLoaded || rasterFallbackApplied) return;
      rasterFallbackApplied = true;
      map.setStyle(RASTER_FALLBACK_STYLE);
    };
    const fallbackTimer = window.setTimeout(applyRasterFallback, MAP_PRIMARY_STYLE_TIMEOUT_MS);
    const handleMapError = () => {
      if (primaryStyleLoaded || rasterFallbackApplied) return;
      primaryStyleErrorCount += 1;
      if (primaryStyleErrorCount >= 3) applyRasterFallback();
    };
    // Prefer the vector style on every device. The former mobile-only public
    // raster path could leave a fully interactive but blank grey canvas when
    // that tile host was throttled. Raster remains a bounded fallback only.
    const revealTimer = window.setTimeout(() => {
      map.resize();
      setReadyMap(map);
    }, MAP_REVEAL_TIMEOUT_MS);
    map.once("render", markMapReady);
    map.on("load", markMapReady);
    map.on("error", handleMapError);
    map.on("style.load", () => {
      if (!rasterFallbackApplied) primaryStyleLoaded = true;
      if (primaryStyleLoaded) window.clearTimeout(fallbackTimer);
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
        secondResizeFrame = window.requestAnimationFrame(() => {
          const containerSize = readMapSurfaceSize(activeMapContainer);
          if (!isRenderableMapSurfaceSize(containerSize)) return;

          map.resize();
          map.triggerRepaint();

          const canvas = map.getCanvas();
          const canvasSize = readMapSurfaceSize(canvas);
          if (!mapSurfaceSizesMatch(containerSize, canvasSize)) {
            canvas.style.width = `${containerSize.width}px`;
            canvas.style.height = `${containerSize.height}px`;
            map.resize();
            map.triggerRepaint();
          }
        });
      });
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeMap);
    resizeObserver?.observe(activeMapContainer);
    if (activeMapContainer.parentElement) {
      resizeObserver?.observe(activeMapContainer.parentElement);
    }
    window.visualViewport?.addEventListener("resize", resizeMap);
    window.addEventListener("resize", resizeMap);
    window.addEventListener("orientationchange", resizeMap);
    window.addEventListener(BRAND_ARRIVAL_COMPLETE_EVENT, resizeMap);
    const settlingResizeTimers = [120, 360, 1_000, 2_600].map((delay) =>
      window.setTimeout(resizeMap, delay),
    );
    resizeMap();

    return () => {
      const center = map.getCenter();
      lastMapCameraRef.current = { center: [center.lng, center.lat], zoom: map.getZoom() };
      map.off("error", handleMapError);
      window.clearTimeout(fallbackTimer);
      window.clearTimeout(revealTimer);
      window.cancelAnimationFrame(firstResizeFrame);
      window.cancelAnimationFrame(secondResizeFrame);
      settlingResizeTimers.forEach((timer) => window.clearTimeout(timer));
      resizeObserver?.disconnect();
      window.visualViewport?.removeEventListener("resize", resizeMap);
      window.removeEventListener("resize", resizeMap);
      window.removeEventListener("orientationchange", resizeMap);
      window.removeEventListener(BRAND_ARRIVAL_COMPLETE_EVENT, resizeMap);
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      map.remove();
      if (mapRef.current === map) {
        mapRef.current = null;
        setMapInstance((current) => (current === map ? null : current));
        setReadyMap((current) => (current === map ? null : current));
        setReadyStyle((current) => (current?.map === map ? null : current));
      }
    };
  }, [geolocationStatus, mapContainer, mapLayoutRevision]);

  useEffect(() => {
    const map = mapInstance;
    if (!map || !userLocation) return;
    if (!userMarkerRef.current) {
      const markerElement = document.createElement("div");
      markerElement.className = "map-user-location-marker";
      markerElement.setAttribute("role", "img");
      markerElement.setAttribute("aria-label", tr("Ma position"));
      userMarkerRef.current = new maplibregl.Marker({ element: markerElement })
        .setLngLat([userLocation.longitude, userLocation.latitude])
        .addTo(map);
    } else {
      userMarkerRef.current.setLngLat([userLocation.longitude, userLocation.latitude]);
    }
  }, [mapInstance, tr, userLocation]);

  useEffect(() => {
    const map = mapInstance;
    if (!map || !mapReady) return;
    let refreshTimer: number | null = null;

    const captureViewport = () => {
      const rawBounds = map.getBounds();
      const nextBounds = normalizeMapViewportBounds({
        west: rawBounds.getWest(),
        south: rawBounds.getSouth(),
        east: rawBounds.getEast(),
        north: rawBounds.getNorth(),
      });
      if (!nextBounds) return;
      const center = map.getCenter();
      const nextZoom = Math.min(22, Math.max(0, Number(map.getZoom().toFixed(2))));
      lastMapCameraRef.current = { center: [center.lng, center.lat], zoom: nextZoom };
      setViewportZoom((current) =>
        Math.floor(current) === Math.floor(nextZoom) ? current : nextZoom,
      );
      setViewportBounds((current) =>
        current && mapViewportBoundsKey(current) === mapViewportBoundsKey(nextBounds)
          ? current
          : nextBounds,
      );
    };
    const scheduleViewportCapture = () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(captureViewport, MAP_VIEWPORT_REFRESH_DELAY_MS);
    };

    captureViewport();
    // `zoomend` is always followed by `moveend`; listening to both creates
    // duplicate timers and duplicate viewport requests on every pinch gesture.
    map.on("moveend", scheduleViewportCapture);
    map.on("resize", scheduleViewportCapture);
    return () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      map.off("moveend", scheduleViewportCapture);
      map.off("resize", scheduleViewportCapture);
    };
  }, [mapInstance, mapReady]);

  const taxonomyFilters = useMemo(
    () =>
      resolveSearchTaxonomyFilters(cats, {
        genres: advancedFilters.genres,
        subcategories: advancedFilters.subcategories,
      }),
    [advancedFilters.genres, advancedFilters.subcategories, cats],
  );
  const advancedDiscoveryFilters = useMemo(
    () => toDiscoveryFilters(advancedFilters, taxonomyFilters.filterValues ?? []),
    [advancedFilters, taxonomyFilters.filterValues],
  );
  const selectedCategorySlugs = taxonomyFilters.eventCategorySlugs;
  const mapPinCacheKey = useMemo(
    () =>
      JSON.stringify({
        range,
        zoom: Math.floor(viewportZoom),
        categorySlugs: selectedCategorySlugs,
        query: deferredQuery,
        advanced: advancedDiscoveryFilters,
      }),
    [advancedDiscoveryFilters, deferredQuery, range, selectedCategorySlugs, viewportZoom],
  );
  const mapDiscoveryParams = useMemo(
    () =>
      viewportBounds
        ? {
            bounds: viewportBounds,
            zoom: viewportZoom,
            categorySlugs: selectedCategorySlugs,
            query: deferredQuery,
            from,
            to,
            ...advancedDiscoveryFilters,
          }
        : null,
    [
      advancedDiscoveryFilters,
      deferredQuery,
      from,
      selectedCategorySlugs,
      to,
      viewportBounds,
      viewportZoom,
    ],
  );

  const mapStats = useMemo(
    () => ({
      total_count: compactPinBatch.totalCount,
      free_count: compactPinBatch.freeCount,
    }),
    [compactPinBatch.freeCount, compactPinBatch.totalCount],
  );
  const totalEventCount = mapStats.total_count;
  const loadedPointCount = compactPins.length;
  const statsLoading = loading;

  const requestMapPinReload = useCallback(() => {
    if (
      !shouldRequestTerminalClusterReload(
        pinLoadingRef.current,
        terminalClusterReloadPendingRef.current,
      )
    ) {
      return false;
    }
    terminalClusterReloadPendingRef.current = true;
    retryMapPinsWhenOnlineRef.current = false;
    pinLoadingRef.current = true;
    clearSessionMapPinCache(mapPinCacheKey);
    setLoading(true);
    setError(null);
    setReloadKey((key) => key + 1);
    return true;
  }, [mapPinCacheKey]);

  useEffect(() => {
    if (!mapDiscoveryParams) return;
    const cachedPins = readSessionMapPins(mapPinCacheKey, mapDiscoveryParams.bounds);
    if (cachedPins !== null) {
      setCompactPinBatch(cachedPins);
      pinLoadingRef.current = false;
      terminalClusterReloadPendingRef.current = false;
      retryMapPinsWhenOnlineRef.current = false;
      setLoading(false);
      setError(null);
      return;
    }

    let current = true;
    const controller = new AbortController();
    const requestVersion = ++requestVersionRef.current;
    pinLoadingRef.current = true;
    setLoading(true);
    setError(null);

    void loadSessionMapPins({
      cacheKey: mapPinCacheKey,
      viewport: mapDiscoveryParams.bounds,
      zoom: mapDiscoveryParams.zoom,
      signal: controller.signal,
      fetchPins: (bounds, signal) =>
        discoverMapPinsInBounds({ ...mapDiscoveryParams, bounds }, signal),
    })
      .then((nextPins) => {
        if (!current || requestVersion !== requestVersionRef.current) return;
        setCompactPinBatch(nextPins);
        terminalClusterReloadPendingRef.current = false;
        retryMapPinsWhenOnlineRef.current = false;
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        if (!current || requestVersion !== requestVersionRef.current) return;
        terminalClusterReloadPendingRef.current = false;
        retryMapPinsWhenOnlineRef.current = isTransientMapRequestError(requestError);
        setError("Impossible d’actualiser les événements de la zone visible. Réessaie.");
      })
      .finally(() => {
        if (current && requestVersion === requestVersionRef.current) {
          pinLoadingRef.current = false;
          setLoading(false);
        }
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [mapDiscoveryParams, mapPinCacheKey, reloadKey]);

  useEffect(() => {
    const retryWhenOnline = () => {
      if (!retryMapPinsWhenOnlineRef.current) return;
      void requestMapPinReload();
    };
    window.addEventListener("online", retryWhenOnline);
    return () => window.removeEventListener("online", retryWhenOnline);
  }, [requestMapPinReload]);

  useEffect(() => {
    if (!mapDiscoveryParams || !listRequested) return;

    let current = true;
    const controller = new AbortController();
    const requestVersion = ++mobileListRequestVersionRef.current;
    setMobileListLoading(true);
    setMobileListLoadingMore(false);
    setMobileListError(null);

    void discoverMapEventsInBounds(
      {
        ...mapDiscoveryParams,
        limit: MAP_EVENT_PAGE_SIZE,
        offset: 0,
      },
      controller.signal,
    )
      .then((nextEvents) => {
        if (!current || requestVersion !== mobileListRequestVersionRef.current) return;
        setEvents(nextEvents);
        setMobileListHasMore(nextEvents.length === MAP_EVENT_PAGE_SIZE);
        setVisibleMobileEventCount(MOBILE_LIST_BATCH_SIZE);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if (!current || requestVersion !== mobileListRequestVersionRef.current) return;
        setMobileListError("Impossible de charger la liste. Réessaie dans un instant.");
      })
      .finally(() => {
        if (current && requestVersion === mobileListRequestVersionRef.current) {
          setMobileListLoading(false);
        }
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [listRequested, mapDiscoveryParams, mobileListReloadKey]);

  const loadMoreMobileList = () => {
    if (visibleMobileEventCount < events.length) {
      setVisibleMobileEventCount((count) => count + MOBILE_LIST_BATCH_SIZE);
      return;
    }
    if (!mapDiscoveryParams || !mobileListHasMore || mobileListLoading || mobileListLoadingMore) {
      return;
    }

    const requestVersion = mobileListRequestVersionRef.current;
    setMobileListLoadingMore(true);
    setMobileListError(null);
    void discoverMapEventsInBounds({
      ...mapDiscoveryParams,
      limit: MAP_EVENT_PAGE_SIZE,
      offset: events.length,
    })
      .then((nextEvents) => {
        if (requestVersion !== mobileListRequestVersionRef.current) return;
        const knownIds = new Set(events.map((event) => event.occurrence_id));
        const additions = nextEvents.filter((event) => !knownIds.has(event.occurrence_id));
        setEvents((current) => [...current, ...additions]);
        setMobileListHasMore(nextEvents.length === MAP_EVENT_PAGE_SIZE && additions.length > 0);
        setVisibleMobileEventCount((count) => count + MOBILE_LIST_BATCH_SIZE);
      })
      .catch(() => {
        if (requestVersion !== mobileListRequestVersionRef.current) return;
        setMobileListError("Impossible de charger la suite de la liste. Réessaie.");
      })
      .finally(() => {
        if (requestVersion === mobileListRequestVersionRef.current) {
          setMobileListLoadingMore(false);
        }
      });
  };

  useEffect(() => {
    const map = mapInstance;
    if (!map || !mapReady || readyStyle?.map !== map) return;

    let frame = 0;
    const applySourceUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!map.getCanvas().isConnected || !map.isStyleLoaded()) return;
        syncClusterLayers(map, eventMapPoints, compactPinBatch.clustered);
      });
    };

    // Parsing a large GeoJSON payload or rebuilding a clustered source during
    // a touch gesture blocks MapLibre's render thread. Keep the previous pins
    // visible and apply the new batch only after camera movement has settled.
    if (map.isMoving() || map.isZooming() || map.isRotating()) {
      map.once("moveend", applySourceUpdate);
    } else {
      applySourceUpdate();
    }

    return () => {
      window.cancelAnimationFrame(frame);
      map.off("moveend", applySourceUpdate);
    };
  }, [compactPinBatch.clustered, eventMapPoints, mapInstance, mapReady, readyStyle]);

  useEffect(() => {
    const map = mapInstance;
    if (!map || !mapReady || readyStyle?.map !== map) return;

    const removeHoverPopup = () => {
      hoverRequestRef.current += 1;
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
    const loadClusterSelectionPage = async ({
      source,
      clusterId,
      pointCount,
      offset,
      requestVersion,
      sourceRevision,
      append,
    }: {
      source: GeoJSONSource;
      clusterId: number;
      pointCount: number;
      offset: number;
      requestVersion: number;
      sourceRevision: number;
      append: boolean;
    }) => {
      const page = clusterLeafPageRequest(pointCount, offset, CLUSTER_SELECTION_PAGE_SIZE);
      if (!page) {
        setClusterSelectionHasMore(false);
        clusterSelectionLoadMoreRef.current = null;
        return;
      }

      if (append) setClusterSelectionLoadingMore(true);
      else setClusterSelectionLoading(true);
      setClusterSelectionError(null);
      try {
        const leaves = await source.getClusterLeaves(clusterId, page.limit, page.offset);
        if (!isMapEventSourceInteractionReady(map, sourceRevision)) {
          if (requestVersion === clusterSelectionRequestRef.current) {
            closeClusterSelection();
          }
          return;
        }
        const occurrenceIds = leaves.flatMap((leaf) => {
          const occurrenceId = leaf.properties?.entity_id;
          return typeof occurrenceId === "string" ? [occurrenceId] : [];
        });
        const previews = await resolveOccurrencePreviews(occurrenceIds);
        if (requestVersion !== clusterSelectionRequestRef.current) return;
        if (!isMapEventSourceInteractionReady(map, sourceRevision)) {
          closeClusterSelection();
          return;
        }

        setSelectedClusterEvents((current) => {
          const merged = append ? [...current, ...previews] : previews;
          return [...new Map(merged.map((preview) => [preview.occurrence_id, preview])).values()];
        });
        const nextOffset = page.offset + leaves.length;
        const hasMore = leaves.length > 0 && nextOffset < pointCount;
        setClusterSelectionHasMore(hasMore);
        clusterSelectionLoadMoreRef.current = hasMore
          ? () => {
              void loadClusterSelectionPage({
                source,
                clusterId,
                pointCount,
                offset: nextOffset,
                requestVersion,
                sourceRevision,
                append: true,
              });
            }
          : null;
        clusterSelectionRetryRef.current = null;

        void localizePreviews(previews).then((localizedPreviews) => {
          if (requestVersion !== clusterSelectionRequestRef.current) return;
          if (!isMapEventSourceInteractionReady(map, sourceRevision)) return;
          const localizedById = new Map(
            localizedPreviews.map((preview) => [preview.occurrence_id, preview]),
          );
          setSelectedClusterEvents((current) =>
            current.map((preview) => localizedById.get(preview.occurrence_id) ?? preview),
          );
        });
        if (!previews.length) {
          setClusterSelectionError(
            "Les événements de ce lieu n’ont pas pu être chargés. Réessaie dans un instant.",
          );
        }
      } catch {
        if (requestVersion !== clusterSelectionRequestRef.current) return;
        if (!isMapEventSourceInteractionReady(map, sourceRevision)) {
          closeClusterSelection();
          return;
        }
        clusterSelectionRetryRef.current = () => {
          if (!isMapEventSourceInteractionReady(map, sourceRevision)) {
            closeClusterSelection();
            return;
          }
          void loadClusterSelectionPage({
            source,
            clusterId,
            pointCount,
            offset: page.offset,
            requestVersion,
            sourceRevision,
            append,
          });
        };
        setClusterSelectionError(
          "Impossible de charger les événements regroupés. Vérifie ta connexion puis réessaie.",
        );
      } finally {
        if (requestVersion === clusterSelectionRequestRef.current) {
          if (append) setClusterSelectionLoadingMore(false);
          else setClusterSelectionLoading(false);
        }
      }
    };
    const loadClusterSelection = async (
      source: GeoJSONSource,
      clusterId: number,
      pointCount: number,
      sourceRevision = MAP_EVENT_SOURCE_REVISION.get(map) ?? 0,
    ) => {
      if (!isMapEventSourceInteractionReady(map, sourceRevision)) return;
      const requestVersion = ++clusterSelectionRequestRef.current;
      clusterSelectionRetryRef.current = () => {
        if (!isMapEventSourceInteractionReady(map, sourceRevision)) {
          closeClusterSelection();
          return;
        }
        void loadClusterSelection(source, clusterId, pointCount);
      };
      clusterSelectionLoadMoreRef.current = null;
      closeEventSelection();
      setClusterSelectionOpen(true);
      setClusterSelectionLoading(true);
      setClusterSelectionLoadingMore(false);
      setClusterSelectionHasMore(pointCount > CLUSTER_SELECTION_PAGE_SIZE);
      setClusterSelectionError(null);
      setClusterSelectionExpectedCount(pointCount);
      setSelectedClusterEvents([]);
      await loadClusterSelectionPage({
        source,
        clusterId,
        pointCount,
        offset: 0,
        requestVersion,
        sourceRevision,
        append: false,
      });
    };
    const expandCluster = async (feature: MapGeoJSONFeature) => {
      if (!feature || feature.geometry.type !== "Point") return;
      const sourceRevision = MAP_EVENT_SOURCE_REVISION.get(map) ?? 0;
      if (!isMapEventSourceInteractionReady(map, sourceRevision)) return;
      const clusterId = Number(feature.properties?.cluster_id);
      const [longitude, latitude] = feature.geometry.coordinates;
      const pointCount = mapClusterPointCount(
        feature.properties?.point_count ?? feature.properties?.event_count,
      );
      const coincidentOccurrenceIds = coincidentMapPointOccurrenceIds(
        feature.properties as Partial<MapPointProperties> | undefined,
      );

      closeEventSelection();
      if (coincidentOccurrenceIds.length) {
        void loadCoincidentSelection(coincidentOccurrenceIds);
        return;
      }
      if (!Number.isFinite(clusterId)) {
        closeClusterSelection();
        const currentZoom = map.getZoom();
        if (currentZoom >= MAP_SERVER_CLUSTER_MAX_ZOOM) {
          void requestMapPinReload();
          return;
        }
        map.easeTo({
          center: [Number(longitude), Number(latitude)],
          zoom: serverClusterExpansionTargetZoom(currentZoom, MAP_SERVER_CLUSTER_MAX_ZOOM),
          duration: 450,
        });
        return;
      }

      const source = map.getSource(MAP_EVENT_SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;
      if (map.getZoom() >= EVENT_CLUSTER_TERMINAL_ZOOM) {
        void loadClusterSelection(source, clusterId, pointCount, sourceRevision);
        return;
      }

      try {
        const expansionZoom = await source.getClusterExpansionZoom(clusterId);
        if (!isMapEventSourceInteractionReady(map, sourceRevision)) return;
        if (shouldOpenClusterSelection(map.getZoom(), expansionZoom)) {
          void loadClusterSelection(source, clusterId, pointCount, sourceRevision);
          return;
        }
        closeClusterSelection();
        map.easeTo({
          center: [Number(longitude), Number(latitude)],
          zoom: clusterExpansionTargetZoom(map.getZoom(), expansionZoom),
          duration: 450,
        });
      } catch {
        if (!isMapEventSourceInteractionReady(map, sourceRevision)) return;
        setError("Impossible d’ouvrir ce groupe de points. Réessaie dans un instant.");
      }
    };
    const openPoint = (feature: MapGeoJSONFeature) => {
      const properties = feature.properties as Partial<MapPointProperties> | undefined;
      const entityId = mapEventPinOccurrenceId(properties);
      if (!entityId) return;

      const selected = eventsByOccurrenceId.get(entityId);
      openEventSelection(entityId, selected ? mapPreviewFromDiscoveredEvent(selected) : null);
      void trackClientEvent("map_pin_click", {
        entityType: "event_occurrence",
        entityId,
        metadata: {
          precision: selected?.location_precision ?? (properties?.approximate ? "city" : "exact"),
        },
      });
    };
    const handlePointMouseEnter = (event: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      if (!event.features?.length) return;
    };
    const handleClusterMouseEnter = (event: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      if (isMobileRef.current) return;
      const sourceRevision = MAP_EVENT_SOURCE_REVISION.get(map) ?? 0;
      if (!isMapEventSourceInteractionReady(map, sourceRevision)) return;
      const feature = event.features?.[0];
      if (!feature || feature.geometry.type !== "Point") return;
      const pointCount = mapClusterPointCount(feature.properties?.event_count);
      const [longitude, latitude] = feature.geometry.coordinates;
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        return;
      }
      showHoverPopup(
        [Number(longitude), Number(latitude)],
        createClusterHoverContent({
          groupedEvents: tr("Événements regroupés"),
          eventCount: tr("{count} sorties", { count: formatNumber(pointCount) }),
        }),
      );
    };
    const loadCoincidentSelectionPage = async ({
      occurrenceIds,
      offset,
      requestVersion,
      append,
    }: {
      occurrenceIds: string[];
      offset: number;
      requestVersion: number;
      append: boolean;
    }) => {
      const page = clusterLeafPageRequest(
        occurrenceIds.length,
        offset,
        CLUSTER_SELECTION_PAGE_SIZE,
      );
      if (!page) {
        setClusterSelectionHasMore(false);
        clusterSelectionLoadMoreRef.current = null;
        return;
      }

      if (append) setClusterSelectionLoadingMore(true);
      else setClusterSelectionLoading(true);
      setClusterSelectionError(null);
      const pageIds = occurrenceIds.slice(page.offset, page.offset + page.limit);
      try {
        const previews = await resolveOccurrencePreviews(pageIds);
        if (requestVersion !== clusterSelectionRequestRef.current) return;

        setSelectedClusterEvents((current) => {
          const merged = append ? [...current, ...previews] : previews;
          return [...new Map(merged.map((preview) => [preview.occurrence_id, preview])).values()];
        });
        const nextOffset = page.offset + pageIds.length;
        const hasMore = nextOffset < occurrenceIds.length;
        setClusterSelectionHasMore(hasMore);
        clusterSelectionLoadMoreRef.current = hasMore
          ? () => {
              void loadCoincidentSelectionPage({
                occurrenceIds,
                offset: nextOffset,
                requestVersion,
                append: true,
              });
            }
          : null;
        clusterSelectionRetryRef.current = null;

        void localizePreviews(previews).then((localizedPreviews) => {
          if (requestVersion !== clusterSelectionRequestRef.current) return;
          const localizedById = new Map(
            localizedPreviews.map((preview) => [preview.occurrence_id, preview]),
          );
          setSelectedClusterEvents((current) =>
            current.map((preview) => localizedById.get(preview.occurrence_id) ?? preview),
          );
        });
        if (!previews.length) {
          setClusterSelectionError(
            "Les événements de ce lieu n’ont pas pu être chargés. Réessaie dans un instant.",
          );
        }
      } catch {
        if (requestVersion !== clusterSelectionRequestRef.current) return;
        clusterSelectionRetryRef.current = () => {
          void loadCoincidentSelectionPage({
            occurrenceIds,
            offset: page.offset,
            requestVersion,
            append,
          });
        };
        setClusterSelectionError(
          "Impossible de charger les événements regroupés. Vérifie ta connexion puis réessaie.",
        );
      } finally {
        if (requestVersion === clusterSelectionRequestRef.current) {
          if (append) setClusterSelectionLoadingMore(false);
          else setClusterSelectionLoading(false);
        }
      }
    };
    const loadCoincidentSelection = async (rawOccurrenceIds: string[]) => {
      const occurrenceIds = [...new Set(rawOccurrenceIds)];
      if (!occurrenceIds.length) return;
      const requestVersion = ++clusterSelectionRequestRef.current;
      clusterSelectionRetryRef.current = () => {
        void loadCoincidentSelection(occurrenceIds);
      };
      clusterSelectionLoadMoreRef.current = null;
      closeEventSelection();
      setClusterSelectionOpen(true);
      setClusterSelectionLoading(true);
      setClusterSelectionLoadingMore(false);
      setClusterSelectionHasMore(occurrenceIds.length > CLUSTER_SELECTION_PAGE_SIZE);
      setClusterSelectionError(null);
      setClusterSelectionExpectedCount(occurrenceIds.length);
      setSelectedClusterEvents([]);
      await loadCoincidentSelectionPage({
        occurrenceIds,
        offset: 0,
        requestVersion,
        append: false,
      });
    };
    const interactiveLayers = [
      MAP_CLUSTER_HALO_LAYER_ID,
      MAP_CLUSTER_LAYER_ID,
      MAP_EVENT_POINT_LAYER_ID,
    ] as const;
    const handleMapClick = (event: MapMouseEvent) => {
      removeHoverPopup();
      const sourceRevision = MAP_EVENT_SOURCE_REVISION.get(map) ?? 0;
      if (!isMapEventSourceInteractionReady(map, sourceRevision)) return;
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
      resetCursor();
    };
  }, [
    closeEventSelection,
    closeClusterSelection,
    eventsByOccurrenceId,
    formatNumber,
    localizePreviews,
    compactPinBatch.clustered,
    mapPinCacheKey,
    mapInstance,
    mapReady,
    openEventSelection,
    readyStyle,
    requestMapPinReload,
    resolveOccurrencePreviews,
    tr,
  ]);

  const toggleCategory = (slug: string) => {
    const next = new Set(cats);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    setCats(next);
    setAdvancedFilters((current) => ({
      ...current,
      ...pruneSearchSelections(next, current),
    }));
  };

  const resetFilters = () => {
    setRange("year");
    setCats(new Set());
    setQuery("");
    setAdvancedFilters({ ...DEFAULT_ADVANCED_FILTERS, genres: [], subcategories: [] });
    setShowEvents(true);
  };

  const retryMapPins = () => {
    void requestMapPinReload();
  };

  const recenterOnUser = () => {
    const location = userLocationRef.current;
    if (!location) return;
    mapRef.current?.flyTo({
      center: [location.longitude, location.latitude],
      zoom: INITIAL_GEOLOCATION_ZOOM,
      duration: 650,
    });
  };

  const approximateCount = compactPins.reduce((count, pin) => count + pin[6], 0);
  const mobileActiveFilterCount =
    advancedCount + cats.size + Number(range !== "year") + Number(!showEvents);

  if (geolocationStatus !== "ready" || !userLocation) {
    return (
      <LocationPermissionGate
        status={geolocationStatus === "ready" ? "error" : geolocationStatus}
        onRetry={() => setLocationRequestKey((key) => key + 1)}
      />
    );
  }

  if (isMobile) {
    const hasMoreMobileEvents =
      visibleMobileEventCount < events.length || mobileListHasMore || mobileListLoadingMore;
    const mobileSelection = clusterSelectionOpen ? (
      <SelectedClusterEvents
        events={selectedClusterEvents}
        expectedCount={clusterSelectionExpectedCount}
        loading={clusterSelectionLoading}
        loadingMore={clusterSelectionLoadingMore}
        hasMore={clusterSelectionHasMore}
        error={clusterSelectionError}
        onClose={closeClusterSelection}
        onRetry={() => clusterSelectionRetryRef.current?.()}
        onLoadMore={() => clusterSelectionLoadMoreRef.current?.()}
        onSelect={(event) => openEventSelection(event.occurrence_id, event, true)}
      />
    ) : null;

    return (
      <MobileDiscoveryLayout
        resultCount={statsLoading ? null : totalEventCount}
        activeFilterCount={mobileActiveFilterCount}
        hasSelection={Boolean(mobileSelection)}
        onMapResizeNeeded={requestMapResize}
        onMapViewNeeded={() => setListRequested(false)}
        onListViewNeeded={() => setListRequested(true)}
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
                ? tr("Actualisation des événements de la zone visible…")
                : tr("{count} événements dans la zone visible", {
                    count: formatNumber(totalEventCount),
                  })}
            </p>
            {error && (
              <div className="mt-1 flex items-center justify-between gap-2 rounded-xl bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
                <span className="truncate">{error}</span>
                <button
                  type="button"
                  className="min-h-11 shrink-0 font-bold underline"
                  onClick={retryMapPins}
                >
                  {t("common.retry")}
                </button>
              </div>
            )}
          </div>
        }
        map={
          <>
            <MapSurface
              containerRef={containerRef}
              mapReady={mapReady}
              mapUnavailable={mapUnavailable}
              fallbackCenter={userLocation}
            />
            <SelectedMapEventDialog
              open={eventSelectionOpen}
              event={selectedMapEvent}
              detail={selectedMapEventDetail}
              loading={eventSelectionLoading}
              error={eventSelectionError}
              onOpenChange={(nextOpen) => {
                if (!nextOpen) closeEventSelection();
              }}
              onRetry={() => eventSelectionRetryRef.current?.()}
            />
          </>
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

            {mobileListError && (
              <div className="mb-3 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 p-3 text-xs text-destructive">
                <span>{mobileListError}</span>
                <button
                  type="button"
                  className="min-h-11 shrink-0 font-black underline"
                  onClick={() => setMobileListReloadKey((key) => key + 1)}
                >
                  {t("common.retry")}
                </button>
              </div>
            )}

            {(loading || mobileListLoading) && events.length === 0 ? (
              <div className="grid gap-3">
                {Array.from({ length: 4 }, (_, index) => (
                  <EventCardSkeleton key={index} variant="compact" />
                ))}
              </div>
            ) : mobileListEvents.length > 0 ? (
              <div className="grid gap-3">
                {mobileListEvents.map((event, index) => (
                  <div
                    key={event.occurrence_id}
                    style={{ contentVisibility: "auto", containIntrinsicSize: "0 160px" }}
                  >
                    <EventCard ev={event} variant="compact" imagePriority={index < 2} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border p-6 text-center">
                <MapPin className="mx-auto mb-3 h-7 w-7 text-primary" />
                <p className="font-bold">{tr("Aucun événement trouvé")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {tr("Déplace ou dézoome la carte, ou modifie les filtres.")}
                </p>
              </div>
            )}

            {hasMoreMobileEvents && (
              <button
                type="button"
                onClick={loadMoreMobileList}
                disabled={mobileListLoading || mobileListLoadingMore}
                className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 px-4 text-sm font-black text-primary disabled:opacity-60"
              >
                {mobileListLoadingMore && <LoaderCircle className="h-4 w-4 animate-spin" />}
                {mobileListLoadingMore ? t("common.loading") : tr("Afficher plus de sorties")}
              </button>
            )}
          </div>
        }
        filters={
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-sm font-black">{tr("Zone de recherche")}</h3>
              <div className="rounded-2xl border border-primary/30 bg-primary/10 p-3 text-xs">
                <p className="font-black text-primary">{tr("Zone visible de la carte")}</p>
                <p className="mt-1 text-muted-foreground">
                  {tr(
                    "Les événements s’actualisent automatiquement après chaque déplacement ou zoom.",
                  )}
                </p>
                <button
                  type="button"
                  onClick={recenterOnUser}
                  className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border bg-surface font-bold"
                >
                  <Navigation className="h-4 w-4" /> {tr("Recentrer sur ma position")}
                </button>
              </div>
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
                {SEARCH_CATEGORIES.map((category) => {
                  const active = cats.has(category.slug);
                  return (
                    <button
                      key={category.slug}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleCategory(category.slug)}
                      className="min-h-11 rounded-full border px-3 text-xs font-semibold transition-colors"
                      style={{
                        borderColor: category.color,
                        color: active ? "#ffffff" : category.color,
                        background: active ? category.color : `${category.color}18`,
                      }}
                    >
                      {category.icon} {searchCategoryLabel(locale, category)}
                    </button>
                  );
                })}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-black">{t("home.advanced")}</h3>
              <div className="rounded-2xl border p-3">
                <EventFilterPanel
                  value={advancedFilters}
                  onChange={setAdvancedFilters}
                  selectedCategorySlugs={[...cats]}
                  compact
                />
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
                onClick={recenterOnUser}
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
          fallbackCenter={userLocation}
        />
      </div>

      <div className="map-overlay-panel absolute left-3 right-3 top-3 z-10 max-h-[calc(100vh-6.5rem)] overflow-y-auto rounded-3xl p-3 md:left-6 md:right-auto md:w-[30rem]">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <Badge className="mb-2 border-transparent bg-primary/15 text-primary">
              <MapPin className="mr-1 h-3.5 w-3.5" /> {tr("Carte clusterisée")}
            </Badge>
            <h1 className="text-xl font-black">
              {tr("Sorties")} · {tr("zone visible")}
            </h1>
            <p className="text-xs text-muted-foreground">
              {loading
                ? tr("Actualisation des événements de la zone visible…")
                : `${COUNT_FORMATTER.format(totalEventCount)} événements visibles · ${COUNT_FORMATTER.format(mapStats.free_count)} gratuits`}
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
            aria-label={tr("Recentrer sur ma position")}
            onClick={recenterOnUser}
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

        <div className="mb-2 flex items-center gap-2 rounded-2xl border border-primary/30 bg-primary/10 px-3 py-2 text-xs">
          <Navigation className="h-4 w-4 shrink-0 text-primary" />
          <span>
            <strong className="text-primary">{tr("Zone visible")}</strong>
            <span className="block text-muted-foreground">
              {tr("Déplace ou zoome la carte pour actualiser les événements.")}
            </span>
          </span>
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
          {SEARCH_CATEGORIES.map((category) => {
            const active = cats.has(category.slug);
            return (
              <button
                key={category.slug}
                type="button"
                aria-pressed={active}
                onClick={() => toggleCategory(category.slug)}
                className="shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors"
                style={{
                  borderColor: category.color,
                  color: active ? "#ffffff" : category.color,
                  background: active ? category.color : `${category.color}18`,
                }}
              >
                {category.icon} {searchCategoryLabel(locale, category)}
              </button>
            );
          })}
        </div>

        <details
          className="rounded-2xl border bg-surface/75"
          open={advancedCount > 0 || cats.size > 0}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-semibold">
            <span className="inline-flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-primary" /> {t("home.advanced")}
            </span>
            <Badge variant={advancedCount ? "default" : "outline"}>
              {advancedCount || t("common.all")}
            </Badge>
          </summary>
          <div className="border-t p-3">
            <EventFilterPanel
              value={advancedFilters}
              onChange={setAdvancedFilters}
              selectedCategorySlugs={[...cats]}
              compact
            />
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
            <button type="button" className="font-semibold underline" onClick={retryMapPins}>
              {t("common.retry")}
            </button>
          </div>
        )}

        {mapUnavailable && events.length > 0 && (
          <div className="mt-3 rounded-2xl border bg-background/75 p-3">
            <p className="mb-2 text-xs font-bold">{tr("Événements accessibles sans WebGL")}</p>
            <div className="grid gap-1.5">
              {events.slice(0, 12).map((event) => (
                <MapFallbackEventLink key={event.occurrence_id} event={event} />
              ))}
            </div>
          </div>
        )}
      </div>

      {clusterSelectionOpen && (
        <div className="map-overlay-panel absolute bottom-6 left-[32rem] z-10 w-80 rounded-3xl">
          <SelectedClusterEvents
            events={selectedClusterEvents}
            expectedCount={clusterSelectionExpectedCount}
            loading={clusterSelectionLoading}
            loadingMore={clusterSelectionLoadingMore}
            hasMore={clusterSelectionHasMore}
            error={clusterSelectionError}
            onClose={closeClusterSelection}
            onRetry={() => clusterSelectionRetryRef.current?.()}
            onLoadMore={() => clusterSelectionLoadMoreRef.current?.()}
            onSelect={(event) => openEventSelection(event.occurrence_id, event, true)}
          />
        </div>
      )}

      <SelectedMapEventDialog
        open={eventSelectionOpen}
        event={selectedMapEvent}
        detail={selectedMapEventDetail}
        loading={eventSelectionLoading}
        error={eventSelectionError}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeEventSelection();
        }}
        onRetry={() => eventSelectionRetryRef.current?.()}
      />
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
