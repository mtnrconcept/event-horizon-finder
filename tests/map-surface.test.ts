import assert from "node:assert/strict";
import test from "node:test";
import {
  isRenderableMapSurfaceSize,
  mapSurfaceSizesMatch,
  readMapSurfaceSize,
} from "../src/lib/map-surface.ts";

test("rejects zero-sized and non-finite map surfaces", () => {
  assert.equal(isRenderableMapSurfaceSize({ width: 0, height: 900 }), false);
  assert.equal(isRenderableMapSurfaceSize({ width: 1, height: 1 }), false);
  assert.equal(isRenderableMapSurfaceSize({ width: Number.NaN, height: 900 }), false);
  assert.equal(isRenderableMapSurfaceSize({ width: 1_920, height: 900 }), true);
});

test("reads the CSS pixel dimensions used by MapLibre", () => {
  assert.deepEqual(readMapSurfaceSize({ clientWidth: 1_920, clientHeight: 900 }), {
    width: 1_920,
    height: 900,
  });
});

test("detects a stale centered canvas after its container expands", () => {
  assert.equal(
    mapSurfaceSizesMatch({ width: 1_920, height: 900 }, { width: 566, height: 320 }),
    false,
  );
  assert.equal(
    mapSurfaceSizesMatch({ width: 1_920, height: 900 }, { width: 1_919.5, height: 900.5 }),
    true,
  );
});
