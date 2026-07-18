import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { AppLocale } from "@/lib/i18n";
import type { DiscoveredEvent } from "@/lib/queries";
import type { MapOccurrencePreview } from "@/lib/map-occurrence-previews";
import type {
  MapOccurrenceDetail,
  MapScrapedDetails,
  MapScrapedValue,
} from "@/lib/map-event-details";

export type EventTranslationScope = "summary" | "full";

export type EventTranslationContent = {
  preview_description?: string | null;
  age_restriction?: string | null;
  venue?: { id?: string; name?: string | null; description?: string | null } | null;
  organizer?: { id?: string; name?: string | null; description?: string | null } | null;
  accessibility?: { notes?: string | null } | null;
  offers?: Record<string, { name?: string | null }>;
  performers?: Record<string, { name?: string | null; type?: string | null; bio?: string | null }>;
  scraped_details?: MapScrapedDetails | null;
};

export type EventContentTranslation = {
  event_id: string;
  locale: AppLocale;
  title: string;
  short_description: string | null;
  description: string | null;
  content: EventTranslationContent;
  translation_scope: EventTranslationScope;
  source_locale: string | null;
  provider: string | null;
  translated_at: string | null;
};

type TranslationResponse = {
  translations?: unknown;
  pending_event_ids?: unknown;
  provider_configured?: unknown;
};

