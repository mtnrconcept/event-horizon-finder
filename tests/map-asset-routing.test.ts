import assert from "node:assert/strict";
import test from "node:test";

import { mapAssetProxyUrl, normalizeMapAssetTarget } from "../src/lib/map-asset-proxy.ts";

test("OpenFreeMap font glyphs may continue through the same-origin cache", () => {
  const glyph = "https://tiles.openfreemap.org/fonts/Open%20Sans%20Regular/0-255.pbf";
  assert.equal(normalizeMapAssetTarget(glyph), glyph);
  assert.equal(mapAssetProxyUrl(glyph), `/api/map-assets?url=${encodeURIComponent(glyph)}`);
});

test("OpenFreeMap style and vector render assets bypass the Worker proxy", () => {
  for (const asset of [
    "https://tiles.openfreemap.org/styles/positron",
    "https://tiles.openfreemap.org/styles/positron/sprite.json",
    "https://tiles.openfreemap.org/planet/7/65/43.pbf",
  ]) {
    assert.equal(normalizeMapAssetTarget(asset), asset);
    assert.equal(mapAssetProxyUrl(asset), null);
  }
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
