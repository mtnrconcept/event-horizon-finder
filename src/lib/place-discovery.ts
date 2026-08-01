import { supabase } from "@/integrations/supabase/client";
import { runMapRequestWithRetry } from "@/lib/map-network-retry";
import { normalizeMapViewportBounds, type MapViewportBounds } from "@/lib/map-viewport";

export const PLACE_LIST_PAGE_SIZE = 36;
export const PLACE_SERVER_CLUSTER_MAX_ZOOM = 12;

export type PlacePinKind = "place" | "cluster";

export interface PlaceOfInterest {
  id: string;
  name: string;
  slug: string;
  category: string;
  subcategory: string | null;
  description: string | null;
  address: string | null;
  website: string | null;
  source_url: string | null;
  image_url: string | null;
  opening_hours: string | null;
  fee: string | null;
  wheelchair: string | null;
  latitude: number;
  longitude: number;
  quality_score: number;
}

export interface PlaceMapPin extends PlaceOfInterest {
  kind: PlacePinKind;
  count: number;
}

export interface PlaceMapPinBatch {
  pins: PlaceMapPin[];
  totalCount: number;
  clustered: boolean;
  truncated: boolean;
}

export interface PlaceListBatch {
  items: PlaceOfInterest[];
  totalCount: number;
  hasMore: boolean;
}

export interface DiscoverPlaceParams {
  bounds: MapViewportBounds;
  zoom: number;
  categories?: string[] | null;
  query?: string | null;
  accessibleOnly?: boolean;
  freeOnly?: boolean;
  hasHoursOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface PlaceFeatureProperties {
  entity_kind: PlacePinKind;
  place_id: string;
  place_count: number;
  category: string;
  name: string;
  place_json: string;
}

export interface PlaceFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: PlaceFeatureProperties;
  }>;
}

const EMPTY_PIN_BATCH: PlaceMapPinBatch = {
  pins: [],
  totalCount: 0,
  clustered: false,
  truncated: false,
};

const CATEGORY_LABELS: Record<string, string> = {
  attraction: "Attraction et monument",
  culture: "Culture et patrimoine",
  nature: "Nature et jardin",
  family: "Famille et loisirs",
  "sports-outdoors": "Sports et plein air",
  "food-drink": "Marché et gastronomie",
  mixed: "Plusieurs catégories",
};

const CATEGORY_COLORS: Record<string, string> = {
  attraction: "#0ea5e9",
  culture: "#8b5cf6",
  nature: "#16a34a",
  family: "#f59e0b",
  "sports-outdoors": "#ef4444",
  "food-drink": "#f97316",
  mixed: "#0f766e",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function placeWithoutPinMetadata(pin: PlaceMapPin): PlaceOfInterest {
  return {
    id: pin.id,
    name: pin.name,
    slug: pin.slug,
    category: pin.category,
    subcategory: pin.subcategory,
    description: pin.description,
    address: pin.address,
    website: pin.website,
    source_url: pin.source_url,
    image_url: pin.image_url,
    opening_hours: pin.opening_hours,
    fee: pin.fee,
    wheelchair: pin.wheelchair,
    latitude: pin.latitude,
    longitude: pin.longitude,
    quality_score: pin.quality_score,
  };
}

function parsePlace(value: unknown, forcedKind?: PlacePinKind): PlaceMapPin | null {
  if (!isRecord(value)) return null;
  const latitude = finiteNumber(value.latitude, Number.NaN);
  const longitude = finiteNumber(value.longitude, Number.NaN);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const rawKind = forcedKind ?? (stringValue(value.kind) as PlacePinKind);
  const kind: PlacePinKind = rawKind === "cluster" ? "cluster" : "place";
  const id = stringValue(value.id);
  const count = Math.max(1, nonNegativeInteger(value.count, 1));
  if (!id) return null;

  return {
    kind,
    count,
    id,
    name: stringValue(value.name, kind === "cluster" ? "Lieux regroupés" : "Lieu à visiter"),
    slug: stringValue(value.slug, id),
    category: stringValue(value.category, kind === "cluster" ? "mixed" : "attraction"),
    subcategory: nullableString(value.subcategory),
    description: nullableString(value.description),
    address: nullableString(value.address),
    website: nullableString(value.website),
    source_url: nullableString(value.source_url),
    image_url: nullableString(value.image_url),
    opening_hours: nullableString(value.opening_hours),
    fee: nullableString(value.fee),
    wheelchair: nullableString(value.wheelchair),
    latitude,
    longitude,
    quality_score: Math.min(100, Math.max(0, nonNegativeInteger(value.quality_score, 0))),
  };
}

function parsePinBatch(value: unknown): PlaceMapPinBatch {
  if (!isRecord(value) || !Array.isArray(value.pins)) return EMPTY_PIN_BATCH;
  const pins = value.pins.flatMap((pin) => {
    const parsed = parsePlace(pin);
    return parsed ? [parsed] : [];
  });
  return {
    pins,
    totalCount: nonNegativeInteger(
      value.total_count,
      pins.reduce((sum, pin) => sum + pin.count, 0),
    ),
    clustered: value.clustered === true,
    truncated: value.truncated === true,
  };
}

function parseListBatch(value: unknown): PlaceListBatch {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return { items: [], totalCount: 0, hasMore: false };
  }
  const items = value.items.flatMap((item) => {
    const parsed = parsePlace(item, "place");
    return parsed ? [placeWithoutPinMetadata(parsed)] : [];
  });
  return {
    items,
    totalCount: nonNegativeInteger(value.total_count, items.length),
    hasMore: value.has_more === true,
  };
}

