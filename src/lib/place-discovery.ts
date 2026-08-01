import { supabase } from "@/integrations/supabase/client";
import { runMapRequestWithRetry } from "@/lib/map-network-retry";
import { normalizeMapViewportBounds, type MapViewportBounds } from "@/lib/map-viewport";

export const PLACE_LIST_PAGE_SIZE = 36;
export const PLACE_SERVER_CLUSTER_MAX_ZOOM = 12;

export type PlacePinKind = "place" | "cluster";

export interface PlaceContentSource {
  label: string;
  url: string;
  provider?: string | null;
}

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
  image_urls: string[];
  booking_url: string | null;
  source_urls: string[];
  content_sources: PlaceContentSource[];
  opening_hours: string | null;
  fee: string | null;
  wheelchair: string | null;
  latitude: number;
  longitude: number;
  quality_score: number;
}

/**
 * Pins deliberately contain no description, media or external links. Those
 * fields are loaded by get_place_detail_v1 only after an individual pin is
 * selected, which keeps map payloads and MapLibre worker transfers small.
 */
export interface PlaceMapPin {
  kind: PlacePinKind;
  id: string;
  name: string;
  category: string;
  latitude: number;
  longitude: number;
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

export interface DiscoverHomePlaceParams {
  countryId?: string | null;
  regionId?: string | null;
  cityId?: string | null;
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
  latitude: number;
  longitude: number;
}

export interface PlaceFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: PlaceFeatureProperties;
  }>;
}

export const EMPTY_PLACE_PIN_BATCH: PlaceMapPinBatch = {
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

const PLACE_DETAIL_CACHE_LIMIT = 64;
const PLACE_DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const placeDetailCache = new Map<string, { detail: PlaceOfInterest; expiresAt: number }>();
const placeDetailRequests = new Map<string, Promise<PlaceOfInterest | null>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      ),
    ),
  ];
}

function contentSourceArray(value: unknown): PlaceContentSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const label = nullableString(item.label);
    const url = nullableString(item.url);
    if (!label || !url) return [];
    return [{ label, url, provider: nullableString(item.provider) }];
  });
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePlace(value: unknown): PlaceOfInterest | null {
  if (!isRecord(value)) return null;
  const latitude = finiteNumber(value.latitude, Number.NaN);
  const longitude = finiteNumber(value.longitude, Number.NaN);
  const id = stringValue(value.id).trim();
  if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const imageUrl = nullableString(value.image_url);
  const imageUrls = stringArray(value.image_urls);
  if (imageUrl && !imageUrls.includes(imageUrl)) imageUrls.unshift(imageUrl);
  const sourceUrl = nullableString(value.source_url);
  const sourceUrls = stringArray(value.source_urls);
  if (sourceUrl && !sourceUrls.includes(sourceUrl)) sourceUrls.unshift(sourceUrl);

  return {
    id,
    name: stringValue(value.name, "Lieu à visiter"),
    slug: stringValue(value.slug, id),
    category: stringValue(value.category, "attraction"),
    subcategory: nullableString(value.subcategory),
    description: nullableString(value.description),
    address: nullableString(value.address),
    website: nullableString(value.website),
    source_url: sourceUrl,
    image_url: imageUrl ?? imageUrls[0] ?? null,
    image_urls: imageUrls.slice(0, 12),
    booking_url: nullableString(value.booking_url),
    source_urls: sourceUrls.slice(0, 12),
    content_sources: contentSourceArray(value.content_sources).slice(0, 12),
    opening_hours: nullableString(value.opening_hours),
    fee: nullableString(value.fee),
    wheelchair: nullableString(value.wheelchair),
    latitude,
    longitude,
    quality_score: Math.min(100, Math.max(0, nonNegativeInteger(value.quality_score, 0))),
  };
}

function parseCompactPin(value: unknown): PlaceMapPin | null {
  if (Array.isArray(value)) {
    const kind: PlacePinKind = value[0] === "cluster" ? "cluster" : "place";
    const id = stringValue(value[1]).trim();
    const longitude = finiteNumber(value[2], Number.NaN);
    const latitude = finiteNumber(value[3], Number.NaN);
    if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return {
      kind,
      id,
      longitude,
      latitude,
      category: stringValue(value[4], kind === "cluster" ? "mixed" : "attraction"),
      count: Math.max(1, nonNegativeInteger(value[5], 1)),
      name: stringValue(value[6], kind === "cluster" ? "Lieux regroupés" : "Lieu à visiter"),
    };
  }

  // Compatibility with discover_place_pins_in_bounds_v1 during rolling
  // deployments. Rich fields from the legacy response are intentionally
  // discarded before they reach the map source.
  if (!isRecord(value)) return null;
  const kind: PlacePinKind = value.kind === "cluster" ? "cluster" : "place";
  const id = stringValue(value.id).trim();
  const latitude = finiteNumber(value.latitude, Number.NaN);
  const longitude = finiteNumber(value.longitude, Number.NaN);
  if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    kind,
    id,
    name: stringValue(value.name, kind === "cluster" ? "Lieux regroupés" : "Lieu à visiter"),
    category: stringValue(value.category, kind === "cluster" ? "mixed" : "attraction"),
    latitude,
    longitude,
    count: Math.max(1, nonNegativeInteger(value.count, 1)),
  };
}

