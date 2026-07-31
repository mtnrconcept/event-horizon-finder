import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  MAP_EVENT_PAGE_SIZE,
  MAP_INITIAL_GEOLOCATION_OPTIONS,
  MAP_REFINEMENT_GEOLOCATION_OPTIONS,
  MOBILE_LIST_BATCH_SIZE,
} from "../src/lib/map-loading.ts";

test("default map discovery stays within the next twelve months", () => {
  const route = readFileSync(new URL("../src/routes/map.tsx", import.meta.url), "utf8");

  assert.match(route, /useMemo\(\(\) => computeRange\(range\), \[range\]\)/);
  assert.doesNotMatch(route, /2100-01-01|MAP_ALL_UPCOMING_END/);
  assert.match(route, /12 prochains mois/);
});

test("rich map cards are fetched in progressive display-sized pages", () => {
  assert.equal(MOBILE_LIST_BATCH_SIZE, 24);
  assert.equal(MAP_EVENT_PAGE_SIZE, 48);
  assert.ok(MAP_EVENT_PAGE_SIZE <= MOBILE_LIST_BATCH_SIZE * 2);
});

test("map location starts coarse and refines without blocking first paint", () => {
  assert.equal(MAP_INITIAL_GEOLOCATION_OPTIONS.enableHighAccuracy, false);
  assert.equal(MAP_INITIAL_GEOLOCATION_OPTIONS.timeout, 4_000);
  assert.equal(MAP_REFINEMENT_GEOLOCATION_OPTIONS.enableHighAccuracy, true);
});
