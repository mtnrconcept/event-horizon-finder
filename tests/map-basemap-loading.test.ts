import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mapSource = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");
const queriesSource = await readFile(new URL("../src/lib/queries.ts", import.meta.url), "utf8");
const applicatorSource = await readFile(
  new URL("../scripts/apply-progressive-basemap.mjs", import.meta.url),
  "utf8",
);

test("the progressive map applicator is safe after interaction tuning", () => {
  assert.match(applicatorSource, /MAP_VIEWPORT_REFRESH_DELAY_MS = \d[\d_]*;/);
  assert.doesNotMatch(applicatorSource, /MAP_VIEWPORT_REFRESH_DELAY_MS = 220;\n/);
  assert.match(
    applicatorSource,
    /if \(!source\.includes\("const MAP_PRIMARY_STYLE_TIMEOUT_MS"\)\)/,
  );
  assert.match(
    applicatorSource,
    /if \(!queries\.includes\('rpc\("discover_map_pins_in_bounds_v7"'\)\)/,
  );
});

test("the vector basemap is the primary mobile and desktop style", () => {
  assert.match(
    mapSource,
    /style: (?:mapAssetProxyUrl\(PRIMARY_MAP_STYLE\) \?\? )?PRIMARY_MAP_STYLE/,
  );
  assert.doesNotMatch(mapSource, /style: RASTER_FALLBACK_STYLE,\n {8}center/);
});

test("raster fallback remains bounded and reacts to repeated style errors", () => {
  assert.match(mapSource, /MAP_PRIMARY_STYLE_TIMEOUT_MS = 3_500/);
  assert.match(mapSource, /primaryStyleErrorCount >= 3/);
  assert.match(mapSource, /map\.setStyle\(RASTER_FALLBACK_STYLE\)/);
  assert.match(mapSource, /map\.off\("error", handleMapError\)/);
});

test("the vector basemap is accepted only after its tiles become idle", () => {
  assert.match(mapSource, /let primaryTilesReady = false/);
  assert.match(mapSource, /map\.on\("idle", handleMapIdle\)/);
  assert.match(mapSource, /if \(primaryTilesReady \|\| rasterFallbackApplied\) return/);
  assert.doesNotMatch(mapSource, /if \(primaryStyleLoaded\) window\.clearTimeout\(fallbackTimer\)/);
  assert.match(mapSource, /map\.off\("idle", handleMapIdle\)/);
});

test("the safety reveal does not keep a working canvas covered", () => {
  assert.match(mapSource, /MAP_REVEAL_TIMEOUT_MS = 2_000/);
  assert.match(mapSource, /map\.once\("render", markMapReady\)/);
});

test("the map is built during the location prompt, not after it", () => {
  // The construction effect must not wait on the permission: WebGL, style,
  // sprite and glyphs do not depend on where the user is.
  assert.match(mapSource, /if \(!activeMapContainer \|\| mapRef\.current\) return;/);
  assert.doesNotMatch(mapSource, /mapRef\.current \|\|\s*\n\s*geolocationStatus !== "ready"/);
  assert.match(mapSource, /const MAP_WARMUP_CAMERA = /);
  // The style is warmed while the prompt is still open.
  assert.match(mapSource, /void fetch\(PRIMARY_MAP_STYLE, \{/);
});

test("the location gate overlays the map instead of replacing it", () => {
  assert.match(mapSource, /return createPortal\(/);
  assert.match(mapSource, /className="fixed inset-0 z-30 /);
  // An overlay needs its own opaque colour; the gradient alone is only a
  // background-image and would let the map show through.
  assert.match(mapSource, /bg-background bg-\[radial-gradient/);
  assert.match(mapSource, /const locationGate = locationReady \? null : \(/);
  // No early return may strip the map surface out of the tree.
  assert.doesNotMatch(mapSource, /if \(geolocationStatus !== "ready" \|\| !userLocation\) \{/);
});

test("no pin request is spent on the warmup camera", () => {
  assert.match(mapSource, /if \(!map \|\| !mapReady \|\| !locationReady\) return;/);
  assert.match(mapSource, /\}, \[locationReady, mapInstance, mapReady\]\);/);
  // The jump onto the user's position must not fight a camera they already moved.
  assert.match(mapSource, /userCameraAppliedRef\.current = Boolean\(/);
});

test("the deployed map keeps a single rollout RPC fallback", () => {
  assert.match(queriesSource, /discover_map_pins_in_bounds_v8/);
  assert.match(queriesSource, /discover_map_pins_in_bounds_v7/);
  assert.doesNotMatch(queriesSource, /\["v6", "v5", "v4", "v3", "v2"\]/);
});
