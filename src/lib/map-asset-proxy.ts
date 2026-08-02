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

/**
 * Keeps vector styles, sprites, glyphs and vector tiles on the application
 * origin. Raster OpenStreetMap tiles remain direct so the emergency fallback
 * cannot be blocked by a saturated Worker proxy.
 */
export function mapAssetProxyUrl(value: string): string | null {
  const target = normalizeMapAssetTarget(value);
  if (!target) return null;
  if (DIRECT_MAP_ASSET_HOSTS.has(new URL(target).hostname)) return null;
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
