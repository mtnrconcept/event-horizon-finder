const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_COLLECTION_SIZE = 2_000;
const MAX_JSON_TEXT_LENGTH = 500_000;
const PRICE_FORMATTERS = new Map<string, Intl.NumberFormat>();

export type MapScrapedValue =
  string | number | boolean | null | MapScrapedValue[] | { [key: string]: MapScrapedValue };

export type MapScrapedDetails = Record<string, MapScrapedValue>;

export interface MapOccurrenceDetailCollections {
  occurrences: readonly unknown[];
  offers: readonly unknown[];
  media: readonly unknown[];
  performers: readonly unknown[];
}

export interface MapDetailOccurrence {
  id: string;
  starts_at: string;
  ends_at: string | null;
  doors_open_at: string | null;
  timezone: string;
  all_day: boolean;
  time_precision: string | null;
  local_start_date: string | null;
  local_end_date: string | null;
  status: string | null;
  ticket_status: string | null;
  capacity: number | null;
  latitude: number | null;
  longitude: number | null;
}

export interface MapDetailCountry {
  id: string;
  code: string;
  name: string;
}

export interface MapDetailRegion {
  id: string;
  name: string;
}

export interface MapDetailCity {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  region: MapDetailRegion | null;
  country: MapDetailCountry | null;
}

export interface MapDetailCategory {
  slug: string;
  name_fr: string;
  name_en: string;
  icon: string | null;
}

export interface MapDetailVenue {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  postal_code: string | null;
  description: string | null;
  capacity: number | null;
  website: string | null;
  cover_image_url: string | null;
  is_verified: boolean;
  latitude: number | null;
  longitude: number | null;
  city: MapDetailCity | null;
  country: MapDetailCountry | null;
}

export interface MapDetailOrganizer {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  website: string | null;
  logo_url: string | null;
  is_verified: boolean;
}

export interface MapDetailOffer {
  id: string;
  name: string;
  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  is_free: boolean;
  ticket_url: string | null;
  status: string | null;
}

export interface MapDetailMedia {
  id: string;
  url: string;
  media_type: string;
  attribution: string | null;
  license: string | null;
  source_url: string | null;
  sort_order: number | null;
}

export interface MapDetailAccessibility {
  wheelchair: boolean | null;
  hearing_loop: boolean | null;
  sign_language: boolean | null;
  quiet_space: boolean | null;
  notes: string | null;
}

export interface MapDetailPerformer {
  id: string;
  slug: string;
  name: string;
  type: string | null;
  bio: string | null;
  image_url: string | null;
  is_headliner: boolean;
}

export interface MapOccurrenceDetail {
  occurrence_id: string;
  selected_occurrence: MapDetailOccurrence;
  event_id: string;
  slug: string;
  title: string;
  short_description: string | null;
  description: string | null;
  cover_image_url: string | null;
  official_url: string | null;
  age_restriction: string | null;
  genres: string[];
  language: string | null;
  is_free: boolean;
  is_verified: boolean;
  status: string;
  verification_level: string | null;
  category: MapDetailCategory | null;
  organizer: MapDetailOrganizer | null;
  venue: MapDetailVenue | null;
  city: MapDetailCity | null;
  occurrences: MapDetailOccurrence[];
  offers: MapDetailOffer[];
  media: MapDetailMedia[];
  accessibility: MapDetailAccessibility | null;
  performers: MapDetailPerformer[];
  scraped_details: MapScrapedDetails | null;
  uses_publication_projection: boolean;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function relationObject(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return objectValue(value[0]);
  return objectValue(value);
}

function relationValues(value: unknown): Record<string, unknown>[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.flatMap((item) => {
    const row = objectValue(item);
    return row ? [row] : [];
  });
}

/**
 * Adds separately paginated one-to-many relations to the lightweight detail
 * response without mutating the cached PostgREST payload.
 */
export function attachMapOccurrenceDetailCollections(
  value: unknown,
  collections: MapOccurrenceDetailCollections,
): unknown {
  const row = objectValue(value);
  const eventValue = row?.event;
  const event = relationObject(eventValue);
  if (!row || !event) return value;

  const attachedEvent = {
    ...event,
    occurrences: [...collections.occurrences],
    offers: [...collections.offers],
    media: [...collections.media],
    performers: [...collections.performers],
  };

  return {
    ...row,
    event: Array.isArray(eventValue) ? [attachedEvent, ...eventValue.slice(1)] : attachedEvent,
  };
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown): string | null {
  return requiredString(value);
}

function optionalTimestamp(value: unknown): string | null {
  const text = optionalString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function optionalLocalDate(value: unknown): string | null {
  const text = optionalString(value);
  return text && LOCAL_DATE_PATTERN.test(text) ? text : null;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const known = new Set<string>();
  for (const item of value) {
    const text = optionalString(item);
    if (!text || known.has(text)) continue;
    known.add(text);
    result.push(text);
  }
  return result;
}

type JsonBudget = { nodes: number; textLength: number };

function jsonValue(
  value: unknown,
  depth = 0,
  budget: JsonBudget = { nodes: 0, textLength: 0 },
): MapScrapedValue | undefined {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    budget.textLength += value.length;
    return budget.textLength <= MAX_JSON_TEXT_LENGTH ? value : undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (depth >= MAX_JSON_DEPTH) return undefined;
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_COLLECTION_SIZE) return undefined;
    const result: MapScrapedValue[] = [];
    for (const item of value) {
      const parsed = jsonValue(item, depth + 1, budget);
      if (parsed === undefined) return undefined;
      result.push(parsed);
    }
    return result;
  }
  const row = objectValue(value);
  if (!row) return undefined;
  if (Object.keys(row).length > MAX_JSON_COLLECTION_SIZE) return undefined;
  const entries: Array<[string, MapScrapedValue]> = [];
  for (const [key, item] of Object.entries(row)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
    const parsed = jsonValue(item, depth + 1, budget);
    if (parsed === undefined) return undefined;
    entries.push([key, parsed]);
  }
  return Object.fromEntries(entries);
}

