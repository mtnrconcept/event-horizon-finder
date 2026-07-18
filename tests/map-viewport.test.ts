import assert from "node:assert/strict";
import test from "node:test";

import {
  isCoordinateInMapViewport,
  mapViewportBoundsKey,
  normalizeMapViewportBounds,
} from "../src/lib/map-viewport.ts";

test("normalizes ordinary MapLibre bounds with a stable precision", () => {
  const bounds = normalizeMapViewportBounds({
    west: 6.01000031,
    south: 46.11000039,
    east: 6.26000033,
    north: 46.30000036,
  });

  assert.deepEqual(bounds, {
    west: 6.01,
    south: 46.11,
    east: 6.26,
    north: 46.3,
  });
  assert.equal(mapViewportBoundsKey(bounds!), "6.010000:46.110000:6.260000:46.300000");
});

test("preserves a viewport crossing the international date line", () => {
  const bounds = normalizeMapViewportBounds({
    west: 170,
    south: -20,
    east: 190,
    north: 20,
  });

  assert.deepEqual(bounds, { west: 170, south: -20, east: -170, north: 20 });
  assert.equal(isCoordinateInMapViewport(bounds!, 178, 0), true);
  assert.equal(isCoordinateInMapViewport(bounds!, -178, 0), true);
  assert.equal(isCoordinateInMapViewport(bounds!, 0, 0), false);
});

test("collapses a fully dezoomed wrapped map to the whole world", () => {
  assert.deepEqual(normalizeMapViewportBounds({ west: -540, south: -100, east: 540, north: 100 }), {
    west: -180,
    south: -90,
    east: 180,
    north: 90,
  });
});

test("rejects invalid or inverted latitude ranges", () => {
  assert.equal(normalizeMapViewportBounds({ west: 6, south: 47, east: 7, north: 46 }), null);
  assert.equal(
    normalizeMapViewportBounds({ west: Number.NaN, south: 46, east: 7, north: 47 }),
    null,
  );
});