function parsePinBatch(value: unknown): PlaceMapPinBatch {
  if (!isRecord(value) || !Array.isArray(value.pins)) return EMPTY_PLACE_PIN_BATCH;
  const pins = value.pins.flatMap((pin) => {
    const parsed = parseCompactPin(pin);
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
    const parsed = parsePlace(item);
    return parsed ? [parsed] : [];
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
    _category_slugs: params.categories?.length ? [...new Set(params.categories)].sort() : null,
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

export function placeDiscoveryFilterKey(
  params: Pick<
    DiscoverPlaceParams,
    "categories" | "query" | "accessibleOnly" | "freeOnly" | "hasHoursOnly"
  >,
): string {
  return JSON.stringify({
    categories: [...new Set(params.categories ?? [])].sort(),
    query: params.query?.trim().toLocaleLowerCase() ?? "",
    accessibleOnly: params.accessibleOnly === true,
    freeOnly: params.freeOnly === true,
    hasHoursOnly: params.hasHoursOnly === true,
  });
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
      const request = (supabase as any).rpc("discover_place_pins_in_bounds_v2", args).retry(false);
      let { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error && ["42883", "PGRST202"].includes(error.code ?? "")) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fallback = (supabase as any).rpc("discover_place_pins_in_bounds_v1", args).retry(false);
        ({ data, error } = await (signal ? fallback.abortSignal(signal) : fallback));
      }
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
      const request = (supabase as any).rpc("discover_places_in_bounds_v1", args).retry(false);
      const { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error) throw error;
      return parseListBatch(data);
    },
    { signal },
  );
}

export async function discoverPlacesForHome(
  params: DiscoverHomePlaceParams,
  signal?: AbortSignal,
): Promise<PlaceListBatch> {
  const args = {
    _country_id: params.countryId ?? null,
    _region_id: params.regionId ?? null,
    _city_id: params.cityId ?? null,
    _category_slugs: params.categories?.length ? [...new Set(params.categories)].sort() : null,
    _query: params.query?.trim() || null,
    _accessible_only: params.accessibleOnly ?? false,
    _free_only: params.freeOnly ?? false,
    _has_hours_only: params.hasHoursOnly ?? false,
    _limit: Math.min(200, Math.max(1, params.limit ?? PLACE_LIST_PAGE_SIZE)),
    _offset: Math.max(0, params.offset ?? 0),
  };
  return runMapRequestWithRetry(
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const request = (supabase as any).rpc("discover_places_for_home_v1", args).retry(false);
      const { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error) throw error;
      return parseListBatch(data);
    },
    { signal },
  );
}

function readPlaceDetailCache(placeId: string): PlaceOfInterest | null {
  const entry = placeDetailCache.get(placeId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    placeDetailCache.delete(placeId);
    return null;
  }
  placeDetailCache.delete(placeId);
  placeDetailCache.set(placeId, entry);
  return entry.detail;
}

function writePlaceDetailCache(detail: PlaceOfInterest) {
  placeDetailCache.delete(detail.id);
  placeDetailCache.set(detail.id, {
    detail,
    expiresAt: Date.now() + PLACE_DETAIL_CACHE_TTL_MS,
  });
  while (placeDetailCache.size > PLACE_DETAIL_CACHE_LIMIT) {
    const oldestKey = placeDetailCache.keys().next().value;
    if (!oldestKey) break;
    placeDetailCache.delete(oldestKey);
  }
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function fetchPlaceDetail(
  placeId: string,
  signal?: AbortSignal,
): Promise<PlaceOfInterest | null> {
  const normalizedId = placeId.trim();
  if (!normalizedId) return null;
  const cached = readPlaceDetailCache(normalizedId);
  if (cached) return cached;

  let pending = placeDetailRequests.get(normalizedId);
  if (!pending) {
    pending = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .rpc("get_place_detail_v1", { _place_id: normalizedId })
        .retry(false);
      if (error) throw error;
      const parsed = parsePlace(data);
      if (parsed) writePlaceDetailCache(parsed);
      return parsed;
    })().finally(() => {
      placeDetailRequests.delete(normalizedId);
    });
    placeDetailRequests.set(normalizedId, pending);
  }

  return waitForSignal(pending, signal);
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
        latitude: pin.latitude,
        longitude: pin.longitude,
      },
    })),
  };
}

export function placeFromFeatureProperties(
  properties: Partial<PlaceFeatureProperties> | null | undefined,
): PlaceOfInterest | null {
  const id = typeof properties?.place_id === "string" ? properties.place_id.trim() : "";
  const latitude = finiteNumber(properties?.latitude, Number.NaN);
  const longitude = finiteNumber(properties?.longitude, Number.NaN);
  if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    id,
    name: stringValue(properties?.name, "Lieu à visiter"),
    slug: id,
    category: stringValue(properties?.category, "attraction"),
    subcategory: null,
    description: null,
    address: null,
    website: null,
    source_url: null,
    image_url: null,
    image_urls: [],
    booking_url: null,
    source_urls: [],
    content_sources: [],
    opening_hours: null,
    fee: null,
    wheelchair: null,
    latitude,
    longitude,
    quality_score: 0,
  };
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
