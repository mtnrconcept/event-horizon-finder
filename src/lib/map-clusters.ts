import type { Feature, FeatureCollection, Point } from "geojson";
import { eventCategoryVisual, normalizeEventCategorySlug } from "@/lib/event-category-style";
import type { CompactMapPin } from "@/lib/map-pins";
import type { DiscoveredEvent } from "@/lib/queries";

export type MapPointProperties = {
  kind: "event" | "server_cluster";
  entity_id: string;
  label: string;
  category_slug: string;
  category_color: string;
  category_icon_image: string;
  is_free: 0 | 1;
  approximate: 0 | 1;
  slug: string;
  event_count: number;
  free_count: number;
};

export type MapPointCollection = FeatureCollection<Point, MapPointProperties>;

function validLongitude(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= -180 && value <= 180;
}

function validLatitude(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isMapCoordinatePlausibleForCountry(
  countryCode: string | null | undefined,
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (!validLatitude(latitude) || !validLongitude(longitude)) return false;
  if (countryCode?.trim().toUpperCase() !== "ES") return true;

  const isMainlandOrBalearic =
    latitude >= 35 && latitude <= 44.5 && longitude >= -10 && longitude <= 5;
  const isCanaryIsland = latitude >= 27 && latitude <= 30 && longitude >= -19 && longitude <= -13;

  return isMainlandOrBalearic || isCanaryIsland;
}

export function buildMapPointCollection({
  events,
  showEvents,
  countryCode = null,
}: {
  events: DiscoveredEvent[];
  showEvents: boolean;
  countryCode?: string | null;
}): MapPointCollection {
  const features: Array<Feature<Point, MapPointProperties>> = [];

  if (showEvents) {
    for (const event of events) {
      if (
        !validLongitude(event.longitude) ||
        !validLatitude(event.latitude) ||
        !isMapCoordinatePlausibleForCountry(countryCode, event.latitude, event.longitude)
      ) {
        continue;
      }
      const categorySlug = normalizeEventCategorySlug(event.category_slug);
      const categoryVisual = eventCategoryVisual(categorySlug);
      features.push({
        type: "Feature",
        id: `event:${event.occurrence_id}`,
        geometry: { type: "Point", coordinates: [event.longitude, event.latitude] },
        properties: {
          kind: "event",
          entity_id: event.occurrence_id,
          label: event.title,
          category_slug: categorySlug,
          category_color: categoryVisual.color,
          category_icon_image: categoryVisual.imageId,
          is_free: event.is_free ? 1 : 0,
          approximate: event.location_precision === "city" ? 1 : 0,
          slug: event.slug,
          event_count: 1,
          free_count: event.is_free ? 1 : 0,
        },
      });
    }
  }

  return { type: "FeatureCollection", features };
}

export function buildCompactMapPointCollection({
  pins,
  showEvents,
}: {
  pins: CompactMapPin[];
  showEvents: boolean;
}): MapPointCollection {
  if (!showEvents) return { type: "FeatureCollection", features: [] };

  const features: Array<Feature<Point, MapPointProperties>> = [];
  for (const [
    kind,
    entityId,
    longitude,
    latitude,
    rawCategorySlug,
    isFree,
    approximate,
    slug,
    eventCount,
    freeCount,
  ] of pins) {
    if (!validLongitude(longitude) || !validLatitude(latitude)) continue;
    const categorySlug = normalizeEventCategorySlug(rawCategorySlug);
    const categoryVisual = eventCategoryVisual(categorySlug);
    features.push({
      type: "Feature",
      id: `${kind}:${entityId}`,
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties: {
        kind: kind === "cluster" ? "server_cluster" : "event",
        entity_id: entityId,
        label: "",
        category_slug: categorySlug,
        category_color: categoryVisual.color,
        category_icon_image: categoryVisual.imageId,
        is_free: isFree,
        approximate,
        slug,
        event_count: eventCount,
        free_count: freeCount,
      },
    });
  }

  return { type: "FeatureCollection", features };
}

export function buildLoadedMapPointCollection({
  unfilteredWorld,
  compactPins,
  worldPinsReady,
  events,
  showEvents,
  countryCode = null,
}: {
  unfilteredWorld: boolean;
  compactPins: CompactMapPin[] | null;
  worldPinsReady: boolean;
  events: DiscoveredEvent[];
  showEvents: boolean;
  countryCode?: string | null;
}): MapPointCollection {
  if (unfilteredWorld) {
    // The detailed list endpoint returns 1,000 rows at a time. Never expose
    // that first page as if it were the complete worldwide map while the
    // uncapped compact response is still loading.
    if (!worldPinsReady) {
      return buildCompactMapPointCollection({ pins: [], showEvents });
    }
    if (compactPins) {
      return buildCompactMapPointCollection({ pins: compactPins, showEvents });
    }
  }

  return buildMapPointCollection({ events, showEvents, countryCode });
}
