import { supabase } from "@/integrations/supabase/client";

export type QuickRange =
  "now" | "tonight" | "today" | "tomorrow" | "weekend" | "week" | "month" | "year";

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

function discoveryArgs(p: DiscoverParams, defaultLimit: number): Record<string, unknown> {
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
    _limit: p.limit ?? defaultLimit,
    _offset: p.offset ?? 0,
  };
  if (p.lat != null) args._lat = p.lat;
  if (p.lon != null) args._lon = p.lon;
  if (p.categorySlugs?.length) args._category_slugs = p.categorySlugs;
  if (p.cityId) args._city_id = p.cityId;
  if (p.query?.trim()) args._query = p.query.trim();
  if (p.genres?.length) args._genres = p.genres;
  if (p.minPrice != null) args._price_min = p.minPrice;
  if (p.maxPrice != null) args._price_max = p.maxPrice;
  if (p.capacityMin != null) args._capacity_min = p.capacityMin;
  if (p.capacityMax != null) args._capacity_max = p.capacityMax;
  return args;
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

function coordinateOffset(id: string, axis: number) {
  let hash = 2166136261;
  for (let index = axis; index < id.length; index += 2) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4_294_967_295 - 0.5) * (axis === 0 ? 0.012 : 0.018);
}

export async function fetchMapVenues(cityId?: string | null): Promise<DiscoveredVenue[]> {
  let query = supabase
    .from("venues")
    .select(
      "id,slug,name,address,capacity,is_verified,latitude,longitude,city_id,city:cities(id,name,latitude,longitude)",
    )
    .eq("is_public", true)
    .eq("is_demo", false)
    .order("name")
    .limit(1000);
  if (cityId) query = query.eq("city_id", cityId);
  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).flatMap((row) => {
    const city = Array.isArray(row.city) ? row.city[0] : row.city;
    const exact = row.latitude != null && row.longitude != null;
    const latitude = exact
      ? Number(row.latitude)
      : city?.latitude != null
        ? Number(city.latitude) + coordinateOffset(row.id, 0)
        : null;
    const longitude = exact
      ? Number(row.longitude)
      : city?.longitude != null
        ? Number(city.longitude) + coordinateOffset(row.id, 1)
        : null;
    if (latitude == null || longitude == null) return [];
    return [
      {
        id: row.id,
        slug: row.slug,
        name: row.name,
        address: row.address,
        city_name: city?.name ?? null,
        capacity: row.capacity,
        is_verified: row.is_verified,
        latitude,
        longitude,
        location_precision: exact ? ("exact" as const) : ("city" as const),
      },
    ];
  });
}

export async function fetchCities() {
  const { data, error } = await supabase
    .from("cities")
    .select("id,slug,name,timezone,latitude,longitude,is_demo")
    .order("name");
  if (error) throw error;
  return data ?? [];
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