function placeRpcArgs(params: DiscoverPlaceParams, includePagination: boolean) {
  const bounds = normalizeMapViewportBounds(params.bounds);
  if (!bounds) throw new RangeError("Invalid place map viewport bounds");
  return {
    _west: bounds.west,
    _south: bounds.south,
    _east: bounds.east,
    _north: bounds.north,
    _category_slugs: params.categories?.length ? [...new Set(params.categories)] : null,
    _query: params.query?.trim() || null,
    _accessible_only: params.accessibleOnly ?? false,
    _free_only: params.freeOnly ?? false,
    _has_hours_only: params.hasHoursOnly ?? false,
    _zoom: Math.min(22, Math.max(0, params.zoom)),
    ...(includePagination
      ? {
          _limit: Math.min(200, Math.max(1, params.limit ?? PLACE_LIST_PAGE_SIZE)),
          _offset: Math.max(0, params.offset ?? 0),
        }
      : {}),
  };
}

export async function discoverPlacePinsInBounds(
  params: DiscoverPlaceParams,
  signal?: AbortSignal,
): Promise<PlaceMapPinBatch> {
  const args = placeRpcArgs(params, false);
  return runMapRequestWithRetry(
    async () => {
      // Generated database types intentionally lag behind additive migrations.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const request = (supabase as any)
        .rpc("discover_place_pins_in_bounds_v1", args)
        .retry(false);
      const { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error) throw error;
      return parsePinBatch(data);
    },
    { signal },
  );
}

export async function discoverPlacesInBounds(
  params: DiscoverPlaceParams,
  signal?: AbortSignal,
): Promise<PlaceListBatch> {
  const args = placeRpcArgs(params, true);
  return runMapRequestWithRetry(
    async () => {
      // Generated database types intentionally lag behind additive migrations.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const request = (supabase as any)
        .rpc("discover_places_in_bounds_v1", args)
        .retry(false);
      const { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error) throw error;
      return parseListBatch(data);
    },
    { signal },
  );
}

export function buildPlaceFeatureCollection(batch: PlaceMapPinBatch): PlaceFeatureCollection {
  return {
    type: "FeatureCollection",
    features: batch.pins.map((pin) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [pin.longitude, pin.latitude],
      },
      properties: {
        entity_kind: pin.kind,
        place_id: pin.id,
        place_count: pin.count,
        category: pin.category,
        name: pin.name,
        place_json: pin.kind === "place" ? JSON.stringify(pin) : "",
      },
    })),
  };
}

export function placeFromFeatureProperties(
  properties: Partial<PlaceFeatureProperties> | null | undefined,
): PlaceOfInterest | null {
  if (!properties?.place_json) return null;
  try {
    const parsed = parsePlace(JSON.parse(properties.place_json), "place");
    return parsed ? placeWithoutPinMetadata(parsed) : null;
  } catch {
    return null;
  }
}

export function placeCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? "Lieu d’intérêt";
}

export function placeCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? "#0f766e";
}

export function placeIsFree(place: Pick<PlaceOfInterest, "fee">): boolean {
  const fee = place.fee?.trim().toLowerCase() ?? "";
  return ["0", "false", "free", "gratuit", "gratuito", "kostenlos", "no"].includes(fee);
}

export function placeIsAccessible(place: Pick<PlaceOfInterest, "wheelchair">): boolean {
  const wheelchair = place.wheelchair?.trim().toLowerCase() ?? "";
  return ["yes", "limited", "designated"].includes(wheelchair);
}
