import assert from "node:assert/strict";
import test from "node:test";

import type { PlaceMapPinBatch } from "../src/lib/place-discovery.ts";
import {
  clearSessionPlacePinCache,
  expandPlacePinBounds,
  loadSessionPlacePins,
  placePinCacheMode,
} from "../src/lib/place-pin-session-cache.ts";

const geneva = { west: 6.05, south: 46.16, east: 6.2, north: 46.25 };
const nearbyGeneva = { west: 6.07, south: 46.17, east: 6.19, north: 46.24 };

const individualBatch: PlaceMapPinBatch = {
  clustered: false,
  truncated: false,
  totalCount: 2,
  pins: [
    {
      kind: "place",
      id: "00000000-0000-4000-8000-000000000001",
      name: "Jardin test",
      category: "nature",
      latitude: 46.2,
      longitude: 6.14,
      count: 1,
    },
    {
      kind: "place",
      id: "00000000-0000-4000-8000-000000000002",
      name: "Lieu hors vue",
      category: "culture",
      latitude: 46.28,
      longitude: 6.23,
      count: 1,
    },
  ],
};

const clusteredBatch: PlaceMapPinBatch = {
  clustered: true,
  truncated: false,
  totalCount: 8,
  pins: [
    {
      kind: "cluster",
      id: "cluster-one",
      name: "Lieux regroupés",
      category: "mixed",
      latitude: 46.2,
      longitude: 6.14,
      count: 8,
    },
  ],
};

test("expands high-zoom place bounds into a reusable spatial buffer", () => {
  const expanded = expandPlacePinBounds(geneva);
  assert.ok(expanded.west < geneva.west);
  assert.ok(expanded.east > geneva.east);
  assert.ok(expanded.south < geneva.south);
  assert.ok(expanded.north > geneva.north);
});

test("reuses compact individual pins for nearby movements", async () => {
  clearSessionPlacePinCache();
  let calls = 0;
  const fetchPins = async () => {
    calls += 1;
    return individualBatch;
  };

  const first = await loadSessionPlacePins({
    filterKey: "all",
    viewport: geneva,
    zoom: 14,
    fetchPins,
  });
  const nearby = await loadSessionPlacePins({
    filterKey: "all",
    viewport: nearbyGeneva,
    zoom: 15,
    fetchPins,
  });

  assert.equal(calls, 1);
  assert.deepEqual(first.pins.map((pin) => pin.name), ["Jardin test"]);
  assert.deepEqual(nearby.pins.map((pin) => pin.name), ["Jardin test"]);
});

test("never reuses server aggregates for different viewport bounds", async () => {
  clearSessionPlacePinCache();
  let calls = 0;
  const fetchPins = async () => {
    calls += 1;
    return clusteredBatch;
  };

  await loadSessionPlacePins({
    filterKey: "all",
    viewport: geneva,
    zoom: 10.8,
    fetchPins,
  });
  await loadSessionPlacePins({
    filterKey: "all",
    viewport: nearbyGeneva,
    zoom: 10.2,
    fetchPins,
  });

  assert.equal(calls, 2);
});

test("keeps filter signatures isolated", async () => {
  clearSessionPlacePinCache();
  let calls = 0;
  const fetchPins = async () => {
    calls += 1;
    return individualBatch;
  };

  await loadSessionPlacePins({
    filterKey: "nature",
    viewport: geneva,
    zoom: 14,
    fetchPins,
  });
  await loadSessionPlacePins({
    filterKey: "culture",
    viewport: geneva,
    zoom: 14,
    fetchPins,
  });

  assert.equal(calls, 2);
});

test("uses stable server zoom buckets and one individual bucket", () => {
  assert.equal(placePinCacheMode(10.9), "server:10");
  assert.equal(placePinCacheMode(11.9), "server:11");
  assert.equal(placePinCacheMode(12), "individual");
  assert.equal(placePinCacheMode(18), "individual");
});
