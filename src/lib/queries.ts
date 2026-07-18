import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { parseCompactMapPins, type CompactMapPin } from "@/lib/map-pins";
import {
  MAP_PREVIEW_QUERY_BATCH_SIZE,
  chunkOccurrenceIds,
  parseMapOccurrencePreviewRows,
  type MapOccurrencePreview,
} from "@/lib/map-occurrence-previews";

export type QuickRange =
  | "now"
  | "tonight"
  | "today"
  | "tomorrow"
  | "weekend"
  | "week"
  | "month"
  | "year";

/**
 * "Ce soir" = nuit événementielle 18h → 6h le lendemain (heure locale de l'utilisateur).
 * Retourne [from, to] en Date UTC.
 */
export function computeRange(range: QuickRange, base: Date = new Date()): { from: Date; to: Date } {
  const b = new Date(base);
  const day = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  switch (range) {
    case "now": {
      const to = new Date(b.getTime() + 2 * 60 * 60 * 1000);
      return { from: b, to };
    }
    case "tonight": {
      // 18h aujourd'hui → 6h demain
      const from = new Date(day);
      from.setHours(18, 0, 0, 0);
      const to = new Date(day);
      to.setDate(to.getDate() + 1);
      to.setHours(6, 0, 0, 0);
      // Si on est déjà passé 6h et avant 18h, "tonight" reste ce soir
      // Si on est après minuit et avant 6h, on affiche encore la nuit en cours
      if (b.getHours() < 6) {
        const yesterday = new Date(day);
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(18, 0, 0, 0);
        return { from: yesterday, to };
      }
      return { from: b > from ? b : from, to };
    }
    case "today": {
      const to = new Date(day);
      to.setDate(to.getDate() + 1);
      return { from: b, to };
    }
    case "tomorrow": {
      const from = new Date(day);
      from.setDate(from.getDate() + 1);
      const to = new Date(from);
      to.setDate(to.getDate() + 1);
      return { from, to };
    }
    case "weekend": {
      // Prochain vendredi 18h → dimanche 23h59
      const dow = b.getDay(); // 0=Sun
      const daysToFri = (5 - dow + 7) % 7;
      const from = new Date(day);
      from.setDate(from.getDate() + daysToFri);
      from.setHours(18, 0, 0, 0);
      const to = new Date(from);
      to.setDate(to.getDate() + 2);
      to.setHours(23, 59, 0, 0);
      return { from, to };
    }
    case "week": {
      const to = new Date(b.getTime() + 7 * 24 * 60 * 60 * 1000);
      return { from: b, to };
    }
    case "month": {
      const to = new Date(b.getTime() + 30 * 24 * 60 * 60 * 1000);
      return { from: b, to };
    }
    case "year": {
      const to = new Date(b.getTime() + 365 * 24 * 60 * 60 * 1000);
      return { from: b, to };
    }
  }
}