function scrapedDetails(value: unknown): MapScrapedDetails | null {
  const parsed = jsonValue(value);
  return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed : null;
}

/** Accept only absolute HTTP(S) links before rendering them in anchors or media. */
export function safeExternalUrl(value: unknown): string | null {
  const text = optionalString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function assertMapOccurrenceId(value: string): string {
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) throw new TypeError("Invalid occurrence id");
  return normalized;
}

function parseCountry(value: unknown): MapDetailCountry | null {
  const row = relationObject(value);
  const code = requiredString(row?.code);
  const name = requiredString(row?.name);
  if (!row || !validUuid(row.id) || !code || !name) return null;
  return { id: row.id, code, name };
}

function parseRegion(value: unknown): MapDetailRegion | null {
  const row = relationObject(value);
  const name = requiredString(row?.name);
  if (!row || !validUuid(row.id) || !name) return null;
  return { id: row.id, name };
}

function parseCity(value: unknown): MapDetailCity | null {
  const row = relationObject(value);
  const slug = requiredString(row?.slug);
  const name = requiredString(row?.name);
  const timezone = requiredString(row?.timezone);
  if (!row || !validUuid(row.id) || !slug || !name || !timezone) return null;
  return {
    id: row.id,
    slug,
    name,
    timezone,
    region: parseRegion(row.region),
    country: parseCountry(row.country),
  };
}

function parseCategory(value: unknown): MapDetailCategory | null {
  const row = relationObject(value);
  const slug = requiredString(row?.slug);
  const nameFr = requiredString(row?.name_fr);
  const nameEn = requiredString(row?.name_en);
  if (!row || !slug || !nameFr || !nameEn) return null;
  return { slug, name_fr: nameFr, name_en: nameEn, icon: optionalString(row.icon) };
}

function parseVenue(value: unknown): MapDetailVenue | null {
  const row = relationObject(value);
  const slug = requiredString(row?.slug);
  const name = requiredString(row?.name);
  if (!row || !validUuid(row.id) || !slug || !name) return null;
  return {
    id: row.id,
    slug,
    name,
    address: optionalString(row.address),
    postal_code: optionalString(row.postal_code),
    description: optionalString(row.description),
    capacity: optionalNumber(row.capacity),
    website: safeExternalUrl(row.website),
    cover_image_url: safeExternalUrl(row.cover_image_url),
    is_verified: optionalBoolean(row.is_verified) ?? false,
    latitude: optionalNumber(row.latitude),
    longitude: optionalNumber(row.longitude),
    city: parseCity(row.city),
    country: parseCountry(row.country),
  };
}

function parseOrganizer(value: unknown): MapDetailOrganizer | null {
  const row = relationObject(value);
  const slug = requiredString(row?.slug);
  const name = requiredString(row?.name);
  if (!row || !validUuid(row.id) || !slug || !name) return null;
  return {
    id: row.id,
    slug,
    name,
    description: optionalString(row.description),
    website: safeExternalUrl(row.website),
    logo_url: safeExternalUrl(row.logo_url),
    is_verified: optionalBoolean(row.is_verified) ?? false,
  };
}

