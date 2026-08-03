import type { Feature, FeatureCollection, Point } from "geojson";
import { eventCategoryVisual, normalizeEventCategorySlug } from "@/lib/event-category-style";
import type { CompactMapPin } from "@/lib/map-pins";
import type { DiscoveredEvent } from "@/lib/queries";

export type MapPointProperties = {
  kind: "event" | "server_cluster" | "coincident_cluster";
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
  coincident_ids?: string;
};

export type MapPointCollection = FeatureCollection<Point, MapPointProperties>;

const WEB_MERCATOR_METERS_PER_PIXEL_AT_ZOOM_ZERO = 156_543.03392;
const METERS_PER_LATITUDE_DEGREE = 111_320;
const COINCIDENT_PIN_SPACING_PX = 48;
const GOLDEN_ANGLE_RADIANS = Math.PI * (3 - Math.sqrt(5));
export const MAX_SPIDERFY_GROUP_SIZE = 12;

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

/**
 * Identifies a pin batch cheaply enough to run on every render.
 *
 * The source update is skipped when the batch has not changed, but proving
 * that by serializing every pin cost more than the update it was avoiding:
 * 5.8ms of main-thread time at the server's 12,000 pin cap, on a desktop CPU.
 * Mixing the fields numerically is the same comparison for a third of the
 * price, and folds in order and length so a reorder or a dropped pin still
 * produces a different signature.
 */
export function compactMapPinsSignature(pins: CompactMapPin[]): string {
  let hashA = 0x811c9dc5 | 0;
  let hashB = 0x9e3779b9 | 0;
  const mix = (value: number) => {
    hashA = Math.imul(hashA ^ value, 0x01000193);
    hashB = Math.imul((hashB + value) | 0, 0x85ebca6b);
  };
  // Identifiers are long and opaque; their length plus three sampled code
  // units separate them well enough once coordinates and counts are folded in.
  const mixText = (text: string) => {
    const length = text.length;
    mix(length);
    if (!length) return;
    mix(text.charCodeAt(0));
    mix(text.charCodeAt(length >> 1));
    mix(text.charCodeAt(length - 1));
  };

  for (let index = 0; index < pins.length; index += 1) {
    const pin = pins[index];
    // "event" and "cluster" differ in their first code unit, but folding the
    // length in too keeps the field observable rather than relying on that.
    mix(pin[0].charCodeAt(0));
    mix(pin[0].length);
    mixText(pin[1]);
    mix(Math.round(pin[2] * 1e6));
    mix(Math.round(pin[3] * 1e6));
    mixText(pin[4]);
    mix(pin[5]);
    mix(pin[6]);
    mixText(pin[7]);
    mix(pin[8]);
    mix(pin[9]);
  }
  mix(pins.length);

  return `${(hashA >>> 0).toString(36)}${(hashB >>> 0).toString(36)}${pins.length}`;
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

/**
 * Spreads events sharing the exact same venue coordinate once client
 * clustering has ended. This is the map equivalent of spiderfying: distinct
 * event pins remain individually clickable without changing their stored
 * coordinates or any lower-zoom clustering decision.
 */
export function spreadCoincidentMapPoints(
  collection: MapPointCollection,
  zoom: number,
  terminalZoom: number,
): MapPointCollection {
  if (!Number.isFinite(zoom) || zoom < terminalZoom) return collection;

  const groups = new Map<string, Array<Feature<Point, MapPointProperties>>>();
  for (const feature of collection.features) {
    if (feature.properties.kind !== "event") continue;
    const [longitude, latitude] = feature.geometry.coordinates;
    const key = `${longitude.toFixed(7)}:${latitude.toFixed(7)}`;
    const group = groups.get(key);
    if (group) group.push(feature);
    else groups.set(key, [feature]);
  }

  const offsets = new Map<string | number, [number, number]>();
  const collapsedIds = new Set<string | number>();
  const collapsedGroups = new Map<string | number, Feature<Point, MapPointProperties>>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((left, right) =>
      left.properties.entity_id.localeCompare(right.properties.entity_id),
    );
    if (ordered.length > MAX_SPIDERFY_GROUP_SIZE) {
      const first = ordered[0];
      if (first.id == null) continue;
      ordered.forEach((feature) => {
        if (feature.id != null) collapsedIds.add(feature.id);
      });
      collapsedGroups.set(first.id, {
        ...first,
        id: `coincident:${first.geometry.coordinates.join(":")}`,
        properties: {
          ...first.properties,
          kind: "coincident_cluster",
          entity_id: `coincident:${first.geometry.coordinates.join(":")}`,
          event_count: ordered.length,
          free_count: ordered.reduce((count, feature) => count + feature.properties.free_count, 0),
          coincident_ids: JSON.stringify(ordered.map((feature) => feature.properties.entity_id)),
        },
      });
      continue;
    }
    const [, latitude] = ordered[0].geometry.coordinates;
    const latitudeCosine = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
    const metersPerPixel =
      (WEB_MERCATOR_METERS_PER_PIXEL_AT_ZOOM_ZERO * latitudeCosine) / 2 ** zoom;

    ordered.forEach((feature, index) => {
      if (feature.id == null) return;
      if (index === 0) {
        offsets.set(feature.id, [0, 0]);
        return;
      }
      const angle = index * GOLDEN_ANGLE_RADIANS;
      const radiusMeters = COINCIDENT_PIN_SPACING_PX * Math.sqrt(index) * metersPerPixel;
      const eastMeters = Math.cos(angle) * radiusMeters;
      const northMeters = Math.sin(angle) * radiusMeters;
      offsets.set(feature.id, [
        eastMeters / (METERS_PER_LATITUDE_DEGREE * latitudeCosine),
        northMeters / METERS_PER_LATITUDE_DEGREE,
      ]);
    });
  }

  if (!offsets.size && !collapsedGroups.size) return collection;
  return {
    type: "FeatureCollection",
    features: collection.features.flatMap((feature) => {
      if (feature.id == null) return [feature];
      const collapsed = collapsedGroups.get(feature.id);
      if (collapsed) return [collapsed];
      if (collapsedIds.has(feature.id)) return [];
      const offset = offsets.get(feature.id);
      if (!offset || (offset[0] === 0 && offset[1] === 0)) return [feature];
      const [longitude, latitude] = feature.geometry.coordinates;
      return [
        {
          ...feature,
          geometry: {
            type: "Point",
            coordinates: [longitude + offset[0], latitude + offset[1]],
          },
        },
      ];
    }),
  };
}

export function coincidentMapPointOccurrenceIds(
  properties: Partial<MapPointProperties> | null | undefined,
): string[] {
  if (properties?.kind !== "coincident_cluster" || !properties.coincident_ids) return [];
  try {
    const parsed = JSON.parse(properties.coincident_ids);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter((value): value is string => typeof value === "string" && value.length > 0),
      ),
    ];
  } catch {
    return [];
  }
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
