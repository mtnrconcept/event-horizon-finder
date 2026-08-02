const MAP_ASSET_PROXY_ROUTE = "/api/map-assets";

const MAP_ASSET_HOSTS = new Set(["tiles.openfreemap.org", "tile.openstreetmap.org"]);
const DIRECT_MAP_ASSET_HOSTS = new Set(["tile.openstreetmap.org"]);

export function normalizeMapAssetTarget(value: string): string | null {
  try {
    const target = new URL(value);
    if (
      target.protocol !== "https:" ||
      target.port ||
      target.username ||
      target.password ||
      !MAP_ASSET_HOSTS.has(target.hostname)
    ) {
      return null;
    }
    return target.toString();
  } catch {
    return null;
  }
}

function shouldLoadMapAssetDirect(target: URL): boolean {
  if (DIRECT_MAP_ASSET_HOSTS.has(target.hostname)) return true;

  // The primary style, sprites and vector tiles are on the critical render
  // path. Load them directly so a Worker-to-provider DNS or timeout failure
  // cannot leave the map blank. Font glyphs may still use the same-origin
  // cache because missing labels do not block the basemap itself.
  return target.hostname === "tiles.openfreemap.org" && !target.pathname.startsWith("/fonts/");
}

/**
 * Validates known public map hosts and only proxies non-critical font glyphs.
 * OpenFreeMap styles, sprites and vector tiles, plus the OSM raster fallback,
 * load directly in the browser.
 */
export function mapAssetProxyUrl(value: string): string | null {
  const target = normalizeMapAssetTarget(value);
  if (!target) return null;
  if (shouldLoadMapAssetDirect(new URL(target))) return null;
  return `${MAP_ASSET_PROXY_ROUTE}?url=${encodeURIComponent(target)}`;
}

export function isMapAssetRequestUrl(value: string): boolean {
  try {
    const target = new URL(value, "https://globalparty.invalid");
    return target.pathname === MAP_ASSET_PROXY_ROUTE && target.searchParams.has("url");
  } catch {
    return false;
  }
}

export { MAP_ASSET_PROXY_ROUTE };
