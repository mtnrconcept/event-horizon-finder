import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

import {
  MAP_EVENT_PAGE_SIZE,
  MAP_INITIAL_GEOLOCATION_OPTIONS,
  MAP_REFINEMENT_GEOLOCATION_OPTIONS,
  MOBILE_LIST_BATCH_SIZE,
} from "../src/lib/map-loading.ts";
import {
  isTransientMapRequestError,
  jitteredMapRetryDelay,
  runMapRequestWithRetry,
} from "../src/lib/map-network-retry.ts";
import {
  EVENT_ARTWORK_FAILED_URL_CACHE_LIMIT,
  clearFailedEventArtworkUrls,
  getLocalEventArtworkUrl,
  getSafeEventArtworkSourceUrl,
  hasFailedEventArtworkUrl,
  rememberFailedEventArtworkUrl,
} from "../src/lib/event-artwork.ts";
import {
  isAllowedSupabaseReadProxyRequest,
  isMapReadProxyRequest,
  isSafeSupabaseProxyPublishableKey,
  normalizeSupabaseReadProxyTarget,
  SUPABASE_READ_PROXY_ROUTE,
  SUPABASE_READ_PROXY_TARGET_HEADER,
} from "../src/lib/supabase-read-proxy.ts";
import { mapAssetProxyUrl, normalizeMapAssetTarget } from "../src/lib/map-asset-proxy.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/supabase-read-proxy") {
      return {
        shortCircuit: true,
        url: new URL("../src/lib/supabase-read-proxy.ts", import.meta.url).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { createSupabaseFetch } = await import("../src/integrations/supabase/client.ts");
const { createSupabaseProxyUpstreamHeaders, readBoundedProxyBody } =
  await import("../src/lib/supabase-read-proxy.server.ts");

test("default map discovery stays within the next twelve months", () => {
  const route = readFileSync(new URL("../src/routes/map.tsx", import.meta.url), "utf8");

  assert.match(route, /useMemo\(\(\) => computeRange\(range\), \[range\]\)/);
  assert.doesNotMatch(route, /2100-01-01|MAP_ALL_UPCOMING_END/);
  assert.match(route, /12 prochains mois/);
});

test("rich map cards are fetched in progressive display-sized pages", () => {
  assert.equal(MOBILE_LIST_BATCH_SIZE, 24);
  assert.equal(MAP_EVENT_PAGE_SIZE, 48);
  assert.ok(MAP_EVENT_PAGE_SIZE <= MOBILE_LIST_BATCH_SIZE * 2);
});

test("map location starts coarse and refines without blocking first paint", () => {
  assert.equal(MAP_INITIAL_GEOLOCATION_OPTIONS.enableHighAccuracy, false);
  assert.equal(MAP_INITIAL_GEOLOCATION_OPTIONS.timeout, 4_000);
  assert.equal(MAP_REFINEMENT_GEOLOCATION_OPTIONS.enableHighAccuracy, true);
});

test("map pins stay compact and event content is loaded only on demand", () => {
  const queries = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/routes/map.tsx", import.meta.url), "utf8");

  assert.match(queries, /rpc\("discover_map_pins_in_bounds_v8"/);
  assert.doesNotMatch(queries, /discover_map_pins_in_bounds_v[2-7]/);
  assert.match(queries, /rpc\("get_map_occurrence_detail_v1"/);
  assert.match(route, /clusterLeafPageRequest/);
  assert.doesNotMatch(route, /loadAllClusterLeaves/);
  assert.doesNotMatch(route, /resolveEventHoverPreview/);
  assert.doesNotMatch(route, /includeDescription:\s*true/);
});

test("the map performs the final client-cluster expansion before opening its list", () => {
  const route = readFileSync(new URL("../src/routes/map.tsx", import.meta.url), "utf8");

  assert.match(route, /map\.getZoom\(\) >= EVENT_CLUSTER_TERMINAL_ZOOM/);
  assert.doesNotMatch(route, /map\.getZoom\(\) >= EVENT_CLUSTER_MAX_ZOOM/);
});

test("the same-origin Supabase fallback is strictly read-only", () => {
  for (const relation of [
    "event_media",
    "event_occurrences",
    "event_performers",
    "event_publication_media_v2",
    "event_translations",
    "ticket_offers",
  ]) {
    assert.equal(isAllowedSupabaseReadProxyRequest("GET", `/rest/v1/${relation}`), true);
  }
  assert.equal(isAllowedSupabaseReadProxyRequest("GET", "/rest/v1/private_secrets"), false);
  assert.equal(
    isAllowedSupabaseReadProxyRequest("POST", "/rest/v1/rpc/discover_map_pins_in_bounds_v8"),
    true,
  );
  assert.equal(
    isAllowedSupabaseReadProxyRequest("POST", "/rest/v1/rpc/discover_map_pins_in_bounds_v7"),
    false,
  );
  assert.equal(
    isAllowedSupabaseReadProxyRequest("POST", "/rest/v1/rpc/get_map_occurrence_detail_v1"),
    true,
  );
  assert.equal(isAllowedSupabaseReadProxyRequest("POST", "/rest/v1/events"), false);
  assert.equal(isAllowedSupabaseReadProxyRequest("DELETE", "/rest/v1/events"), false);
  assert.equal(normalizeSupabaseReadProxyTarget("//attacker.example/rest/v1/events"), null);
  assert.equal(normalizeSupabaseReadProxyTarget("/auth/v1/user"), null);
  const jwt = (role: string) =>
    `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
  assert.equal(isSafeSupabaseProxyPublishableKey("sb_publishable_test"), true);
  assert.equal(isSafeSupabaseProxyPublishableKey("sb_secret_test"), false);
  assert.equal(isSafeSupabaseProxyPublishableKey(jwt("anon")), true);
  assert.equal(isSafeSupabaseProxyPublishableKey(jwt("service_role")), false);
});

test("non-map Supabase reads fall back to the application origin after a browser network failure", async () => {
  const requests: Request[] = [];
  const resilientFetch = createSupabaseFetch("sb_publishable_test", {
    proxyOrigin: "https://global-party.example",
    directTimeoutMs: 10_000,
    circuitMs: 60_000,
    now: () => 1_000,
    fetcher: async (request) => {
      const normalized = request instanceof Request ? request : new Request(request);
      requests.push(normalized.clone());
      if (requests.length === 1) throw new TypeError("Failed to fetch");
      return Response.json({ pins: [] });
    },
  });

  const response = await resilientFetch(
    "https://xtwxmdbobehovnghfkes.supabase.co/rest/v1/events?select=id",
    { method: "GET" },
  );

  assert.equal(response.status, 200);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.url, `https://global-party.example${SUPABASE_READ_PROXY_ROUTE}`);
  assert.equal(
    requests[1]?.headers.get(SUPABASE_READ_PROXY_TARGET_HEADER),
    "/rest/v1/events?select=id",
  );
  assert.equal(await requests[1]?.text(), "");
});

test("a slow non-map read falls back once without poisoning later direct reads", async () => {
  const requests: Request[] = [];
  let directCalls = 0;
  const resilientFetch = createSupabaseFetch("sb_publishable_test", {
    proxyOrigin: "https://global-party.example",
    directTimeoutMs: 10,
    circuitMs: 60_000,
    now: () => 1_000,
    fetcher: async (request) => {
      const normalized = request instanceof Request ? request : new Request(request);
      requests.push(normalized.clone());
      if (normalized.url.startsWith("https://global-party.example")) {
        return Response.json({ pins: [] });
      }
      directCalls += 1;
      if (directCalls === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          normalized.signal.addEventListener("abort", () => reject(normalized.signal.reason), {
            once: true,
          });
        });
      }
      return Response.json({ pins: [] });
    },
  });

  const target = "https://xtwxmdbobehovnghfkes.supabase.co/rest/v1/events?select=id";
  assert.equal((await resilientFetch(target, { method: "GET" })).status, 200);
  assert.equal((await resilientFetch(target, { method: "GET" })).status, 200);
  assert.deepEqual(
    requests.map((request) => new URL(request.url).origin),
    [
      "https://xtwxmdbobehovnghfkes.supabase.co",
      "https://global-party.example",
      "https://xtwxmdbobehovnghfkes.supabase.co",
    ],
  );
});

test("map RPCs use one bounded same-origin transport instead of direct DNS then fallback", async () => {
  const requests: Request[] = [];
  const resilientFetch = createSupabaseFetch("sb_publishable_test", {
    proxyOrigin: "https://global-party.example",
    fetcher: async (request) => {
      const normalized = request instanceof Request ? request : new Request(request);
      requests.push(normalized.clone());
      throw new TypeError("network unavailable");
    },
  });

  const response = await resilientFetch(
    "https://xtwxmdbobehovnghfkes.supabase.co/rest/v1/rpc/discover_map_pins_in_bounds_v8",
    { method: "POST", body: JSON.stringify({ _zoom: 14 }) },
  );

  assert.equal(response.status, 503);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "SUPABASE_MAP_TRANSPORT_UNAVAILABLE",
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, `https://global-party.example${SUPABASE_READ_PROXY_ROUTE}`);
  assert.equal(
    requests[0]?.headers.get(SUPABASE_READ_PROXY_TARGET_HEADER),
    "/rest/v1/rpc/discover_map_pins_in_bounds_v8",
  );
  assert.equal(isMapReadProxyRequest("POST", "/rest/v1/rpc/discover_map_pins_in_bounds_v8"), true);
});

test("map assets are strictly allowlisted and rewritten to the application origin", () => {
  const tile = "https://tiles.openfreemap.org/fonts/Open%20Sans%20Regular/0-255.pbf";
  assert.equal(normalizeMapAssetTarget(tile), tile);
  assert.equal(mapAssetProxyUrl(tile), `/api/map-assets?url=${encodeURIComponent(tile)}`);
  assert.equal(normalizeMapAssetTarget("https://evil.example/tile.pbf"), null);
  assert.equal(normalizeMapAssetTarget("http://tiles.openfreemap.org/planet"), null);
});

test("the Supabase relay never returns a truncated successful body after an abort", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"half":'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController();
  const reading = readBoundedProxyBody(stream, 1_024, controller.signal, "response");
  await Promise.resolve();
  controller.abort(new DOMException("test timeout", "TimeoutError"));

  await assert.rejects(reading, (error: unknown) => {
    return error instanceof DOMException && error.name === "TimeoutError";
  });
  assert.equal(cancelled, true);
});

