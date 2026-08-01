export const SUPABASE_READ_PROXY_ROUTE = "/api/supabase-read-proxy";
export const SUPABASE_READ_PROXY_TARGET_HEADER = "x-eventa-supabase-path";

const MAP_READ_RPC_NAMES = new Set([
  "discover_map_events_in_bounds_v1",
  "discover_map_pins_in_bounds_v2",
  "discover_map_pins_in_bounds_v3",
  "discover_map_pins_in_bounds_v4",
  "discover_map_pins_in_bounds_v5",
  "get_map_occurrence_detail_v1",
]);

const MAP_READ_RELATION_NAMES = new Set([
  "countries",
  "event_categories",
  "event_media",
  "event_occurrences",
  "event_performers",
  "event_publication_media_v2",
  "event_translations",
  "events",
  "profiles",
  "regions",
  "ticket_offers",
]);

function decodeJwtPayload(value: string): Record<string, unknown> | null {
  const encoded = value.split(".")[1];
  if (!encoded) return null;

  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function isSafeSupabaseProxyPublishableKey(value: string): boolean {
  if (value.startsWith("sb_secret_")) return false;
  if (value.startsWith("sb_publishable_")) return true;
  return decodeJwtPayload(value)?.role === "anon";
}

/**
 * The same-origin fallback is deliberately read-only. GET/HEAD requests remain
 * protected by PostgREST RLS, while POST is limited to the idempotent map RPCs.
 */
export function isAllowedSupabaseReadProxyRequest(method: string, pathname: string): boolean {
  const normalizedMethod = method.trim().toUpperCase();
  if (!pathname.startsWith("/rest/v1/")) return false;
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
    const relationMatch = /^\/rest\/v1\/([^/?]+)$/.exec(pathname);
    return Boolean(relationMatch?.[1] && MAP_READ_RELATION_NAMES.has(relationMatch[1]));
  }
  if (normalizedMethod !== "POST") return false;

  const match = /^\/rest\/v1\/rpc\/([^/?]+)$/.exec(pathname);
  return Boolean(match?.[1] && MAP_READ_RPC_NAMES.has(match[1]));
}

export function normalizeSupabaseReadProxyTarget(target: string): string | null {
  if (!target.startsWith("/") || target.startsWith("//")) return null;

  try {
    const parsed = new URL(target, "https://supabase-proxy.invalid");
    if (parsed.origin !== "https://supabase-proxy.invalid") return null;
    if (!parsed.pathname.startsWith("/rest/v1/")) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}
