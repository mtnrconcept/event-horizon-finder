import assert from "node:assert/strict";
import test from "node:test";

import type { CompactMapPin, CompactMapPinBatch } from "../src/lib/map-pins.ts";
import {
  clearSessionMapPinCache,
  expandMapViewportBounds,
  filterMapPinsToViewport,
  getSessionMapPinCacheStats,
  loadSessionMapPins,
  MAP_SERVER_CLUSTER_MAX_ZOOM,
  mapViewportContainsBounds,
} from "../src/lib/map-pin-session-cache.ts";

const geneva = { west: 6, south: 46.1, east: 6.25, north: 46.3 };
const pins: CompactMapPin[] = [
  ["event", "00000000-0000-4000-8000-000000000001", 6.14, 46.2, "concert", 0, 0, "one", 1, 0],
  ["event", "00000000-0000-4000-8000-000000000002", 6.3, 46.2, "festival", 1, 0, "two", 1, 1],
];
const batch: CompactMapPinBatch = {
  pins,
  totalCount: 2,
  freeCount: 1,
  clustered: false,
  clusterMode: "client",
  truncated: false,
};

test("expands a viewport into a reusable spatial buffer", () => {
  const expanded = expandMapViewportBounds(geneva);
  assert.equal(mapViewportContainsBounds(expanded, geneva), true);
  assert.ok(expanded.west < geneva.west);
  assert.ok(expanded.east > geneva.east);
});

test("contains and filters viewports that cross the date line", () => {
  const viewport = { west: 175, south: -10, east: -175, north: 10 };
  const expanded = expandMapViewportBounds(viewport);
  assert.equal(mapViewportContainsBounds(expanded, viewport), true);
  assert.deepEqual(
    filterMapPinsToViewport(
      [
        ["event", "00000000-0000-4000-8000-000000000003", 178, 0, "", 0, 0, "east", 1, 0],
        ["event", "00000000-0000-4000-8000-000000000004", -178, 0, "", 0, 0, "west", 1, 0],
        ["event", "00000000-0000-4000-8000-000000000005", 0, 0, "", 0, 0, "outside", 1, 0],
      ],
      viewport,
    ).map((pin) => pin[7]),
    ["east", "west"],
  );
});

test("serves nearby movements from the same session cache", async () => {
  clearSessionMapPinCache();
  let calls = 0;
  const fetchPins = async () => {
    calls += 1;
    return batch;
  };

  const first = await loadSessionMapPins({
    cacheKey: "default",
    viewport: geneva,
    zoom: 15,
    fetchPins,
  });
  const nearby = await loadSessionMapPins({
    cacheKey: "default",
    viewport: { west: 6.02, south: 46.12, east: 6.24, north: 46.28 },
    zoom: 15,
    fetchPins,
  });

  assert.equal(calls, 1);
  assert.deepEqual(
    first.pins.map((pin) => pin[7]),
    ["one"],
  );
  assert.deepEqual(
    nearby.pins.map((pin) => pin[7]),
    ["one"],
  );
  assert.equal(getSessionMapPinCacheStats().regions, 1);
});

test("deduplicates concurrent requests covered by the same buffered region", async () => {
  clearSessionMapPinCache();
  let calls = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchPins = async () => {
    calls += 1;
    await gate;
    return batch;
  };

  const first = loadSessionMapPins({
    cacheKey: "shared",
    viewport: geneva,
    zoom: 15,
    fetchPins,
  });
  const second = loadSessionMapPins({
    cacheKey: "shared",
    viewport: { west: 6.03, south: 46.13, east: 6.22, north: 46.27 },
    zoom: 15,
    fetchPins,
  });
  release?.();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(getSessionMapPinCacheStats().inFlight, 0);
});

test("keeps filter caches isolated for the duration of the session", async () => {
  clearSessionMapPinCache();
  let calls = 0;
  const fetchPins = async () => {
    calls += 1;
    return batch;
  };

  await loadSessionMapPins({ cacheKey: "concerts", viewport: geneva, zoom: 15, fetchPins });
  await loadSessionMapPins({ cacheKey: "festivals", viewport: geneva, zoom: 15, fetchPins });

  assert.equal(calls, 2);
  assert.equal(getSessionMapPinCacheStats().filterBuckets, 2);
});

test("does not spatially pad low-zoom aggregate requests", async () => {
  clearSessionMapPinCache();
  let requestedBounds: typeof geneva | null = null;

  await loadSessionMapPins({
    cacheKey: "low-zoom",
    viewport: geneva,
    zoom: 4,
    fetchPins: async (bounds) => {
      requestedBounds = bounds;
      return { ...batch, clustered: true, clusterMode: "grid" };
    },
  });

  assert.deepEqual(requestedBounds, geneva);
  assert.equal(MAP_SERVER_CLUSTER_MAX_ZOOM, 14);
});

