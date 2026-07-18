export const EVENT_TRANSLATION_LOCALES = ["fr", "en", "pl", "it", "ru", "es"] as const;
export type EventTranslationLocale = (typeof EVENT_TRANSLATION_LOCALES)[number];
export type EventTranslationScope = "summary" | "full";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type Relation<T> = T | T[] | null;

export type TranslationEventRow = {
  id: string;
  title: string;
  short_description: string | null;
  description: string | null;
  age_restriction: string | null;
  language: string | null;
  updated_at: string;
  venue: Relation<{
    id: string;
    name: string;
    description: string | null;
    updated_at: string;
  }>;
  organizer: Relation<{
    id: string;
    name: string;
    description: string | null;
    updated_at: string;
  }>;
  accessibility: Relation<{ notes: string | null }>;
  offers: Array<{ id: string; name: string }> | null;
  performers: Array<{
    performer: Relation<{
      id: string;
      name: string;
      type: string | null;
      bio: string | null;
    }>;
  }> | null;
  scraped: Relation<{ details: JsonValue }>;
};

export type TranslationPath = Array<string | number>;

export type TranslationText = {
  path: TranslationPath;
  text: string;
};

export type EventTranslationDraft = {
  eventId: string;
  sourceLocale: string | null;
  scope: EventTranslationScope;
  title: string;
  shortDescription: string | null;
  description: string | null;
  content: Record<string, JsonValue>;
  texts: TranslationText[];
};

const SKIPPED_KEY_PATTERN =
  /(?:^|_)(?:id|uuid|url|uri|link|href|email|phone|telephone|fax|hash|checksum|token|slug|timezone|currency|country_code|language_code|latitude|longitude|coordinates?|image|photo|video|website|source)(?:_|$)/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const URL_PATTERN = /^(?:https?:\/\/|www\.)\S+$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_VALUE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const CLOCK_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const CODE_PATTERN = /^[A-Z0-9_-]{1,5}$/;

function firstRelation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replaceAll("\u0000", "").trim();
  return text || null;
}

