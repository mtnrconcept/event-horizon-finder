import { supabase } from "@/integrations/supabase/client";

export interface VenueMedia {
  id: string;
  url: string;
  media_type: "image" | "logo";
  attribution: string | null;
  license: string | null;
  source_url: string | null;
  provider: string | null;
  is_primary: boolean;
}

export interface VenueSource {
  id: string;
  domain: string;
  external_identifier: string;
  source_url: string;
  source_name: string | null;
  attribution: string | null;
  last_seen_at: string;
}

export interface VenueEventSummary {
  id: string;
  slug: string;
  title: string;
  short_description: string | null;
  cover_image_url: string | null;
  is_free: boolean;
  status: string;
  starts_at: string;
  ends_at: string | null;
  timezone: string | null;
  category: { slug: string; name_fr: string } | null;
}

export interface VenueDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  address: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  website: string | null;
  cover_image_url: string | null;
  capacity: number | null;
  is_verified: boolean;
  city: {
    id: string | null;
    name: string | null;
    timezone: string | null;
    country_code: string | null;
    country_name: string | null;
  };
  media: VenueMedia[];
  sources: VenueSource[];
  upcoming_events: VenueEventSummary[];
  past_events: VenueEventSummary[];
}

export interface PlaceVenueContext {
  venue_id: string | null;
  venue_slug: string | null;
  upcoming_events: VenueEventSummary[];
}

type CacheEntry<T> = { value: T; expiresAt: number };

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 64;
const venueCache = new Map<string, CacheEntry<VenueDetail>>();
const venueRequests = new Map<string, Promise<VenueDetail | null>>();
const placeVenueCache = new Map<string, CacheEntry<PlaceVenueContext>>();
const placeVenueRequests = new Map<string, Promise<PlaceVenueContext>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function parseVenueEvent(value: unknown): VenueEventSummary | null {
  if (!isRecord(value)) return null;
  const id = nullableString(value.id);
  const slug = nullableString(value.slug);
  const title = nullableString(value.title);
  const startsAt = nullableString(value.starts_at);
  if (!id || !slug || !title || !startsAt) return null;
  const category = isRecord(value.category)
    ? {
        slug: stringValue(value.category.slug),
        name_fr: stringValue(value.category.name_fr),
      }
    : null;
  return {
    id,
    slug,
    title,
    short_description: nullableString(value.short_description),
    cover_image_url: nullableString(value.cover_image_url),
    is_free: booleanValue(value.is_free),
    status: stringValue(value.status, "published"),
    starts_at: startsAt,
    ends_at: nullableString(value.ends_at),
    timezone: nullableString(value.timezone),
    category: category?.slug ? category : null,
  };
}

function parseEventArray(value: unknown): VenueEventSummary[] {
  if (!Array.isArray(value)) return [];
  const events = value.flatMap((item) => {
    const parsed = parseVenueEvent(item);
    return parsed ? [parsed] : [];
  });
  return [...new Map(events.map((event) => [`${event.id}|${event.starts_at}`, event])).values()];
}

function parseVenueMedia(value: unknown): VenueMedia[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = nullableString(item.id);
    const url = nullableString(item.url);
    if (!id || !url) return [];
    return [
      {
        id,
        url,
        media_type: item.media_type === "logo" ? ("logo" as const) : ("image" as const),
        attribution: nullableString(item.attribution),
        license: nullableString(item.license),
        source_url: nullableString(item.source_url),
        provider: nullableString(item.provider),
        is_primary: booleanValue(item.is_primary),
      },
    ];
  });
}

function parseVenueSources(value: unknown): VenueSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = nullableString(item.id);
    const sourceUrl = nullableString(item.source_url);
    const domain = nullableString(item.domain);
    const externalIdentifier = nullableString(item.external_identifier);
    if (!id || !sourceUrl || !domain || !externalIdentifier) return [];
    return [
      {
        id,
        domain,
        external_identifier: externalIdentifier,
        source_url: sourceUrl,
        source_name: nullableString(item.source_name),
        attribution: nullableString(item.attribution),
        last_seen_at: nullableString(item.last_seen_at) ?? new Date(0).toISOString(),
      },
    ];
  });
}

function parseVenueDetail(value: unknown): VenueDetail | null {
  if (!isRecord(value)) return null;
  const id = nullableString(value.id);
  const slug = nullableString(value.slug);
  const name = nullableString(value.name);
  if (!id || !slug || !name) return null;
  const city = isRecord(value.city) ? value.city : {};
  return {
    id,
    slug,
    name,
    description: nullableString(value.description),
    address: nullableString(value.address),
    postal_code: nullableString(value.postal_code),
    latitude: nullableNumber(value.latitude),
    longitude: nullableNumber(value.longitude),
    website: nullableString(value.website),
    cover_image_url: nullableString(value.cover_image_url),
    capacity: nullableNumber(value.capacity),
    is_verified: booleanValue(value.is_verified),
    city: {
      id: nullableString(city.id),
      name: nullableString(city.name),
      timezone: nullableString(city.timezone),
      country_code: nullableString(city.country_code),
      country_name: nullableString(city.country_name),
    },
    media: parseVenueMedia(value.media),
    sources: parseVenueSources(value.sources),
    upcoming_events: parseEventArray(value.upcoming_events),
    past_events: parseEventArray(value.past_events),
  };
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export async function fetchVenueDetail(
  slug: string,
  signal?: AbortSignal,
): Promise<VenueDetail | null> {
  const normalizedSlug = slug.trim();
  if (!normalizedSlug) return null;
  const cached = readCache(venueCache, normalizedSlug);
  if (cached) return cached;
  const existing = venueRequests.get(normalizedSlug);
  if (existing) return existing;

  const request = (async () => {
    // Generated database types intentionally lag behind additive detail RPCs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (supabase as any)
      .rpc("get_venue_detail_v1", { _slug: normalizedSlug })
      .retry(false);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw error;
    const detail = parseVenueDetail(data);
    if (detail) writeCache(venueCache, normalizedSlug, detail);
    return detail;
  })();

  venueRequests.set(normalizedSlug, request);
  try {
    return await request;
  } finally {
    if (venueRequests.get(normalizedSlug) === request) venueRequests.delete(normalizedSlug);
  }
}

export async function fetchPlaceVenueContext(
  placeId: string,
  signal?: AbortSignal,
): Promise<PlaceVenueContext> {
  const normalizedId = placeId.trim();
  const empty: PlaceVenueContext = { venue_id: null, venue_slug: null, upcoming_events: [] };
  if (!normalizedId) return empty;
  const cached = readCache(placeVenueCache, normalizedId);
  if (cached) return cached;
  const existing = placeVenueRequests.get(normalizedId);
  if (existing) return existing;

  const request = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (supabase as any)
      .rpc("get_place_detail_v1", { _place_id: normalizedId })
      .retry(false);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw error;
    const record = isRecord(data) ? data : {};
    const context: PlaceVenueContext = {
      venue_id: nullableString(record.venue_id),
      venue_slug: nullableString(record.venue_slug),
      upcoming_events: parseEventArray(record.upcoming_events),
    };
    writeCache(placeVenueCache, normalizedId, context);
    return context;
  })();

  placeVenueRequests.set(normalizedId, request);
  try {
    return await request;
  } finally {
    if (placeVenueRequests.get(normalizedId) === request) placeVenueRequests.delete(normalizedId);
  }
}
