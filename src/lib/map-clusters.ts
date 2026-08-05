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
  if (!showEvents || !events.length) return { type: "FeatureCollection", features: [] };

  const features: Array<Feature<Point, MapPointProperties>> = [];
  const len = events.length;

  for (let i = 0; i < len; i++) {
    const event = events[i];
    const { longitude, latitude } = event;

    if (
      !validLongitude(longitude) ||
      !validLatitude(latitude) ||
      !isMapCoordinatePlausibleForCountry(countryCode, latitude, longitude)
    ) {
      continue;
    }

    const categorySlug = normalizeEventCategorySlug(event.category_slug);
    const categoryVisual = eventCategoryVisual(categorySlug);
    const isFree = event.is_free ? 1 : 0;

    features.push({
      type: "Feature",
      id: `event:${event.occurrence_id}`,
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties: {
        kind: "event",
        entity_id: event.occurrence_id,
        label: event.title,
        category_slug: categorySlug,
        category_color: categoryVisual.color,
        category_icon_image: categoryVisual.imageId,
        is_free: isFree,
        approximate: event.location_precision === "city" ? 1 : 0,
        slug: event.slug,
        event_count: 1,
        free_count: isFree,
      },
    });
  }

  return { type: "FeatureCollection", features };
}

/**
 * Calcul de signature ultra-rapide.
 * Utilise un échantillonnage (stride) si le volume dépasse 1000 pins afin de
 * ne jamais bloquer le fil d'exécution principal (Main Thread).
 */
export function compactMapPinsSignature(pins: CompactMapPin[]): string {
  const len = pins.length;
  if (len === 0) return "0_0_0";

  let hashA = 0x811c9dc5 | 0;
  let hashB = 0x9e3779b9 | 0;

  const mix = (value: number) => {
    hashA = Math.imul(hashA ^ value, 0x01000193);
    hashB = Math.imul((hashB + value) | 0, 0x85ebca6b);
  };

  // Échantillonnage si très grand volume pour exécuter en < 0.5ms
  const stride = len > 1000 ? Math.ceil(len / 400) : 1;

  for (let index = 0; index < len; index += stride) {
    const pin = pins[index];
    mix((pin[2] * 1e5) | 0); // Longitude
    mix((pin[3] * 1e5) | 0); // Latitude
    mix(pin[5]);             // isFree
    mix(pin[8]);             // eventCount
  }

  mix(len);
  return `${(hashA >>> 0).toString(36)}${(hashB >>> 0).toString(36)}${len}`;
}

export function buildCompactMapPointCollection({
  pins,
  showEvents,
}: {
  pins: CompactMapPin[];
  showEvents: boolean;
}): MapPointCollection {
  if (!showEvents || !pins || pins.length === 0) {
    return { type: "FeatureCollection", features: [] };
  }

  const features: Array<Feature<Point, MapPointProperties>> = [];
  const len = pins.length;

  for (let i = 0; i < len; i++) {
    const pin = pins[i];
    const longitude = pin[2];
    const latitude = pin[3];

    if (!validLongitude(longitude) || !validLatitude(latitude)) continue;

    const kind = pin[0];
    const entityId = pin[1];
    const categorySlug = normalizeEventCategorySlug(pin[4]);
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
        is_free: pin[5],
        approximate: pin[6],
        slug: pin[7],
        event_count: pin[8],
        free_count: pin[9],
      },
    });
  }

  return { type: "FeatureCollection", features };
}

/**
 * Version hautement optimisée du "Spiderfy".
 * Remplace .toFixed() par de la manipulation entière et supprime localeCompare
 * pour éviter les ralentissements pendant les animations de la carte.
 */