type TranslationQueue = {
  eventIds: Set<string>;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NEGATIVE_CACHE_TTL_MS = 2 * 60 * 1_000;
const translationCache = new Map<string, EventContentTranslation>();
const negativeCache = new Map<string, number>();
const queues = new Map<string, TranslationQueue>();
const translationDb = supabase as unknown as SupabaseClient<Record<string, never>>;

function cacheKey(eventId: string, locale: AppLocale): string {
  return `${locale}:${eventId}`;
}

function scopeSatisfied(
  translation: EventContentTranslation | undefined,
  scope: EventTranslationScope,
): translation is EventContentTranslation {
  return Boolean(translation && (scope === "summary" || translation.translation_scope === "full"));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function scrapedValue(value: unknown, depth = 0): MapScrapedValue | undefined {
  if (depth > 20 || value == null || typeof value === "boolean") return value as null | boolean;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const result: MapScrapedValue[] = [];
    for (const item of value) {
      const parsed = scrapedValue(item, depth + 1);
      if (parsed !== undefined) result.push(parsed);
    }
    return result;
  }
  const object = objectValue(value);
  if (!object) return undefined;
  const result: Record<string, MapScrapedValue> = {};
  for (const [key, item] of Object.entries(object)) {
    const parsed = scrapedValue(item, depth + 1);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
}

function contentValue(value: unknown): EventTranslationContent {
  const content = objectValue(value) ?? {};
  const venue = objectValue(content.venue);
  const organizer = objectValue(content.organizer);
  const accessibility = objectValue(content.accessibility);
  const offers = objectValue(content.offers);
  const performers = objectValue(content.performers);
  const scraped = scrapedValue(content.scraped_details);

  return {
    preview_description: optionalString(content.preview_description),
    age_restriction: optionalString(content.age_restriction),
    venue: venue
      ? {
          id: optionalString(venue.id) ?? undefined,
          name: optionalString(venue.name),
          description: optionalString(venue.description),
        }
      : null,
    organizer: organizer
      ? {
          id: optionalString(organizer.id) ?? undefined,
          name: optionalString(organizer.name),
          description: optionalString(organizer.description),
        }
      : null,
    accessibility: accessibility ? { notes: optionalString(accessibility.notes) } : null,
    offers: Object.fromEntries(
      Object.entries(offers ?? {}).flatMap(([id, item]) => {
        const row = objectValue(item);
        return row ? [[id, { name: optionalString(row.name) }]] : [];
      }),
    ),
    performers: Object.fromEntries(
      Object.entries(performers ?? {}).flatMap(([id, item]) => {
        const row = objectValue(item);
        return row
          ? [
              [
                id,
                {
                  name: optionalString(row.name),
                  type: optionalString(row.type),
                  bio: optionalString(row.bio),
                },
              ],
            ]
          : [];
      }),
    ),
    scraped_details:
      scraped && typeof scraped === "object" && !Array.isArray(scraped)
        ? (scraped as MapScrapedDetails)
        : null,
  };
}

export function parseEventContentTranslation(value: unknown): EventContentTranslation | null {
  const row = objectValue(value);
  const scope = row?.translation_scope;
  const locale = row?.locale;
  if (
    !row ||
    typeof row.event_id !== "string" ||
    !UUID_PATTERN.test(row.event_id) ||
    !["fr", "en", "pl", "it", "ru", "es"].includes(String(locale)) ||
    (scope !== "summary" && scope !== "full") ||
    typeof row.title !== "string" ||
    !row.title.trim()
  ) {
    return null;
  }
  return {
    event_id: row.event_id,
    locale: locale as AppLocale,
    title: row.title,
    short_description: optionalString(row.short_description),
    description: optionalString(row.description),
    content: contentValue(row.content),
    translation_scope: scope,
    source_locale: optionalString(row.source_locale),
    provider: optionalString(row.provider),
    translated_at: optionalString(row.translated_at),
  };
}

function rememberTranslation(translation: EventContentTranslation): void {
  const key = cacheKey(translation.event_id, translation.locale);
  const current = translationCache.get(key);
  if (current?.translation_scope === "full" && translation.translation_scope === "summary") return;
  translationCache.set(key, translation);
  negativeCache.delete(key);
}

export function readEventContentTranslation(
  eventId: string,
  locale: AppLocale,
  scope: EventTranslationScope,
): EventContentTranslation | null {
  const translation = translationCache.get(cacheKey(eventId, locale));
  return scopeSatisfied(translation, scope) ? translation : null;
}

async function fetchTranslationRows(
  eventIds: string[],
  locale: AppLocale,
): Promise<EventContentTranslation[]> {
  if (!eventIds.length) return [];
  // The tables can be deployed before generated Database types are refreshed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (translationDb as SupabaseClient<any>)
    .from("event_translations")
    .select(
      "event_id,locale,title,short_description,description,content,translation_scope,source_locale,provider,translated_at",
    )
    .eq("locale", locale)
    .in("event_id", eventIds)
    .in("translation_status", ["machine", "reviewed"]);
  if (error) throw error;
  return (data ?? []).flatMap((row: unknown) => {
    const parsed = parseEventContentTranslation(row);
    return parsed ? [parsed] : [];
  });
}

async function invokeTranslationFunction(
  eventIds: string[],
  locale: AppLocale,
  scope: EventTranslationScope,
): Promise<EventContentTranslation[]> {
  const { data, error } = await supabase.functions.invoke<TranslationResponse>(
    "translate-event-content",
    { body: { event_ids: eventIds, locale, scope } },
  );
  if (error) throw error;
  if (!Array.isArray(data?.translations)) return [];
  return data.translations.flatMap((row) => {
    const parsed = parseEventContentTranslation(row);
    return parsed ? [parsed] : [];
  });
}

export async function getEventContentTranslations(
  values: readonly string[],
  locale: AppLocale,
  scope: EventTranslationScope = "summary",
): Promise<Map<string, EventContentTranslation>> {
  const eventIds = [...new Set(values.filter((value) => UUID_PATTERN.test(value)))];
  const result = new Map<string, EventContentTranslation>();
  const now = Date.now();
  let missing = eventIds.filter((eventId) => {
    const cached = readEventContentTranslation(eventId, locale, scope);
    if (cached) {
      result.set(eventId, cached);
      return false;
    }
    return (negativeCache.get(cacheKey(eventId, locale)) ?? 0) <= now;
  });

  if (missing.length) {
    try {
      const databaseRows = await fetchTranslationRows(missing, locale);
      databaseRows.forEach(rememberTranslation);
      missing = missing.filter((eventId) => {
        const cached = readEventContentTranslation(eventId, locale, scope);
        if (cached) result.set(eventId, cached);
        return !cached;
      });
    } catch {
      // A rolling deployment can briefly expose the UI before the migration.
    }
  }

  const batchSize = scope === "full" ? 1 : 20;
  for (let offset = 0; offset < missing.length; offset += batchSize) {
    const batch = missing.slice(offset, offset + batchSize);
    try {
      const translated = await invokeTranslationFunction(batch, locale, scope);
      translated.forEach(rememberTranslation);
    } catch {
      // Translation is progressive: source content stays visible on provider errors.
    }
    for (const eventId of batch) {
      const cached = readEventContentTranslation(eventId, locale, scope);
      if (cached) result.set(eventId, cached);
      else negativeCache.set(cacheKey(eventId, locale), Date.now() + NEGATIVE_CACHE_TTL_MS);
    }
  }

  return result;
}

function queueKey(locale: AppLocale, scope: EventTranslationScope): string {
  return `${locale}:${scope}`;
}

function flushTranslationQueue(locale: AppLocale, scope: EventTranslationScope): void {
  const key = queueKey(locale, scope);
  const queue = queues.get(key);
  if (!queue) return;
  queues.delete(key);
  void getEventContentTranslations([...queue.eventIds], locale, scope).finally(() => {
    queue.listeners.forEach((listener) => listener());
  });
}

function enqueueTranslations(
  eventIds: readonly string[],
  locale: AppLocale,
  scope: EventTranslationScope,
  listener: () => void,
): () => void {
  const key = queueKey(locale, scope);
  const queue = queues.get(key) ?? { eventIds: new Set(), listeners: new Set(), timer: null };
  eventIds.forEach((eventId) => queue.eventIds.add(eventId));
  queue.listeners.add(listener);
  if (!queue.timer) {
    queue.timer = setTimeout(() => flushTranslationQueue(locale, scope), 20);
  }
  queues.set(key, queue);
  return () => queue.listeners.delete(listener);
}

export function useEventContentTranslation(
  eventId: string | null | undefined,
  locale: AppLocale,
  scope: EventTranslationScope = "summary",
): EventContentTranslation | null {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!eventId || !UUID_PATTERN.test(eventId)) return;
    return enqueueTranslations([eventId], locale, scope, () => setRevision((value) => value + 1));
  }, [eventId, locale, scope]);
  void revision;
  return eventId ? readEventContentTranslation(eventId, locale, scope) : null;
}