function parseOccurrence(value: unknown): MapDetailOccurrence | null {
  const row = objectValue(value);
  const startsAt = optionalTimestamp(row?.starts_at);
  const timezone = requiredString(row?.timezone);
  if (!row || !validUuid(row.id) || !startsAt || !timezone) return null;
  return {
    id: row.id,
    starts_at: startsAt,
    ends_at: optionalTimestamp(row.ends_at),
    doors_open_at: optionalTimestamp(row.doors_open_at),
    timezone,
    all_day: optionalBoolean(row.all_day) ?? false,
    time_precision: optionalString(row.time_precision),
    local_start_date: optionalLocalDate(row.local_start_date),
    local_end_date: optionalLocalDate(row.local_end_date),
    status: optionalString(row.status),
    ticket_status: optionalString(row.ticket_status),
    capacity: optionalNumber(row.capacity),
    latitude: optionalNumber(row.latitude),
    longitude: optionalNumber(row.longitude),
  };
}

function parseOffer(value: unknown): MapDetailOffer | null {
  const row = objectValue(value);
  const name = requiredString(row?.name);
  if (!row || !validUuid(row.id) || !name) return null;
  return {
    id: row.id,
    name,
    price_min: optionalNumber(row.price_min),
    price_max: optionalNumber(row.price_max),
    currency: optionalString(row.currency)?.toUpperCase() ?? null,
    is_free: optionalBoolean(row.is_free) ?? false,
    ticket_url: safeExternalUrl(row.ticket_url),
    status: optionalString(row.status),
  };
}

function parseMedia(value: unknown): MapDetailMedia | null {
  const row = objectValue(value);
  const url = safeExternalUrl(row?.url);
  const mediaType = requiredString(row?.media_type);
  if (!row || !validUuid(row.id) || !url || !mediaType) return null;
  return {
    id: row.id,
    url,
    media_type: mediaType,
    attribution: optionalString(row.attribution),
    license: optionalString(row.license),
    source_url: safeExternalUrl(row.source_url),
    sort_order: optionalNumber(row.sort_order),
  };
}

function parseAccessibility(value: unknown): MapDetailAccessibility | null {
  const row = relationObject(value);
  if (!row) return null;
  return {
    wheelchair: optionalBoolean(row.wheelchair),
    hearing_loop: optionalBoolean(row.hearing_loop),
    sign_language: optionalBoolean(row.sign_language),
    quiet_space: optionalBoolean(row.quiet_space),
    notes: optionalString(row.notes),
  };
}

function parsePerformer(value: unknown): MapDetailPerformer | null {
  const link = objectValue(value);
  const row = relationObject(link?.performer);
  const slug = requiredString(row?.slug);
  const name = requiredString(row?.name);
  if (!row || !validUuid(row.id) || !slug || !name) return null;
  return {
    id: row.id,
    slug,
    name,
    type: optionalString(row.type),
    bio: optionalString(row.bio),
    image_url: safeExternalUrl(row.image_url),
    is_headliner: optionalBoolean(link?.is_headliner) ?? false,
  };
}

