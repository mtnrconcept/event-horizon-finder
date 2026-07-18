import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { parseCompactMapPins, type CompactMapPin } from "@/lib/map-pins";
import {
  attachMapOccurrenceDetailCollections,
  assertMapOccurrenceId,
  parseMapOccurrenceDetailRow,
  type MapOccurrenceDetailCollections,
  type MapOccurrenceDetail,
} from "@/lib/map-event-details";
import {
  MAP_PREVIEW_QUERY_BATCH_SIZE,
  chunkOccurrenceIds,
  parseMapOccurrencePreviewRows,
  type MapOccurrencePreview,
} from "@/lib/map-occurrence-previews";
import { loadAllPages } from "@/lib/load-all-pages";
import { normalizeMapViewportBounds, type MapViewportBounds } from "@/lib/map-viewport";

const MAP_OCCURRENCE_DETAIL_PAGE_SIZE = 500;

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

export interface DiscoverMapViewportParams extends Omit<
  DiscoverParams,
  "lat" | "lon" | "radiusKm" | "countryId" | "regionId" | "cityId"
> {
  bounds: MapViewportBounds;
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

function viewportDiscoveryArgs(
  p: DiscoverMapViewportParams,
  pagination: { limit: number; offset: number } | null,
): Record<string, unknown> {
  const bounds = normalizeMapViewportBounds(p.bounds);
  if (!bounds) throw new RangeError("Invalid map viewport bounds");

  const args = discoveryFilterArgs(p);
  delete args._radius_km;
  delete args._lat;
  delete args._lon;
  delete args._country_id;
  delete args._region_id;
  delete args._city_id;

  return {
    ...args,
    _west: bounds.west,
    _south: bounds.south,
    _east: bounds.east,
    _north: bounds.north,
    ...(pagination ? { _limit: pagination.limit, _offset: pagination.offset } : {}),
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

/** Returns every filtered pin inside the current map viewport in one compact response. */
export async function discoverMapPinsInBounds(
  p: DiscoverMapViewportParams,
): Promise<CompactMapPin[]> {
  const args = viewportDiscoveryArgs(p, null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("discover_map_pins_in_bounds_v1", args);
  if (error) throw error;
  return parseCompactMapPins(data);
}

/** Loads one stable page of rich list rows for the current visible map zone. */
export async function discoverMapEventsInBounds(
  p: DiscoverMapViewportParams,
): Promise<DiscoveredEvent[]> {
  const args = viewportDiscoveryArgs(p, {
    limit: p.limit ?? 1_000,
    offset: p.offset ?? 0,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("discover_map_events_in_bounds_v1", args);
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

async function fetchMapOccurrenceDetailCollections(
  eventId: string,
): Promise<MapOccurrenceDetailCollections> {
  const [occurrences, offers, media, performers] = await Promise.all([
    loadAllPages<{ id: string }>({
      pageSize: MAP_OCCURRENCE_DETAIL_PAGE_SIZE,
      getKey: (row) => row.id,
      fetchPage: async ({ limit, offset }) => {
        const { data, error } = await supabase
          .from("event_occurrences")
          .select(
            `
              id,
              starts_at,
              ends_at,
              doors_open_at,
              timezone,
              all_day,
              time_precision,
              local_start_date,
              local_end_date,
              status,
              ticket_status,
              capacity,
              latitude,
              longitude
            `,
          )
          .eq("event_id", eventId)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1);
        if (error) throw error;
        return data ?? [];
      },
    }),
    loadAllPages<{ id: string }>({
      pageSize: MAP_OCCURRENCE_DETAIL_PAGE_SIZE,
      getKey: (row) => row.id,
      fetchPage: async ({ limit, offset }) => {
        const { data, error } = await supabase
          .from("ticket_offers")
          .select("id,name,price_min,price_max,currency,is_free,ticket_url,status")
          .eq("event_id", eventId)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1);
        if (error) throw error;
        return data ?? [];
      },
    }),
    loadAllPages<{ id: string }>({
      pageSize: MAP_OCCURRENCE_DETAIL_PAGE_SIZE,
      getKey: (row) => row.id,
      fetchPage: async ({ limit, offset }) => {
        const { data, error } = await supabase
          .from("event_media")
          .select("id,url,media_type,attribution,license,source_url,sort_order")
          .eq("event_id", eventId)
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1);
        if (error) throw error;
        return data ?? [];
      },
    }),
    loadAllPages<{ performer_id: string }>({
      pageSize: MAP_OCCURRENCE_DETAIL_PAGE_SIZE,
      getKey: (row) => row.performer_id,
      fetchPage: async ({ limit, offset }) => {
        const { data, error } = await supabase
          .from("event_performers")
          .select(
            `
              performer_id,
              is_headliner,
              performer:performers!event_performers_performer_id_fkey(
                id,
                slug,
                name,
                type,
                bio,
                image_url
              )
            `,
          )
          .eq("event_id", eventId)
          .order("performer_id", { ascending: true })
          .range(offset, offset + limit - 1);
        if (error) throw error;
        return data ?? [];
      },
    }),
  ]);

  return { occurrences, offers, media, performers };
}

/**
 * Loads the complete public event record behind one map occurrence.
 *
 * This intentionally remains separate from the lightweight hover query: the
 * larger relation graph is downloaded only after a pin is opened. The cast is
 * kept at this query boundary until the generated Database type includes the
 * public event_scraped_details relation.
 */
export async function fetchMapOccurrenceDetail(
  occurrenceId: string,
): Promise<MapOccurrenceDetail | null> {
  const normalizedId = assertMapOccurrenceId(occurrenceId);
  const detailSelect = `
      id,
      starts_at,
      ends_at,
      doors_open_at,
      timezone,
      all_day,
      time_precision,
      local_start_date,
      local_end_date,
      status,
      ticket_status,
      capacity,
      latitude,
      longitude,
      event:events!event_occurrences_event_id_fkey!inner(
        id,
        slug,
        title,
        short_description,
        description,
        cover_image_url,
        official_url,
        age_restriction,
        genres,
        language,
        is_free,
        is_verified,
        is_demo,
        status,
        verification_level,
        category:event_categories!events_category_id_fkey(
          slug,
          name_fr,
          name_en,
          icon
        ),
        organizer:organizers!events_organizer_id_fkey(
          id,
          slug,
          name,
          description,
          website,
          logo_url,
          is_verified
        ),
        venue:venues!events_venue_id_fkey(
          id,
          slug,
          name,
          address,
          postal_code,
          description,
          capacity,
          website,
          cover_image_url,
          is_verified,
          latitude,
          longitude,
          city:cities!venues_city_id_fkey(
            id,
            slug,
            name,
            timezone,
            region:regions!cities_region_id_fkey(id,name),
            country:countries!cities_country_id_fkey(id,code,name)
          ),
          country:countries!venues_country_id_fkey(id,code,name)
        ),
        city:cities!events_city_id_fkey(
          id,
          slug,
          name,
          timezone,
          region:regions!cities_region_id_fkey(id,name),
          country:countries!cities_country_id_fkey(id,code,name)
        ),
        accessibility:event_accessibility!event_accessibility_event_id_fkey(
          wheelchair,
          hearing_loop,
          sign_language,
          quiet_space,
          notes
        ),
        scraped:event_scraped_details(details)
      )
    `;
  const runDetailQuery = (select: string) =>
    // Keep this cast at the boundary so a rolling deploy still works while
    // PostgREST refreshes the new public relation in its schema cache.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("event_occurrences")
      .select(select)
      .eq("id", normalizedId)
      .eq("event.is_demo", false)
      .in("event.status", ["published", "cancelled", "postponed", "sold_out"])
      .maybeSingle();

  let { data, error } = await runDetailQuery(detailSelect);
  if (error && ["42P01", "PGRST200", "PGRST205"].includes(error.code ?? "")) {
    ({ data, error } = await runDetailQuery(
      detailSelect.replace(",\n        scraped:event_scraped_details(details)", ""),
    ));
  }
  if (error) throw error;
  const baseDetail = parseMapOccurrenceDetailRow(data);
  if (!baseDetail) return null;

  const collections = await fetchMapOccurrenceDetailCollections(baseDetail.event_id);
  return (
    parseMapOccurrenceDetailRow(attachMapOccurrenceDetailCollections(data, collections)) ??
    baseDetail
  );
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