export interface DiscoverParams {
  lat?: number | null;
  lon?: number | null;
  radiusKm?: number;
  from?: Date;
  to?: Date;
  categorySlugs?: string[] | null;
  countryId?: string | null;
  regionId?: string | null;
  cityId?: string | null;
  freeOnly?: boolean;
  query?: string | null;
  genres?: string[] | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  pricedOnly?: boolean;
  capacityMin?: number | null;
  capacityMax?: number | null;
  capacityUnknown?: boolean;
  ticketsOnly?: boolean;
  verifiedOnly?: boolean;
  accessibleOnly?: boolean;
  venueOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface DiscoveredEvent {
  event_id: string;
  occurrence_id: string;
  venue_id: string | null;
  slug: string;
  title: string;
  short_description: string | null;
  cover_image_url: string | null;
  category_slug: string | null;
  genres: string[];
  starts_at: string;
  ends_at: string | null;
  timezone: string;
  venue_name: string | null;
  city_name: string | null;
  is_free: boolean;
  is_verified: boolean;
  is_demo: boolean;
  status: string;
  price_from: number | null;
  price_to: number | null;
  has_tickets: boolean;
  capacity: number | null;
  wheelchair: boolean;
  location_precision: "exact" | "venue" | "city";
  distance_km: number | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface DiscoveredVenue {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  city_name: string | null;
  capacity: number | null;
  is_verified: boolean;
  latitude: number;
  longitude: number;
  location_precision: "exact" | "city";
}

export interface DiscoveryStats {
  total_count: number;
  free_count: number;
  verified_count: number;
}

export interface CountryOption {
  id: string;
  code: string;
  name: string;
}

export interface RegionOption {
  id: string;
  country_id: string;
  name: string;
}

export interface CityOption {
  id: string;
  country_id: string;
  region_id: string | null;
  slug: string;
  name: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
}

export interface GeographyFilters {
  countryId?: string | null;
  regionId?: string | null;
  cityId?: string | null;
}

export interface CitySearchFilters extends GeographyFilters {
  query?: string | null;
  limit?: number;
}

function discoveryFilterArgs(p: DiscoverParams): Record<string, unknown> {
  const args: Record<string, unknown> = {
    _radius_km: p.radiusKm ?? 25,
    _from: (p.from ?? new Date()).toISOString(),
    _to: (p.to ?? new Date(Date.now() + 30 * 24 * 3600 * 1000)).toISOString(),
    _free_only: p.freeOnly ?? false,
    _priced_only: p.pricedOnly ?? false,
    _capacity_unknown: p.capacityUnknown ?? false,
    _tickets_only: p.ticketsOnly ?? false,
    _verified_only: p.verifiedOnly ?? false,
    _accessible_only: p.accessibleOnly ?? false,
    _venue_only: p.venueOnly ?? false,
  };
  if (p.lat != null) args._lat = p.lat;
  if (p.lon != null) args._lon = p.lon;
  if (p.categorySlugs?.length) args._category_slugs = p.categorySlugs;
  if (p.countryId) args._country_id = p.countryId;
  if (p.regionId) args._region_id = p.regionId;
  if (p.cityId) args._city_id = p.cityId;
  if (p.query?.trim()) args._query = p.query.trim();
  if (p.genres?.length) args._genres = p.genres;
  if (p.minPrice != null) args._price_min = p.minPrice;
  if (p.maxPrice != null) args._price_max = p.maxPrice;
  if (p.capacityMin != null) args._capacity_min = p.capacityMin;
  if (p.capacityMax != null) args._capacity_max = p.capacityMax;
  return args;
}

function discoveryArgs(p: DiscoverParams, defaultLimit: number): Record<string, unknown> {
  return {
    ...discoveryFilterArgs(p),
    _limit: p.limit ?? defaultLimit,
    _offset: p.offset ?? 0,
  };
}

export async function discoverEvents(p: DiscoverParams): Promise<DiscoveredEvent[]> {
  const args = discoveryArgs(p, 40);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc("discover_events", args as any);
  if (error) throw error;
  return (data ?? []) as DiscoveredEvent[];
}

export async function discoverMapEvents(p: DiscoverParams): Promise<DiscoveredEvent[]> {
  const args = discoveryArgs(p, 500);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("discover_map_events", args as any);
  if (error) throw error;
  return (data ?? []) as DiscoveredEvent[];
}

export async function discoverAllMapPins({
  from,
  to,
}: {
  from: Date;
  to: Date;
}): Promise<CompactMapPin[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("discover_all_map_pins_v1", {
    _from: from.toISOString(),
    _to: to.toISOString(),
  });
  if (error) throw error;
  return parseCompactMapPins(data);
}

export async function fetchMapOccurrencePreviews(
  occurrenceIds: string[],
  { includeDescription = false }: { includeDescription?: boolean } = {},
): Promise<MapOccurrencePreview[]> {
  if (!occurrenceIds.length) return [];
  const normalizedIds = chunkOccurrenceIds(occurrenceIds).flat();
  if (normalizedIds.length > MAP_PREVIEW_QUERY_BATCH_SIZE) {
    throw new RangeError(
      `At most ${MAP_PREVIEW_QUERY_BATCH_SIZE} occurrence previews can be requested at once`,
    );
  }

  const { data, error } = await supabase
    .from("event_occurrences")
    .select(
      includeDescription
        ? `
      id,
      starts_at,
      timezone,
      event:events!event_occurrences_event_id_fkey!inner(
        slug,
        title,
        short_description,
        description,
        cover_image_url,
        is_demo,
        status,
        venue:venues!events_venue_id_fkey(
          name,
          city:cities!venues_city_id_fkey(name)
        ),
        city:cities!events_city_id_fkey(name)
      )
    `
        : `
      id,
      starts_at,
      timezone,
      event:events!event_occurrences_event_id_fkey!inner(
        slug,
        title,
        short_description,
        cover_image_url,
        is_demo,
        status,
        venue:venues!events_venue_id_fkey(
          name,
          city:cities!venues_city_id_fkey(name)
        ),
        city:cities!events_city_id_fkey(name)
      )
    `,
    )
    .in("id", normalizedIds)
    .eq("event.is_demo", false)
    .in("event.status", ["published", "cancelled", "postponed", "sold_out"]);
  if (error) throw error;
  return parseMapOccurrencePreviewRows(data);
}

export async function discoverEventStats(
  p: DiscoverParams,
  { requireCoordinates = false }: { requireCoordinates?: boolean } = {},
): Promise<DiscoveryStats> {
  const args = {
    ...discoveryFilterArgs(p),
    _require_coordinates: requireCoordinates,
  } as Database["public"]["Functions"]["discover_event_stats_v1"]["Args"];
  const { data, error } = await supabase.rpc("discover_event_stats_v1", args);
  if (error) throw error;
  const row = (data?.[0] ?? {}) as Partial<Record<keyof DiscoveryStats, number | string>>;
  return {
    total_count: Number(row.total_count ?? 0),
    free_count: Number(row.free_count ?? 0),
    verified_count: Number(row.verified_count ?? 0),
  };
}

function coordinateOffset(id: string, axis: number) {
  let hash = 2166136261;
  for (let index = axis; index < id.length; index += 2) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4_294_967_295 - 0.5) * (axis === 0 ? 0.012 : 0.018);
}

type MapVenueRow = {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  capacity: number | null;
  is_verified: boolean;
  latitude: number | null;
  longitude: number | null;
  city_id: string;
  city_name: string;
  city_latitude: number | null;
  city_longitude: number | null;
};

export async function fetchMapVenues({
  countryId,
  regionId,
  cityId,
}: GeographyFilters = {}): Promise<DiscoveredVenue[]> {
  // Avoid downloading the complete worldwide venue catalogue when the map is
  // intentionally unscoped. Events remain pageable worldwide; venues appear
  // as soon as a country, subdivision or city is selected.
  if (!countryId && !regionId && !cityId) return [];

  const rows: MapVenueRow[] = [];
  const pageSize = 1_000;
  let offset = 0;

  while (true) {
    // The generated client types lag behind this migration until the next
    // schema generation, hence this intentionally narrow cast at the RPC edge.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("discover_venues_geography_v1", {
      _country_id: countryId ?? null,
      _region_id: regionId ?? null,
      _city_id: cityId ?? null,
      _limit: pageSize,
      _offset: offset,
    });
    if (error) throw error;
    const page = (data ?? []) as MapVenueRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return rows.flatMap((row) => {
    const exact = row.latitude != null && row.longitude != null;
    const latitude = exact
      ? Number(row.latitude)
      : row.city_latitude != null
        ? Number(row.city_latitude) + coordinateOffset(row.id, 0)
        : null;
    const longitude = exact
      ? Number(row.longitude)
      : row.city_longitude != null
        ? Number(row.city_longitude) + coordinateOffset(row.id, 1)
        : null;
    if (latitude == null || longitude == null) return [];
    return [
      {
        id: row.id,
        slug: row.slug,
        name: row.name,
        address: row.address,
        city_name: row.city_name,
        capacity: row.capacity,
        is_verified: row.is_verified,
        latitude,
        longitude,
        location_precision: exact ? ("exact" as const) : ("city" as const),
      },
    ];
  });
}

