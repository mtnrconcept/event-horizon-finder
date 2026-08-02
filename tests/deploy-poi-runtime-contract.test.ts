import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/deploy-production.yml", import.meta.url),
  "utf8",
);
const map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");

test("production deploy does not mutate the committed POI runtime", () => {
  assert.doesNotMatch(workflow, /node --check scripts\/apply-poi-map-layer\.mjs/);
  assert.doesNotMatch(workflow, /node scripts\/apply-poi-map-layer\.mjs/);
  assert.match(workflow, /tests\/poi-map-layer\.test\.ts/);
});

test("the committed map already contains the POI runtime", () => {
  assert.match(map, /usePlaceMapDiscovery/);
  assert.match(map, /usePlaceMapLayer/);
  assert.match(map, /PlaceSearchResults/);
  assert.match(map, /PlaceDetailDialog/);
});
