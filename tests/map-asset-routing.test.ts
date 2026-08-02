import assert from "node:assert/strict";
import test from "node:test";

import { mapAssetProxyUrl, normalizeMapAssetTarget } from "../src/lib/map-asset-proxy.ts";

test("OpenFreeMap assets continue through the same-origin cache", () => {
  const glyph = "https://tiles.openfreemap.org/fonts/Open%20Sans%20Regular/0-255.pbf";
  assert.equal(normalizeMapAssetTarget(glyph), glyph);
  assert.equal(mapAssetProxyUrl(glyph), `/api/map-assets?url=${encodeURIComponent(glyph)}`);
});

test("OpenStreetMap raster fallback bypasses the Worker proxy", () => {
  const tile = "https://tile.openstreetmap.org/5/15/11.png";
  assert.equal(normalizeMapAssetTarget(tile), tile);
  assert.equal(mapAssetProxyUrl(tile), null);
});

test("unknown map hosts remain rejected", () => {
  assert.equal(normalizeMapAssetTarget("https://evil.example/tile.png"), null);
  assert.equal(mapAssetProxyUrl("https://evil.example/tile.png"), null);
});