export async function searchGeographyCities({
  countryId,
  regionId,
  query,
  limit = 80,
}: CitySearchFilters = {}): Promise<CityOption[]> {
  // The generated database types intentionally lag behind migrations during
  // preview builds, so keep the cast at this single RPC boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("search_geography_cities", {
    _country_id: countryId ?? null,
    _region_id: regionId ?? null,
    _query: query?.trim() || null,
    _limit: Math.min(Math.max(limit, 1), 200),
  });
  if (error) throw error;
  return (data ?? []) as CityOption[];
}

/**
 * Complete city catalogue for the organizer's multi-city advertising picker.
 * Consumer-facing screens use searchGeographyCities and never pay this cost.
 */
export async function fetchCities() {
  const cities: CityOption[] = [];
  const pageSize = 1_000;
  for (let offset = 0; ; offset += pageSize) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("list_geography_cities", {
      _limit: pageSize,
      _offset: offset,
    });
    if (error) throw error;
    const page = (data ?? []) as CityOption[];
    cities.push(...page);
    if (page.length < pageSize) break;
  }
  return cities;
}

export async function fetchGeographies(): Promise<{
  countries: CountryOption[];
  regions: RegionOption[];
  cities: CityOption[];
}> {
  const [countriesResult, regionsResult, genevaCities] = await Promise.all([
    supabase.from("countries").select("id,code,name").order("name"),
    supabase.from("regions").select("id,country_id,name").order("name"),
    searchGeographyCities({ query: "Geneve", limit: 20 }),
  ]);
  const catalogueError = countriesResult.error ?? regionsResult.error;
  if (catalogueError) throw catalogueError;

  return {
    countries: (countriesResult.data ?? []) as CountryOption[],
    regions: (regionsResult.data ?? []) as RegionOption[],
    cities: genevaCities,
  };
}

export async function fetchCategories() {
  const { data, error } = await supabase.from("event_categories").select("*").order("sort_order");
  if (error) throw error;
  return data ?? [];
}

export async function fetchEventBySlug(slug: string) {
  const { data, error } = await supabase
    .from("events")
    .select(
      `
      *,
      category:event_categories(slug,name_fr,name_en,icon),
      organizer:organizers(id,slug,name,description,website,logo_url,is_verified),
      venue:venues(*, city:cities(slug,name,timezone)),
      occurrences:event_occurrences(*),
      offers:ticket_offers(*),
      media:event_media(*),
      accessibility:event_accessibility(*)
    `,
    )
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return data;
}
