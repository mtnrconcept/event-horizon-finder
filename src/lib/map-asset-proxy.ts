const MAP_ASSET_PROXY_ROUTE = "/api/map-assets";

const MAP_ASSET_HOSTS = new Set(["tiles.openfreemap.org", "tile.openstreetmap.org"]);

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
 * Keeps all map style, sprite, glyph and tile traffic on the application
 * origin. It prevents a visitor's DNS resolver from having to establish a
 * separate connection to every third-party map host while still retaining a
 * strict upstream allowlist.
 */
export function mapAssetProxyUrl(value: string): string | null {
  const target = normalizeMapAssetTarget(value);
  if (!target) return null;
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