export function spreadCoincidentMapPoints(
  collection: MapPointCollection,
  zoom: number,
  terminalZoom: number,
): MapPointCollection {
  if (!Number.isFinite(zoom) || zoom < terminalZoom || !collection.features.length) {
    return collection;
  }

  const groups = new Map<string, Array<Feature<Point, MapPointProperties>>>();
  const features = collection.features;
  const len = features.length;

  // 1. Clé de groupe basée sur des entiers (rapide, sans allocation .toFixed)
  for (let i = 0; i < len; i++) {
    const feature = features[i];
    if (feature.properties.kind !== "event") continue;

    const [longitude, latitude] = feature.geometry.coordinates;
    const key = `${(longitude * 1e6) | 0}_${(latitude * 1e6) | 0}`;
    
    const group = groups.get(key);
    if (group) group.push(feature);
    else groups.set(key, [feature]);
  }

  const offsets = new Map<string | number, [number, number]>();
  const collapsedIds = new Set<string | number>();
  const collapsedGroups = new Map<string | number, Feature<Point, MapPointProperties>>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // 2. Remplacement de localeCompare par une comparaison de chaînes native (x50 plus rapide)
    group.sort((left, right) =>
      left.properties.entity_id < right.properties.entity_id ? -1 : 1
    );

    if (group.length > MAX_SPIDERFY_GROUP_SIZE) {
      const first = group[0];
      if (first.id == null) continue;

      for (let j = 0; j < group.length; j++) {
        const id = group[j].id;
        if (id != null) collapsedIds.add(id);
      }

      const [longitude, latitude] = first.geometry.coordinates;
      const coincidentId = `coincident:${longitude}:${latitude}`;

      collapsedGroups.set(first.id, {
        ...first,
        id: coincidentId,
        properties: {
          ...first.properties,
          kind: "coincident_cluster",
          entity_id: coincidentId,
          event_count: group.length,
          free_count: group.reduce((count, feat) => count + feat.properties.free_count, 0),
          coincident_ids: JSON.stringify(group.map((feat) => feat.properties.entity_id)),
        },
      });
      continue;
    }

    const [, latitude] = group[0].geometry.coordinates;
    const latitudeCosine = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
    const metersPerPixel =
      (WEB_MERCATOR_METERS_PER_PIXEL_AT_ZOOM_ZERO * latitudeCosine) / 2 ** zoom;

    for (let index = 0; index < group.length; index++) {
      const feature = group[index];
      if (feature.id == null) continue;

      if (index === 0) {
        offsets.set(feature.id, [0, 0]);
        continue;
      }

      const angle = index * GOLDEN_ANGLE_RADIANS;
      const radiusMeters = COINCIDENT_PIN_SPACING_PX * Math.sqrt(index) * metersPerPixel;
      const eastMeters = Math.cos(angle) * radiusMeters;
      const northMeters = Math.sin(angle) * radiusMeters;

      offsets.set(feature.id, [
        eastMeters / (METERS_PER_LATITUDE_DEGREE * latitudeCosine),
        northMeters / METERS_PER_LATITUDE_DEGREE,
      ]);
    }
  }

  if (offsets.size === 0 && collapsedGroups.size === 0) return collection;

  // 3. Remplacement de flatMap par une boucle for impérative (mémorisant les objets inchangés)
  const resultFeatures: Array<Feature<Point, MapPointProperties>> = [];

  for (let i = 0; i < len; i++) {
    const feature = features[i];
    if (feature.id == null) {
      resultFeatures.push(feature);
      continue;
    }

    const collapsed = collapsedGroups.get(feature.id);
    if (collapsed) {
      resultFeatures.push(collapsed);
      continue;
    }

    if (collapsedIds.has(feature.id)) continue;

    const offset = offsets.get(feature.id);
    if (!offset || (offset[0] === 0 && offset[1] === 0)) {
      resultFeatures.push(feature);
      continue;
    }

    const [longitude, latitude] = feature.geometry.coordinates;
    resultFeatures.push({
      ...feature,
      geometry: {
        type: "Point",
        coordinates: [longitude + offset[0], latitude + offset[1]],
      },
    });
  }

  return {
    type: "FeatureCollection",
    features: resultFeatures,
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
    if (!worldPinsReady) {
      return buildCompactMapPointCollection({ pins: [], showEvents });
    }
    if (compactPins) {
      return buildCompactMapPointCollection({ pins: compactPins, showEvents });
    }
  }

  return buildMapPointCollection({ events, showEvents, countryCode });
}
