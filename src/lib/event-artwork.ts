const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function supabaseFunctionsUrl(): string | null {
  const browserUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const serverUrl =
    typeof process !== "undefined"
      ? (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL)
      : undefined;
  const baseUrl = browserUrl || serverUrl;
  return baseUrl ? `${baseUrl.replace(/\/$/, "")}/functions/v1` : null;
}

export function getGeneratedEventArtworkUrl(eventId: string): string | null {
  if (!UUID_PATTERN.test(eventId)) return null;
  const functionsUrl = supabaseFunctionsUrl();
  return functionsUrl ? `${functionsUrl}/event-cover?id=${encodeURIComponent(eventId)}` : null;
}

export function getEventArtworkUrl(eventId: string, sourceUrl?: string | null): string | null {
  const trimmedSource = sourceUrl?.trim();
  return trimmedSource || getGeneratedEventArtworkUrl(eventId);
}