function byText(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

function sortOccurrences(values: MapDetailOccurrence[]): MapDetailOccurrence[] {
  return values.sort(
    (left, right) => byText(left.starts_at, right.starts_at) || byText(left.id, right.id),
  );
}

function sortOffers(values: MapDetailOffer[]): MapDetailOffer[] {
  return values.sort(
    (left, right) =>
      Number(right.is_free) - Number(left.is_free) ||
      (left.price_min ?? Number.POSITIVE_INFINITY) -
        (right.price_min ?? Number.POSITIVE_INFINITY) ||
      byText(left.name, right.name) ||
      byText(left.id, right.id),
  );
}

function sortMedia(values: MapDetailMedia[]): MapDetailMedia[] {
  return values.sort(
    (left, right) =>
      (left.sort_order ?? Number.POSITIVE_INFINITY) -
        (right.sort_order ?? Number.POSITIVE_INFINITY) ||
      byText(left.media_type, right.media_type) ||
      byText(left.id, right.id),
  );
}

function sortPerformers(values: MapDetailPerformer[]): MapDetailPerformer[] {
  return values.sort(
    (left, right) =>
      Number(right.is_headliner) - Number(left.is_headliner) ||
      byText(left.name, right.name) ||
      byText(left.id, right.id),
  );
}

export function parseMapOccurrenceDetailRow(value: unknown): MapOccurrenceDetail | null {
  const row = objectValue(value);
  const selectedOccurrence = parseOccurrence(row);
  const event = relationObject(row?.event);
  const slug = requiredString(event?.slug);
  const title = requiredString(event?.title);
  const status = requiredString(event?.status);
  if (!row || !selectedOccurrence || !event || !validUuid(event.id) || !slug || !title || !status) {
    return null;
  }

  const occurrences = relationValues(event.occurrences)
    .map(parseOccurrence)
    .filter((item): item is MapDetailOccurrence => item !== null);
  if (!occurrences.some((occurrence) => occurrence.id === selectedOccurrence.id)) {
    occurrences.push(selectedOccurrence);
  }
  const publication = relationObject(event.publication);
  const usesPublicationProjection =
    optionalBoolean(publication?.is_active) === true &&
    (optionalNumber(publication?.projection_version) ?? 0) >= 2;
  const sourceVenue = parseVenue(event.venue);
  const venue =
    usesPublicationProjection && sourceVenue
      ? { ...sourceVenue, description: null, cover_image_url: null }
      : sourceVenue;
  const sourceOrganizer = parseOrganizer(event.organizer);
  const organizer =
    usesPublicationProjection && sourceOrganizer
      ? { ...sourceOrganizer, description: null, logo_url: null }
      : sourceOrganizer;
  const performers = sortPerformers(
    relationValues(event.performers)
      .map(parsePerformer)
      .filter((item): item is MapDetailPerformer => item !== null),
  ).map((performer) =>
    usesPublicationProjection ? { ...performer, bio: null, image_url: null } : performer,
  );

  return {
    occurrence_id: selectedOccurrence.id,
    selected_occurrence: selectedOccurrence,
    event_id: event.id,
    slug,
    title,
    short_description: optionalString(
      usesPublicationProjection ? publication?.short_description : event.short_description,
    ),
    description: optionalString(
      usesPublicationProjection ? publication?.description : event.description,
    ),
    cover_image_url: safeExternalUrl(
      usesPublicationProjection ? publication?.cover_image_url : event.cover_image_url,
    ),
    official_url: safeExternalUrl(event.official_url),
    age_restriction: optionalString(event.age_restriction),
    genres: stringList(event.genres),
    language: optionalString(event.language),
    is_free: optionalBoolean(event.is_free) ?? false,
    is_verified: optionalBoolean(event.is_verified) ?? false,
    status,
    verification_level: optionalString(event.verification_level),
    category: parseCategory(event.category),
    organizer,
    venue,
    city: parseCity(event.city) ?? venue?.city ?? null,
    occurrences: sortOccurrences(occurrences),
    offers: sortOffers(
      relationValues(event.offers)
        .map(parseOffer)
        .filter((item): item is MapDetailOffer => item !== null),
    ),
    media: sortMedia(
      relationValues(event.media)
        .map(parseMedia)
        .filter((item): item is MapDetailMedia => item !== null),
    ),
    accessibility: parseAccessibility(event.accessibility),
    performers,
    scraped_details: scrapedDetails(publication?.details),
    uses_publication_projection: usesPublicationProjection,
  };
}

export function formatMapDetailPrice(
  offer: Pick<MapDetailOffer, "price_min" | "price_max" | "currency" | "is_free">,
  locale = "fr-FR",
  freeLabel = "Gratuit",
): string | null {
  if (offer.is_free) return freeLabel;
  if (offer.price_min == null && offer.price_max == null) return null;
  let formatter = PRICE_FORMATTERS.get(locale);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    } catch {
      formatter = PRICE_FORMATTERS.get("fr-FR");
      if (!formatter) {
        formatter = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
        PRICE_FORMATTERS.set("fr-FR", formatter);
      }
    }
    PRICE_FORMATTERS.set(locale, formatter);
  }
  const minimum = offer.price_min == null ? null : formatter.format(offer.price_min);
  const maximum = offer.price_max == null ? null : formatter.format(offer.price_max);
  const amount =
    minimum && maximum && minimum !== maximum ? `${minimum} – ${maximum}` : (minimum ?? maximum);
  const currency = offer.currency?.trim().toUpperCase();
  return amount
    ? `${amount}${currency && CURRENCY_PATTERN.test(currency) ? ` ${currency}` : ""}`
    : null;
}

export function mapDetailLocationParts(detail: MapOccurrenceDetail): string[] {
  const venue = detail.venue;
  const city = venue?.city ?? detail.city;
  const country = city?.country ?? venue?.country;
  const values = [
    venue?.name,
    venue?.address,
    [venue?.postal_code, city?.name].filter(Boolean).join(" ") || null,
    city?.region?.name,
    country?.name,
  ];
  const result: string[] = [];
  for (const value of values) {
    if (!value || result.includes(value)) continue;
    result.push(value);
  }
  return result;
}