test("the Supabase relay pins every allowlisted request to the public schema", () => {
  const headers = createSupabaseProxyUpstreamHeaders(
    new Request("https://global-party.example/api/supabase-read-proxy", {
      headers: {
        "accept-profile": "private",
        authorization: "Bearer visitor-token",
        "content-profile": "storage",
      },
    }),
    "sb_publishable_test",
  );

  assert.equal(headers.get("accept-profile"), "public");
  assert.equal(headers.get("content-profile"), "public");
  assert.equal(headers.get("authorization"), "Bearer visitor-token");
  assert.equal(headers.get("apikey"), "sb_publishable_test");
});

test("map RPC retries are bounded, jittered, and limited to transient failures", async () => {
  const delays: number[] = [];
  let calls = 0;
  const result = await runMapRequestWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw { status: 503, message: "Service unavailable" };
      return "ready";
    },
    {
      delaysMs: [100, 200],
      random: () => 0.5,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    },
  );

  assert.equal(result, "ready");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.equal(
    jitteredMapRetryDelay(1_000, () => 0),
    800,
  );
  assert.equal(
    jitteredMapRetryDelay(1_000, () => 1),
    1_200,
  );
  assert.equal(isTransientMapRequestError({ code: "57014", status: 500 }), false);
  assert.equal(
    isTransientMapRequestError({
      status: 500,
      message: "canceling statement due to statement timeout",
    }),
    false,
  );
  assert.equal(isTransientMapRequestError({ code: "53300" }), true);
  assert.equal(isTransientMapRequestError({ code: "57P01" }), true);
  assert.equal(isTransientMapRequestError({ code: "08006" }), true);
  assert.equal(isTransientMapRequestError({ code: "PGRST001" }), true);
  assert.equal(
    isTransientMapRequestError({
      status: 504,
      code: "SUPABASE_PROXY_TIMEOUT",
      message: "Supabase proxy timed out",
    }),
    false,
  );
  assert.equal(
    isTransientMapRequestError({
      status: 503,
      code: "SUPABASE_MAP_TRANSPORT_UNAVAILABLE",
    }),
    false,
  );
});

