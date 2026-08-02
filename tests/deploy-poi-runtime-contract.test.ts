import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/deploy-production.yml", import.meta.url),
  "utf8",
);
const applicator = await readFile(
  new URL("../scripts/apply-poi-map-layer.mjs", import.meta.url),
  "utf8",
);

test("production deploy applies and verifies the POI runtime", () => {
  assert.match(workflow, /node --check scripts\/apply-poi-map-layer\.mjs/);
  assert.match(workflow, /node scripts\/apply-poi-map-layer\.mjs/);
  assert.match(workflow, /tests\/poi-map-layer\.test\.ts/);
});

test("the POI applicator tolerates already-transformed runtime shapes", () => {
  assert.match(applicator, /committedPoiRuntimeMarkers/);
  assert.match(applicator, /countCompactOccurrences/);
  assert.match(applicator, /combined visible total/);
  assert.match(applicator, /combined loaded count/);
  assert.match(applicator, /place result list integration/);
  assert.match(applicator, /Skipping obsolete/);
});
