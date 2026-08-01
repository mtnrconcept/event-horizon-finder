import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// These source-level contracts prevent expensive MapLibre work from returning
// to the active touch/pointer gesture path during future map refactors.
const mapSource = readFileSync("src/routes/map.tsx", "utf8");
const placeLayerSource = readFileSync("src/hooks/usePlaceMapLayer.ts", "utf8");

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