test("map RPC retries never repeat aborted or permanent requests", async () => {
  for (const failure of [
    Object.assign(new Error("aborted"), { name: "AbortError" }),
    { status: 400, code: "22P02", message: "invalid input syntax" },
    { status: 500, code: "57014", message: "canceling statement due to statement timeout" },
  ]) {
    let calls = 0;
    let sleeps = 0;
    await assert.rejects(
      runMapRequestWithRetry(
        async () => {
          calls += 1;
          throw failure;
        },
        {
          delaysMs: [1, 1],
          sleep: async () => {
            sleeps += 1;
          },
        },
      ),
    );
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
  }
});

test("map list refresh keeps the last successful rows visible while reloading", () => {
  const route = readFileSync(new URL("../src/routes/map.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(route, /setEvents\(\[\]\)/);
  assert.match(route, /discoverMapEventsInBounds\([\s\S]*controller\.signal,\s*\)/);
});

test("event artwork blocks placeholder hosts and falls back locally with a bounded failure cache", () => {
  clearFailedEventArtworkUrls();
  assert.equal(getSafeEventArtworkSourceUrl("https://images.com/concert-jazz.jpg"), null);
  assert.equal(
    getSafeEventArtworkSourceUrl("https://www.centreart.ch/images/exposition_peinture.jpg"),
    null,
  );
  assert.equal(getSafeEventArtworkSourceUrl("http://www.festivaljazz.ch/image.jpg"), null);
  assert.equal(getSafeEventArtworkSourceUrl("https://cdn.festival.example.org/concert.jpg"), null);
  assert.equal(
    getSafeEventArtworkSourceUrl("https://media.global-party.app/concert.jpg"),
    "https://media.global-party.app/concert.jpg",
  );
  assert.match(getLocalEventArtworkUrl("event-1"), /^data:image\/svg\+xml/);

  for (let index = 0; index <= EVENT_ARTWORK_FAILED_URL_CACHE_LIMIT; index += 1) {
    rememberFailedEventArtworkUrl(`https://broken.example.test/${index}.jpg`);
  }
  assert.equal(hasFailedEventArtworkUrl("https://broken.example.test/0.jpg"), false);
  assert.equal(
    hasFailedEventArtworkUrl(
      `https://broken.example.test/${EVENT_ARTWORK_FAILED_URL_CACHE_LIMIT}.jpg`,
    ),
    true,
  );
  clearFailedEventArtworkUrls();
});
