import assert from "node:assert/strict";
import test from "node:test";

import type { CompactMapPin } from "../src/lib/map-pins.ts";
import {
  clearSessionMapPinCache,
  expandMapViewportBounds,
  filterMapPinsToViewport,
  getSessionMapPinCacheStats,
  loadSessionMapPins,
  mapViewportContainsBounds,
} from "../src/lib/map-pin-session-cache.ts";

const geneva = { west: 6, south: 46.1, east: 6.25, north: 46.3 };
const pins: CompactMapPin[] = [
  ["00000000-0000-4000-8000-000000000001", 6.14, 46.2, "concert", 0, 0, "one"],
  ["00000000-0000-4000-8000-000000000002", 6.3, 46.2, "festival", 1, 0, "two"],
];

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
        ["00000000-0000-4000-8000-000000000003", 178, 0, "", 0, 0, "east"],
        ["00000000-0000-4000-8000-000000000004", -178, 0, "", 0, 0, "west"],
        ["00000000-0000-4000-8000-000000000005", 0, 0, "", 0, 0, "outside"],
      ],
      viewport,
    ).map((pin) => pin[6]),
    ["east", "west"],
  );
});

test("serves nearby movements from the same session cache", async () => {
  clearSessionMapPinCache();
  let calls = 0;
  const fetchPins = async () => {
    calls += 1;
    return pins;
  };

  const first = await loadSessionMapPins({ cacheKey: "default", viewport: geneva, fetchPins });
  const nearby = await loadSessionMapPins({
    cacheKey: "default",
    viewport: { west: 6.02, south: 46.12, east: 6.24, north: 46.28 },
    fetchPins,
  });

  assert.equal(calls, 1);
  assert.deepEqual(
    first.map((pin) => pin[6]),
    ["one"],
  );
  assert.deepEqual(
    nearby.map((pin) => pin[6]),
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
    return pins;
  };

  const first = loadSessionMapPins({ cacheKey: "shared", viewport: geneva, fetchPins });
  const second = loadSessionMapPins({
    cacheKey: "shared",
    viewport: { west: 6.03, south: 46.13, east: 6.22, north: 46.27 },
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
    return pins;
  };

  await loadSessionMapPins({ cacheKey: "concerts", viewport: geneva, fetchPins });
  await loadSessionMapPins({ cacheKey: "festivals", viewport: geneva, fetchPins });

  assert.equal(calls, 2);
  assert.equal(getSessionMapPinCacheStats().filterBuckets, 2);
});
