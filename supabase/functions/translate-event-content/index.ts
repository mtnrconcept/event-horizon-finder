import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  EVENT_TRANSLATION_LOCALES,
  applyDraftTranslations,
  buildEventTranslationDraft,
  splitTranslationText,
  type EventTranslationDraft,
  type EventTranslationLocale,
  type EventTranslationScope,
  type TranslationEventRow,
} from "../_shared/event-content-translation.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_EVENT_STATUSES = ["published", "cancelled", "postponed", "sold_out"];
const FAILED_RETRY_DELAY_MS = 5 * 60 * 1_000;
const MAX_DEEPL_TEXTS = 50;
const MAX_DEEPL_BATCH_BYTES = 80_000;
const encoder = new TextEncoder();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  Vary: "Origin",
};

type TranslationCacheRow = {
  event_id: string;
  locale: EventTranslationLocale;
  title: string;
  short_description: string | null;
  description: string | null;
  content: Record<string, unknown>;
  translation_scope: EventTranslationScope;
  translation_status: "pending" | "machine" | "reviewed" | "stale" | "failed";
  source_locale: string | null;
  provider: string | null;
  translated_at: string | null;
  updated_at: string;
  attempt_count: number;
};

type DeepLTranslation = {
  text?: unknown;
  detected_source_language?: unknown;
};

type DeepLResponse = {
  translations?: DeepLTranslation[];
  message?: unknown;
};