export function useEventContentTranslations(
  eventIds: readonly string[],
  locale: AppLocale,
  scope: EventTranslationScope = "summary",
): Map<string, EventContentTranslation> {
  const stableIds = useMemo(
    () => [...new Set(eventIds.filter((id) => UUID_PATTERN.test(id)))],
    [eventIds],
  );
  const dependency = stableIds.join(",");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!stableIds.length) return;
    return enqueueTranslations(stableIds, locale, scope, () => setRevision((value) => value + 1));
    // `dependency` tracks the content rather than the caller's array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependency, locale, scope]);
  return useMemo(() => {
    const translations = new Map<string, EventContentTranslation>();
    stableIds.forEach((eventId) => {
      const translation = readEventContentTranslation(eventId, locale, scope);
      if (translation) translations.set(eventId, translation);
    });
    return translations;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependency, locale, revision, scope]);
}

export function applyTranslationToDiscoveredEvent(
  event: DiscoveredEvent,
  translation: EventContentTranslation | null | undefined,
): DiscoveredEvent {
  if (!translation) return event;
  return {
    ...event,
    title: translation.title,
    short_description: translation.short_description ?? event.short_description,
    venue_name: translation.content.venue?.name ?? event.venue_name,
  };
}

export function applyTranslationToMapPreview(
  preview: MapOccurrencePreview,
  translation: EventContentTranslation | null | undefined,
): MapOccurrencePreview {
  if (!translation) return preview;
  return {
    ...preview,
    title: translation.title,
    short_description: translation.short_description ?? preview.short_description,
    description:
      translation.description ?? translation.content.preview_description ?? preview.description,
    venue_name: translation.content.venue?.name ?? preview.venue_name,
  };
}

