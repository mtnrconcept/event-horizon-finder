import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applicator = await readFile(
  new URL("../scripts/apply-adaptive-map-rendering.mjs", import.meta.url),
  "utf8",
);

test("adaptive projection changes are deferred beyond MapLibre zoom events", () => {
  assert.match(applicator, /function scheduleAdaptiveRendering\(\)/);
  assert.match(applicator, /requestAnimationFrame\(\(\) => \{/);
  assert.match(applicator, /map\.isMoving\(\) \|\| !map\.isStyleLoaded\(\)/);
  assert.match(applicator, /map\.on\("zoomend", scheduleAdaptiveRendering\)/);
  assert.match(applicator, /cancelAnimationFrame\(adaptiveRenderingFrame\)/);
  assert.doesNotMatch(applicator, /map\.on\("zoomend", handleAdaptiveRendering\)/);
});

test("adaptive projection reads tolerate transient missing projection state", () => {
  assert.match(applicator, /currentProjection && currentProjection\.type !== targetProjection/);
  assert.doesNotMatch(applicator, /map\.getProjection\(\)\.type/);
});
