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

test("the deployed map keeps a single rollout RPC fallback", () => {
  assert.match(queriesSource, /discover_map_pins_in_bounds_v8/);
  assert.match(queriesSource, /discover_map_pins_in_bounds_v7/);
  assert.doesNotMatch(queriesSource, /\["v6", "v5", "v4", "v3", "v2"\]/);
});
