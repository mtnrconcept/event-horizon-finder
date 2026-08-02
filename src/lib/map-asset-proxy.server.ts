import { normalizeMapAssetTarget } from "@/lib/map-asset-proxy";

const MAP_ASSET_TIMEOUT_MS = 5_000;
const MAP_ASSET_CACHE_SECONDS = 60 * 60 * 24;

function assetCacheKey(request: Request, target: string): Request {
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = "/__map-asset-cache";
  cacheUrl.search = `?target=${encodeURIComponent(target)}`;
  return new Request(cacheUrl, { method: "GET" });
}

function assetResponseHeaders(upstream: Response): Headers {
  const headers = new Headers({
    "Cache-Control": `public, max-age=${MAP_ASSET_CACHE_SECONDS}, s-maxage=${MAP_ASSET_CACHE_SECONDS}`,
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  for (const name of ["content-type", "content-length", "etag", "last-modified"] as const) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function unavailableMapAsset(): Response {
  return new Response(null, {
    status: 504,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Relays only known public basemap hosts through the Worker. Tile and glyph
 * assets are immutable at a coordinate URL, so edge caching removes repeated
 * external DNS/TLS work during pan and zoom gestures.
 */
export async function handleMapAssetProxy(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const target = normalizeMapAssetTarget(new URL(request.url).searchParams.get("url") ?? "");
  if (!target) return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });

  const cache = typeof caches === "undefined" ? null : await caches.open("globalparty-map-assets");
  const cacheKey = assetCacheKey(request, target);
  const cached = cache ? await cache.match(cacheKey) : undefined;
  if (cached) {
    return request.method === "HEAD"
      ? new Response(null, {
          status: cached.status,
          statusText: cached.statusText,
          headers: cached.headers,
        })
      : cached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Map asset timed out", "TimeoutError")),
    MAP_ASSET_TIMEOUT_MS,
  );
  try {
    const upstream = await fetch(target, {
      headers: { accept: request.headers.get("accept") ?? "*/*" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!upstream.ok) return new Response(null, { status: upstream.status });

    const response = new Response(request.method === "HEAD" ? undefined : upstream.body, {
      status: upstream.status,
      headers: assetResponseHeaders(upstream),
    });
    if (cache && request.method === "GET") {
      try {
        await cache.put(cacheKey, response.clone());
      } catch {
        // Caching is a performance optimization. A full cache must not make
        // the visible map fail.
      }
    }
    return response;
  } catch {
    return unavailableMapAsset();
  } finally {
    clearTimeout(timeout);
  }
}