export function applyTranslationToMapDetail(
  detail: MapOccurrenceDetail,
  translation: EventContentTranslation | null | undefined,
): MapOccurrenceDetail {
  if (!translation) return detail;
  const content = translation.content;
  return {
    ...detail,
    title: translation.title,
    short_description: translation.short_description ?? detail.short_description,
    description: translation.description ?? detail.description,
    age_restriction: content.age_restriction ?? detail.age_restriction,
    venue: detail.venue
      ? {
          ...detail.venue,
          name: content.venue?.name ?? detail.venue.name,
          description: content.venue?.description ?? detail.venue.description,
        }
      : null,
    organizer: detail.organizer
      ? {
          ...detail.organizer,
          name: content.organizer?.name ?? detail.organizer.name,
          description: content.organizer?.description ?? detail.organizer.description,
        }
      : null,
    accessibility: detail.accessibility
      ? {
          ...detail.accessibility,
          notes: content.accessibility?.notes ?? detail.accessibility.notes,
        }
      : null,
    offers: detail.offers.map((offer) => ({
      ...offer,
      name: content.offers?.[offer.id]?.name ?? offer.name,
    })),
    performers: detail.performers.map((performer) => ({
      ...performer,
      name: content.performers?.[performer.id]?.name ?? performer.name,
      type: content.performers?.[performer.id]?.type ?? performer.type,
      bio: content.performers?.[performer.id]?.bio ?? performer.bio,
    })),
    scraped_details: content.scraped_details ?? detail.scraped_details,
  };
}

type PublicEventRecord = {
  id: string;
  title: string;
  short_description?: string | null;
  description?: string | null;
  age_restriction?: string | null;
  venue_name?: string | null;
  venue?: Record<string, unknown> | null;
  organizer?: Record<string, unknown> | null;
  offers?: Array<Record<string, unknown>> | null;
  accessibility?: Record<string, unknown> | Array<Record<string, unknown>> | null;
};

export function applyTranslationToEventRecord<T extends PublicEventRecord>(
  event: T,
  translation: EventContentTranslation | null | undefined,
): T {
  if (!translation) return event;
  const content = translation.content;
  const accessibility = Array.isArray(event.accessibility)
    ? event.accessibility.map((item, index) =>
        index === 0 ? { ...item, notes: content.accessibility?.notes ?? item.notes } : item,
      )
    : event.accessibility
      ? { ...event.accessibility, notes: content.accessibility?.notes ?? event.accessibility.notes }
      : event.accessibility;
  return {
    ...event,
    title: translation.title,
    short_description: translation.short_description ?? event.short_description,
    description: translation.description ?? event.description,
    age_restriction: content.age_restriction ?? event.age_restriction,
    venue_name: content.venue?.name ?? event.venue_name,
    venue: event.venue
      ? {
          ...event.venue,
          name: content.venue?.name ?? event.venue.name,
          description: content.venue?.description ?? event.venue.description,
        }
      : event.venue,
    organizer: event.organizer
      ? {
          ...event.organizer,
          name: content.organizer?.name ?? event.organizer.name,
          description: content.organizer?.description ?? event.organizer.description,
        }
      : event.organizer,
    offers: event.offers?.map((offer) => {
      const id = typeof offer.id === "string" ? offer.id : "";
      return { ...offer, name: content.offers?.[id]?.name ?? offer.name };
    }),
    accessibility,
  } as T;
}

export function clearEventContentTranslationMemoryCache(): void {
  translationCache.clear();
  negativeCache.clear();
}