type TranslationSegment = {
  draftIndex: number;
  textIndex: number;
  segmentIndex: number;
  sourceLocale: string | null;
  text: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function targetLanguage(locale: EventTranslationLocale): string {
  return locale.toUpperCase();
}

function deepLApiUrl(key: string): string {
  const configured = Deno.env.get("DEEPL_API_URL")?.trim();
  if (configured) return configured;
  return key.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";
}

function validCachedTranslation(
  row: TranslationCacheRow,
  requestedScope: EventTranslationScope,
): boolean {
  return (
    (row.translation_status === "machine" || row.translation_status === "reviewed") &&
    (requestedScope === "summary" || row.translation_scope === "full")
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function clientHash(request: Request, salt: string): Promise<string> {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address =
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    forwarded ||
    "unknown";
  return sha256(`${salt}:${address}`);
}

function draftFingerprint(draft: EventTranslationDraft): string {
  return JSON.stringify({
    source_locale: draft.sourceLocale,
    scope: draft.scope,
    title: draft.title,
    short_description: draft.shortDescription,
    description: draft.description,
    content: draft.content,
  });
}

function segmentsForDrafts(drafts: EventTranslationDraft[]): TranslationSegment[] {
  return drafts.flatMap((draft, draftIndex) =>
    draft.texts.flatMap((item, textIndex) =>
      splitTranslationText(item.text).map((text, segmentIndex) => ({
        draftIndex,
        textIndex,
        segmentIndex,
        sourceLocale: draft.sourceLocale,
        text,
      })),
    ),
  );
}

function translationBatches(segments: TranslationSegment[]): TranslationSegment[][] {
  const batches: TranslationSegment[][] = [];
  let current: TranslationSegment[] = [];
  let currentBytes = 0;
  for (const segment of segments) {
    const bytes = encoder.encode(segment.text).byteLength + 16;
    if (
      current.length > 0 &&
      (current.length >= MAX_DEEPL_TEXTS || currentBytes + bytes > MAX_DEEPL_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(segment);
    currentBytes += bytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function requestDeepLBatch(
  batch: TranslationSegment[],
  locale: EventTranslationLocale,
  apiKey: string,
): Promise<Array<{ text: string; detectedSourceLocale: string | null }>> {
  const sourceLocale = batch[0]?.sourceLocale;
  const response = await fetch(deepLApiUrl(apiKey), {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: batch.map((item) => item.text),
      target_lang: targetLanguage(locale),
      ...(sourceLocale ? { source_lang: sourceLocale.toUpperCase() } : {}),
      preserve_formatting: true,
    }),
  });
  const responseText = await response.text();
  let payload: DeepLResponse = {};
  try {
    payload = responseText ? (JSON.parse(responseText) as DeepLResponse) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const message =
      typeof payload.message === "string"
        ? payload.message.slice(0, 500)
        : `DeepL returned HTTP ${response.status}`;
    throw new Error(message);
  }
  if (!Array.isArray(payload.translations) || payload.translations.length !== batch.length) {
    throw new Error("DeepL returned an incomplete translation batch");
  }
  return payload.translations.map((item) => {
    if (typeof item.text !== "string") throw new Error("DeepL returned an invalid translation");
    return {
      text: item.text,
      detectedSourceLocale:
        typeof item.detected_source_language === "string"
          ? item.detected_source_language.toLowerCase()
          : null,
    };
  });
}

async function translateDrafts(
  drafts: EventTranslationDraft[],
  locale: EventTranslationLocale,
  apiKey: string,
): Promise<Array<{ draft: EventTranslationDraft; detectedSourceLocale: string | null }>> {
  const segments = segmentsForDrafts(drafts);
  const translatedSegments = new Map<string, string>();
  const detectedLocales = new Map<number, string>();
  const providerSegments = segments.filter((segment) => segment.sourceLocale !== locale);

  for (const segment of segments) {
    if (segment.sourceLocale === locale) {
      translatedSegments.set(
        `${segment.draftIndex}:${segment.textIndex}:${segment.segmentIndex}`,
        segment.text,
      );
    }
  }

  const groups = new Map<string, TranslationSegment[]>();
  for (const segment of providerSegments) {
    const key = segment.sourceLocale ?? "auto";
    groups.set(key, [...(groups.get(key) ?? []), segment]);
  }

  for (const group of groups.values()) {
    for (const batch of translationBatches(group)) {
      const results = await requestDeepLBatch(batch, locale, apiKey);
      results.forEach((result, index) => {
        const segment = batch[index];
        translatedSegments.set(
          `${segment.draftIndex}:${segment.textIndex}:${segment.segmentIndex}`,
          result.text,
        );
        if (result.detectedSourceLocale) {
          detectedLocales.set(segment.draftIndex, result.detectedSourceLocale);
        }
      });
    }
  }

  return drafts.map((draft, draftIndex) => {
    const translatedTexts = draft.texts.map((item, textIndex) =>
      splitTranslationText(item.text)
        .map((_, segmentIndex) => {
          const value = translatedSegments.get(`${draftIndex}:${textIndex}:${segmentIndex}`);
          if (value == null) throw new Error("A translated segment is missing");
          return value;
        })
        .join(""),
    );
    return {
      draft: applyDraftTranslations(draft, translatedTexts),
      detectedSourceLocale: draft.sourceLocale ?? detectedLocales.get(draftIndex) ?? null,
    };
  });
}

function publicTranslation(row: TranslationCacheRow) {
  return {
    event_id: row.event_id,
    locale: row.locale,
    title: row.title,
    short_description: row.short_description,
    description: row.description,
    content: row.content ?? {},
    translation_scope: row.translation_scope,
    source_locale: row.source_locale,
    provider: row.provider,
    translated_at: row.translated_at,
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!request.headers.get("apikey")) return json({ error: "missing_api_key" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serverKey =
    Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serverKey) return json({ error: "service_not_configured" }, 503);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const locale = body.locale;
  const scope = body.scope === "full" ? "full" : "summary";
  const requestedIds = Array.isArray(body.event_ids) ? body.event_ids : [];
  if (
    typeof locale !== "string" ||
    !EVENT_TRANSLATION_LOCALES.includes(locale as EventTranslationLocale)
  ) {
    return json({ error: "unsupported_locale" }, 400);
  }
  const uniqueIds = [...new Set(requestedIds)];
  const maximumEvents = scope === "full" ? 1 : 20;
  if (
    uniqueIds.length < 1 ||
    uniqueIds.length > maximumEvents ||
    uniqueIds.some((value) => typeof value !== "string" || !UUID_PATTERN.test(value))
  ) {
    return json({ error: "invalid_event_ids", maximum: maximumEvents }, 400);
  }

  const targetLocale = locale as EventTranslationLocale;
  const admin = createClient(supabaseUrl, serverKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: cacheData, error: cacheError } = await admin
    .from("event_translations")
    .select(
      "event_id,locale,title,short_description,description,content,translation_scope,translation_status,source_locale,provider,translated_at,updated_at,attempt_count",
    )
    .eq("locale", targetLocale)
    .in("event_id", uniqueIds);
  if (cacheError) return json({ error: "translation_cache_unavailable" }, 503);

  const cacheRows = (cacheData ?? []) as TranslationCacheRow[];
  const validRows = cacheRows.filter((row) => validCachedTranslation(row, scope));
  const validIds = new Set(validRows.map((row) => row.event_id));
  const recentFailures = new Set(
    cacheRows
      .filter(
        (row) =>
          row.translation_status === "failed" &&
          Date.now() - Date.parse(row.updated_at) < FAILED_RETRY_DELAY_MS,
      )
      .map((row) => row.event_id),
  );
  const missingIds = uniqueIds.filter((id) => !validIds.has(id) && !recentFailures.has(id));

  if (!missingIds.length) {
    return json({
      translations: validRows.map(publicTranslation),
      pending_event_ids: uniqueIds.filter((id) => !validIds.has(id)),
      cache: "hit",
    });
  }

  const deepLKey = Deno.env.get("DEEPL_API_KEY")?.trim();
  if (!deepLKey) {
    return json({
      translations: validRows.map(publicTranslation),
      pending_event_ids: missingIds,
      cache: validRows.length ? "partial" : "miss",
      provider_configured: false,
    });
  }

  const summarySelect = `
    id,title,short_description,description,age_restriction,language,updated_at,
    venue:venues(id,name,description,updated_at)
  `;
  const fullSelect = `
    id,title,short_description,description,age_restriction,language,updated_at,
    venue:venues(id,name,description,updated_at),
    organizer:organizers(id,name,description,updated_at),
    accessibility:event_accessibility(notes),
    offers:ticket_offers(id,name),
    performers:event_performers(performer:performers(id,name,type,bio)),
    scraped:event_scraped_details(details)
  `;
  const { data: eventData, error: eventError } = await admin
    .from("events")
    .select(scope === "full" ? fullSelect : summarySelect)
    .in("id", missingIds)
    .eq("is_demo", false)
    .eq("publication_status", "published")
    .in("status", PUBLIC_EVENT_STATUSES);
  if (eventError) return json({ error: "event_content_unavailable" }, 503);

  const events = (eventData ?? []) as unknown as TranslationEventRow[];
  if (!events.length) {
    return json({ translations: validRows.map(publicTranslation), pending_event_ids: missingIds });
  }

  const salt = Deno.env.get("TRANSLATION_RATE_LIMIT_SALT") ?? serverKey.slice(-32);
  const hash = await clientHash(request, salt);
  const { data: quotaAccepted, error: quotaError } = await admin.rpc(
    "consume_event_translation_quota",
    {
      _client_hash: hash,
      _translated_event_count: events.length,
      _hourly_limit: 60,
    },
  );
  if (quotaError) return json({ error: "translation_quota_unavailable" }, 503);
  if (!quotaAccepted) {
    return json(
      {
        error: "translation_rate_limited",
        translations: validRows.map(publicTranslation),
        retry_after_seconds: 3600,
      },
      429,
    );
  }

  const drafts = events.map((event) => buildEventTranslationDraft(event, scope));
  const hashes = await Promise.all(drafts.map((draft) => sha256(draftFingerprint(draft))));

  try {
    const translated = await translateDrafts(drafts, targetLocale, deepLKey);
    const now = new Date().toISOString();
    const rows = translated.map(({ draft, detectedSourceLocale }, index) => ({
      event_id: draft.eventId,
      locale: targetLocale,
      title: draft.title,
      short_description: draft.shortDescription,
      description: draft.description,
      content: draft.content,
      translation_scope: draft.scope,
      source_hash: hashes[index],
      source_locale: detectedSourceLocale,
      provider: "deepl",
      provider_model: "v2/translate",
      translation_status: "machine",
      translated_at: now,
      last_error: null,
      attempt_count:
        (cacheRows.find((row) => row.event_id === draft.eventId)?.attempt_count ?? 0) + 1,
    }));
    const { data: stored, error: storeError } = await admin
      .from("event_translations")
      .upsert(rows, { onConflict: "event_id,locale" })
      .select(
        "event_id,locale,title,short_description,description,content,translation_scope,translation_status,source_locale,provider,translated_at,updated_at,attempt_count",
      );
    if (storeError) return json({ error: "translation_cache_write_failed" }, 503);
    return json({
      translations: [
        ...validRows.map(publicTranslation),
        ...((stored ?? []) as TranslationCacheRow[]).map(publicTranslation),
      ],
      pending_event_ids: [],
      cache: validRows.length ? "partial" : "miss",
      provider_configured: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "translation_failed";
    const failedRows = drafts.map((draft, index) => ({
      event_id: draft.eventId,
      locale: targetLocale,
      title: draft.title,
      short_description: draft.shortDescription,
      description: draft.description,
      content: draft.content,
      translation_scope: draft.scope,
      source_hash: hashes[index],
      source_locale: draft.sourceLocale,
      provider: "deepl",
      provider_model: "v2/translate",
      translation_status: "failed",
      translated_at: null,
      last_error: message,
      attempt_count:
        (cacheRows.find((row) => row.event_id === draft.eventId)?.attempt_count ?? 0) + 1,
    }));
    await admin.from("event_translations").upsert(failedRows, { onConflict: "event_id,locale" });
    return json(
      {
        error: "translation_provider_failed",
        translations: validRows.map(publicTranslation),
        pending_event_ids: drafts.map((draft) => draft.eventId),
      },
      502,
    );
  }
});