test("does not reuse low-zoom aggregates for a different viewport", async () => {
  clearSessionMapPinCache();
  let calls = 0;
  const fetchPins = async () => {
    calls += 1;
    return { ...batch, clustered: true, clusterMode: "grid" };
  };

  await loadSessionMapPins({
    cacheKey: "low-zoom-pan",
    viewport: geneva,
    zoom: 4,
    fetchPins,
  });
  await loadSessionMapPins({
    cacheKey: "low-zoom-pan",
    viewport: { west: 6.02, south: 46.12, east: 6.24, north: 46.28 },
    zoom: 4,
    fetchPins,
  });

  assert.equal(calls, 2);
});

test("reuses terminal location groups across nearby high-zoom movements", async () => {
  clearSessionMapPinCache();
  let calls = 0;
  const fetchPins = async () => {
    calls += 1;
    return { ...batch, clustered: true, clusterMode: "location" as const };
  };

  await loadSessionMapPins({ cacheKey: "locations", viewport: geneva, zoom: 15, fetchPins });
  await loadSessionMapPins({
    cacheKey: "locations",
    viewport: { west: 6.02, south: 46.12, east: 6.24, north: 46.28 },
    zoom: 15,
    fetchPins,
  });

  assert.equal(calls, 1);
});

test("aborts stale map requests and removes them from the in-flight registry", async () => {
  clearSessionMapPinCache();
  const controller = new AbortController();
  const pending = loadSessionMapPins({
    cacheKey: "aborted",
    viewport: geneva,
    zoom: 15,
    signal: controller.signal,
    fetchPins: async (_bounds, signal) =>
      new Promise<CompactMapPinBatch>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });

  controller.abort(new DOMException("stale viewport", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(getSessionMapPinCacheStats().inFlight, 0);
});

test("deduplicates abortable requests while consumers remain active", async () => {
  clearSessionMapPinCache();
  let calls = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstController = new AbortController();
  const secondController = new AbortController();

  const first = loadSessionMapPins({
    cacheKey: "abortable-shared",
    viewport: geneva,
    zoom: 15,
    signal: firstController.signal,
    fetchPins: async (_bounds, signal) => {
      calls += 1;
      await gate;
      signal?.throwIfAborted();
      return batch;
    },
  });
  const second = loadSessionMapPins({
    cacheKey: "abortable-shared",
    viewport: { west: 6.03, south: 46.13, east: 6.22, north: 46.27 },
    zoom: 15,
    signal: secondController.signal,
    fetchPins: async () => {
      calls += 1;
      return batch;
    },
  });

  firstController.abort(new DOMException("stale viewport", "AbortError"));
  await assert.rejects(first, { name: "AbortError" });
  release?.();
  const result = await second;

  assert.equal(calls, 1);
  assert.deepEqual(
    result.pins.map((pin) => pin[7]),
    ["one"],
  );
  assert.equal(getSessionMapPinCacheStats().inFlight, 0);
});

test("a viewport that drops no pin reuses the cached batch object", async () => {
  clearSessionMapPinCache();
  const cachedBatch: CompactMapPinBatch = {
    // Both pins sit well inside the region, so narrowing the viewport a little
    // cannot drop either of them.
    pins: [
      ["event", "00000000-0000-4000-8000-00000000000a", 6.14, 46.2, "concert", 0, 0, "a", 1, 0],
      ["event", "00000000-0000-4000-8000-00000000000b", 6.15, 46.21, "concert", 0, 0, "b", 1, 0],
    ],
    totalCount: 2,
    freeCount: 0,
    clustered: true,
    clusterMode: "location",
    truncated: false,
  };
  let calls = 0;
  const fetchPins = async () => {
    calls += 1;
    return cachedBatch;
  };

  const first = await loadSessionMapPins({
    cacheKey: "identity",
    viewport: geneva,
    zoom: 15,
    fetchPins,
  });
  const narrowed = await loadSessionMapPins({
    cacheKey: "identity",
    viewport: { west: 6.1, south: 46.15, east: 6.2, north: 46.25 },
    zoom: 15,
    fetchPins,
  });

  assert.equal(calls, 1);
  // Identity, not just equality: a fresh object would invalidate the memoised
  // point collection and force a redundant MapLibre source update.
  assert.equal(narrowed, first);

  const clipped = await loadSessionMapPins({
    cacheKey: "identity",
    viewport: { west: 6.1, south: 46.15, east: 6.145, north: 46.205 },
    zoom: 15,
    fetchPins,
  });
  assert.equal(calls, 1);
  assert.notEqual(clipped, first);
  assert.equal(clipped.pins.length, 1);
  assert.equal(clipped.totalCount, 1);
});
