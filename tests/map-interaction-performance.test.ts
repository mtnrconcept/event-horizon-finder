import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// These source-level contracts prevent expensive MapLibre work from returning
// to the active touch/pointer gesture path during future map refactors.
const mapSource = readFileSync("src/routes/map.tsx", "utf8");
const placeLayerSource = readFileSync("src/hooks/usePlaceMapLayer.ts", "utf8");
const sessionCacheSource = readFileSync("src/lib/map-pin-session-cache.ts", "utf8");

test("viewport refresh is emitted once per completed camera gesture", () => {
  assert.match(mapSource, /map\.on\("moveend", scheduleViewportCapture\)/);
  assert.doesNotMatch(mapSource, /map\.on\("zoomend", scheduleViewportCapture\)/);
});

test("event and place GeoJSON updates wait until camera movement settles", () => {
  assert.match(mapSource, /map\.isMoving\(\) \|\| map\.isZooming\(\) \|\| map\.isRotating\(\)/);
  assert.match(
    placeLayerSource,
    /map\.isMoving\(\) \|\| map\.isZooming\(\) \|\| map\.isRotating\(\)/,
  );
});

test("basemap POI visibility is not rewritten on every pin refresh", () => {
  assert.match(mapSource, /getLayoutProperty\(layer\.id, "visibility"\) !== "none"/);
});

test("event GeoJSON source updates are skipped when the pin batch is unchanged", () => {
  assert.match(mapSource, /MAP_EVENT_SOURCE_DATA_SIGNATURE/);
  assert.match(mapSource, /previousDataSignature === dataSignature/);
  assert.match(
    mapSource,
    /syncClusterLayers\(map, eventMapPoints, compactPinBatch\.clustered, eventMapPointsSignature\)/,
  );
});

test("the batch signature never serializes the pins", () => {
  // Proving the batch unchanged must stay cheaper than the source update it
  // avoids. JSON.stringify over the pin array cost 5.8ms of main-thread time
  // at the server's 12,000 pin cap; the numeric fold costs 1.9ms.
  assert.match(mapSource, /compactMapPinsSignature\(compactPins\)/);
  assert.doesNotMatch(mapSource, /JSON\.stringify\(\{[\s\S]{0,400}pins: compactPins/);
});

test("symbol cross-fading stays disabled", () => {
  // fadeDuration > 0 keeps the symbol buckets animating for the whole fade and
  // doubles the frame cost of a drag: 16.7ms -> 33.3ms median at 1,500 pins.
  assert.match(mapSource, /fadeDuration: 0,/);
});

test("a viewport that drops no pin reuses the cached batch object", () => {
  assert.match(sessionCacheSource, /if \(pins\.length === batch\.pins\.length\) return batch;/);
});
