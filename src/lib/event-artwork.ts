const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const EVENT_ARTWORK_FAILED_URL_CACHE_LIMIT = 256;

const failedArtworkUrls = new Map<string, true>();
const BLOCKED_PLACEHOLDER_HOSTS = new Set([
  // Non-resolving sample origins already present in the imported catalog.
  // Keep them client-side so cards go straight to their local fallback.
  "centreart.ch",
  "www.centreart.ch",
  "festivaljazz.ch",
  "www.festivaljazz.ch",
  "images.com",
  "www.images.com",
  "example.com",
  "www.example.com",
  "example.net",
  "www.example.net",
  "example.org",
  "www.example.org",
]);

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

export function getSafeEventArtworkSourceUrl(sourceUrl?: string | null): string | null {
  const trimmedSource = sourceUrl?.trim();
  if (!trimmedSource) return null;
  if (trimmedSource.startsWith("/") && !trimmedSource.startsWith("//")) return trimmedSource;

  try {
    const parsed = new URL(trimmedSource);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    const hostname = parsed.hostname.toLowerCase();
    if (
      BLOCKED_PLACEHOLDER_HOSTS.has(hostname) ||
      hostname.endsWith(".example.com") ||
      hostname.endsWith(".example.net") ||
      hostname.endsWith(".example.org")
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function artworkHash(eventId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < eventId.length; index += 1) {
    hash ^= eventId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A deterministic data URI that remains available when Supabase or an origin is offline. */
export function getLocalEventArtworkUrl(eventId: string): string {
  const hash = artworkHash(eventId || "global-party");
  const hue = hash % 360;
  const accentHue = (hue + 42 + (hash % 57)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 58% 24%)"/><stop offset="1" stop-color="hsl(${accentHue} 72% 48%)"/></linearGradient><radialGradient id="r" cx="78%" cy="18%" r="72%"><stop stop-color="white" stop-opacity=".34"/><stop offset="1" stop-color="white" stop-opacity="0"/></radialGradient></defs><rect width="1200" height="675" fill="url(#g)"/><rect width="1200" height="675" fill="url(#r)"/><circle cx="600" cy="338" r="78" fill="none" stroke="white" stroke-opacity=".78" stroke-width="14"/><path d="M600 236v204M498 338h204" stroke="white" stroke-opacity=".78" stroke-linecap="round" stroke-width="14"/></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function hasFailedEventArtworkUrl(url: string): boolean {
  return failedArtworkUrls.has(url);
}

export function rememberFailedEventArtworkUrl(url: string): void {
  if (!url || url.startsWith("data:")) return;
  failedArtworkUrls.delete(url);
  failedArtworkUrls.set(url, true);
  while (failedArtworkUrls.size > EVENT_ARTWORK_FAILED_URL_CACHE_LIMIT) {
    const oldestUrl = failedArtworkUrls.keys().next().value;
    if (typeof oldestUrl !== "string") break;
    failedArtworkUrls.delete(oldestUrl);
  }
}

export function clearFailedEventArtworkUrls(): void {
  failedArtworkUrls.clear();
}

export function getEventArtworkUrl(eventId: string, sourceUrl?: string | null): string | null {
  return getSafeEventArtworkSourceUrl(sourceUrl) || getGeneratedEventArtworkUrl(eventId);
}
