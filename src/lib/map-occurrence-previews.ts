export const MAP_PREVIEW_QUERY_BATCH_SIZE = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MapOccurrencePreview {
  occurrence_id: string;
  slug: string;
  title: string;
  short_description: string | null;
  description: string | null;
  cover_image_url: string | null;
  starts_at: string;
  timezone: string;
  venue_name: string | null;
  city_name: string | null;
}

type RawMapOccurrencePreviewRow = {
  id?: unknown;
  starts_at?: unknown;
  timezone?: unknown;
  event?: unknown;
};

type RawMapEventPreview = {
  slug?: unknown;
  title?: unknown;
  short_description?: unknown;
  description?: unknown;
  cover_image_url?: unknown;
  venue?: unknown;
  city?: unknown;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function relationObject(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return objectValue(value[0]);
  return objectValue(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseMapOccurrencePreviewRows(data: unknown): MapOccurrencePreview[] {
  if (!Array.isArray(data)) throw new Error("Invalid map occurrence preview response");

  return data.flatMap((value) => {
    const row = objectValue(value) as RawMapOccurrencePreviewRow | null;
    const event = relationObject(row?.event) as RawMapEventPreview | null;
    if (
      typeof row?.id !== "string" ||
      typeof row.starts_at !== "string" ||
      typeof row.timezone !== "string" ||
      typeof event?.slug !== "string" ||
      typeof event.title !== "string"
    ) {
      return [];
    }

    const venue = relationObject(event.venue);
    const venueCity = relationObject(venue?.city);
    const eventCity = relationObject(event.city);

    return [
      {
        occurrence_id: row.id,
        slug: event.slug,
        title: event.title,
        short_description: optionalString(event.short_description),
        description: optionalString(event.description),
        cover_image_url: optionalString(event.cover_image_url),
        starts_at: row.starts_at,
        timezone: row.timezone,
        venue_name: optionalString(venue?.name),
        city_name: optionalString(venueCity?.name) ?? optionalString(eventCity?.name),
      },
    ];
  });
}

export function chunkOccurrenceIds(
  values: string[],
  batchSize = MAP_PREVIEW_QUERY_BATCH_SIZE,
): string[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > MAP_PREVIEW_QUERY_BATCH_SIZE) {
    throw new RangeError(`batchSize must be between 1 and ${MAP_PREVIEW_QUERY_BATCH_SIZE}`);
  }

  const uniqueIds: string[] = [];
  const knownIds = new Set<string>();
  for (const value of values) {
    if (!UUID_PATTERN.test(value)) throw new TypeError("Invalid occurrence id");
    if (knownIds.has(value)) continue;
    knownIds.add(value);
    uniqueIds.push(value);
  }

  const batches: string[][] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
    batches.push(uniqueIds.slice(offset, offset + batchSize));
  }
  return batches;
}

export function mapPreviewExcerpt(value: string | null | undefined, maximumLength = 180): string {
  const plainText = (value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plainText || maximumLength <= 0) return "";
  if (plainText.length <= maximumLength) return plainText;
  return `${plainText.slice(0, Math.max(1, maximumLength - 1)).trimEnd()}…`;
}

export function mapPreviewVenueNames(previews: MapOccurrencePreview[]): string[] {
  const names = new Set<string>();
  for (const preview of previews) {
    const name = preview.venue_name ?? preview.city_name;
    if (name) names.add(name);
  }
  return [...names];
}