/** Converts source HTML into the plain text that the public event views render. */
export function plainTranslationText(value: string): string {
  return value
    .replace(/<(?:br|hr)\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isTranslatableScrapedText(key: string, value: string): boolean {
  const text = plainTranslationText(value);
  if (!text || text.length < 2 || SKIPPED_KEY_PATTERN.test(key)) return false;
  if (
    URL_PATTERN.test(text) ||
    EMAIL_PATTERN.test(text) ||
    UUID_PATTERN.test(text) ||
    ISO_VALUE_PATTERN.test(text) ||
    CLOCK_PATTERN.test(text) ||
    CODE_PATTERN.test(text)
  ) {
    return false;
  }
  return /[\p{L}]/u.test(text);
}

function setPath(root: Record<string, unknown>, path: TranslationPath, value: string): void {
  let current: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (typeof key === "number") {
      if (!Array.isArray(current)) return;
      current = current[key];
    } else {
      if (!current || typeof current !== "object" || Array.isArray(current)) return;
      current = (current as Record<string, unknown>)[key];
    }
  }
  const leaf = path[path.length - 1];
  if (typeof leaf === "number") {
    if (Array.isArray(current)) current[leaf] = value;
  } else if (current && typeof current === "object" && !Array.isArray(current)) {
    (current as Record<string, unknown>)[leaf] = value;
  }
}

function collectScrapedTexts(
  value: JsonValue,
  path: TranslationPath,
  texts: TranslationText[],
  parentKey = "",
): void {
  if (typeof value === "string") {
    if (isTranslatableScrapedText(parentKey, value)) {
      texts.push({ path, text: plainTranslationText(value) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectScrapedTexts(item, [...path, index], texts, parentKey));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    collectScrapedTexts(child, [...path, key], texts, key);
  }
}

function addText(texts: TranslationText[], path: TranslationPath, value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const plain = plainTranslationText(text);
  if (!plain) return null;
  texts.push({ path, text: plain });
  return plain;
}

export function normalizeSourceLocale(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replaceAll("_", "-") ?? "";
  if (!normalized || /[;,/]/.test(normalized)) return null;
  const code = normalized.split(/[-\s]/)[0];
  const aliases: Record<string, string> = {
    english: "en",
    anglais: "en",
    french: "fr",
    français: "fr",
    francais: "fr",
    polish: "pl",
    polski: "pl",
    italian: "it",
    italiano: "it",
    russian: "ru",
    русский: "ru",
    spanish: "es",
    español: "es",
    espanol: "es",
  };
  const result = aliases[normalized] ?? aliases[code] ?? code;
  return /^[a-z]{2}$/.test(result) && result !== "und" ? result : null;
}

export function buildEventTranslationDraft(
  event: TranslationEventRow,
  scope: EventTranslationScope,
): EventTranslationDraft {
  const venue = firstRelation(event.venue);
  const organizer = firstRelation(event.organizer);
  const accessibility = firstRelation(event.accessibility);
  const scraped = firstRelation(event.scraped);
  const texts: TranslationText[] = [];
  const title = addText(texts, ["title"], event.title) ?? event.title;
  const shortDescription = addText(texts, ["shortDescription"], event.short_description);
  const previewDescription = event.description
    ? plainTranslationText(event.description).slice(0, 700).trim()
    : null;

  const content: Record<string, JsonValue> = {
    preview_description: previewDescription,
    age_restriction: event.age_restriction,
    venue: venue
      ? { id: venue.id, name: venue.name, description: scope === "full" ? venue.description : null }
      : null,
    organizer:
      scope === "full" && organizer
        ? { id: organizer.id, name: organizer.name, description: organizer.description }
        : null,
    accessibility: scope === "full" && accessibility ? { notes: accessibility.notes } : null,
    offers:
      scope === "full"
        ? Object.fromEntries((event.offers ?? []).map((offer) => [offer.id, { name: offer.name }]))
        : {},
    performers:
      scope === "full"
        ? Object.fromEntries(
            (event.performers ?? []).flatMap((item) => {
              const performer = firstRelation(item.performer);
              return performer
                ? [
                    [
                      performer.id,
                      { name: performer.name, type: performer.type, bio: performer.bio },
                    ],
                  ]
                : [];
            }),
          )
        : {},
    scraped_details: scope === "full" ? (scraped?.details ?? null) : null,
  };

  if (previewDescription) {
    addText(texts, ["content", "preview_description"], previewDescription);
  }
  if (venue) {
    addText(texts, ["content", "venue", "name"], venue.name);
    if (scope === "full") addText(texts, ["content", "venue", "description"], venue.description);
  }

  let description: string | null = null;
  if (scope === "full") {
    description = addText(texts, ["description"], event.description);
    addText(texts, ["content", "age_restriction"], event.age_restriction);
    if (organizer) {
      addText(texts, ["content", "organizer", "name"], organizer.name);
      addText(texts, ["content", "organizer", "description"], organizer.description);
    }
    addText(texts, ["content", "accessibility", "notes"], accessibility?.notes);
    for (const offer of event.offers ?? []) {
      addText(texts, ["content", "offers", offer.id, "name"], offer.name);
    }
    for (const item of event.performers ?? []) {
      const performer = firstRelation(item.performer);
      if (!performer) continue;
      addText(texts, ["content", "performers", performer.id, "name"], performer.name);
      addText(texts, ["content", "performers", performer.id, "type"], performer.type);
      addText(texts, ["content", "performers", performer.id, "bio"], performer.bio);
    }
    if (scraped?.details != null) {
      collectScrapedTexts(scraped.details, ["content", "scraped_details"], texts);
    }
  }

  return {
    eventId: event.id,
    sourceLocale: normalizeSourceLocale(event.language),
    scope,
    title,
    shortDescription,
    description,
    content,
    texts,
  };
}

export function applyDraftTranslations(
  draft: EventTranslationDraft,
  translatedTexts: readonly string[],
): EventTranslationDraft {
  if (translatedTexts.length !== draft.texts.length) {
    throw new RangeError("Translation result count does not match the source text count");
  }
  const next = structuredClone(draft);
  const root = next as unknown as Record<string, unknown>;
  translatedTexts.forEach((value, index) => setPath(root, draft.texts[index].path, value));
  return next;
}

export function splitTranslationText(value: string, maximumCharacters = 4_000): string[] {
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < 100) {
    throw new RangeError("maximumCharacters must be at least 100");
  }
  if (value.length <= maximumCharacters) return [value];
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > maximumCharacters) {
    const candidate = remaining.slice(0, maximumCharacters);
    const boundary = Math.max(
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf("! "),
      candidate.lastIndexOf("? "),
      candidate.lastIndexOf("; "),
      candidate.lastIndexOf(", "),
      candidate.lastIndexOf(" "),
    );
    const end = boundary >= Math.floor(maximumCharacters * 0.55) ? boundary + 1 : maximumCharacters;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
