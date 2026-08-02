Warning: truncated output (original token count: 37038)
Total output lines: 3782

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
  stabilizeMapClusterViewport,
  type MapViewportBounds,
} from "@/lib/map-viewport";
import { mapAssetProxyUrl } from "@/lib/map-asset-proxy";
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
  locationClusterSelectionBounds,
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
const MAP_VIEWPORT_REFRESH_DELAY_MS = 560;
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
  clusterMode: "client",
  truncated: false,
};

function transformMapAssetRequest(url: string) {
  const proxied = mapAssetProxyUrl(url);
  return proxied ? { url: proxied } : undefined;
}

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
                                  .map((occurrence) =>…17038 tokens truncated…       );
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
    const loadServerLocationSelectionPage = async ({
      bounds,
      pointCount,
      offset,
      requestVersion,
      append,
    }: {
      bounds: MapViewportBounds;
      pointCount: number;
      offset: number;
      requestVersion: number;
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
        if (!mapDiscoveryParams) throw new Error("Map discovery parameters are unavailable");
        const locationEvents = await discoverMapEventsInBounds({
          ...mapDiscoveryParams,
          bounds,
          limit: page.limit,
          offset: page.offset,
        });
        if (requestVersion !== clusterSelectionRequestRef.current) return;
        const previews = locationEvents.map(mapPreviewFromDiscoveredEvent);
        setSelectedClusterEvents((current) => {
          const merged = append ? [...current, ...previews] : previews;
          return [...new Map(merged.map((preview) => [preview.occurrence_id, preview])).values()];
        });
        const nextOffset = page.offset + locationEvents.length;
        const hasMore = locationEvents.length > 0 && nextOffset < pointCount;
        setClusterSelectionHasMore(hasMore);
        clusterSelectionLoadMoreRef.current = hasMore
          ? () => {
              void loadServerLocationSelectionPage({
                bounds,
                pointCount,
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
          void loadServerLocationSelectionPage({
            bounds,
            pointCount,
            offset: page.offset,
            requestVersion,
            append,
          });
        };
        setClusterSelectionError(
          "Impossible de charger les événements de ce lieu. Vérifie ta connexion puis réessaie.",
        );
      } finally {
        if (requestVersion === clusterSelectionRequestRef.current) {
          if (append) setClusterSelectionLoadingMore(false);
          else setClusterSelectionLoading(false);
        }
      }
    };
    const loadServerLocationSelection = async (
      longitude: number,
      latitude: number,
      pointCount: number,
    ) => {
      const bounds = locationClusterSelectionBounds(longitude, latitude);
      if (!bounds) return;
      const requestVersion = ++clusterSelectionRequestRef.current;
      clusterSelectionRetryRef.current = () => {
        void loadServerLocationSelection(longitude, latitude, pointCount);
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
      await loadServerLocationSelectionPage({
        bounds,
        pointCount,
        offset: 0,
        requestVersion,
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
          void loadServerLocationSelection(Number(longitude), Number(latitude), pointCount);
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
    mapDiscoveryParams,
    openEventSelection,
    readyStyle,
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
