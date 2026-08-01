import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/lib/place-discovery.ts", import.meta.url), "utf8");

test("place discovery exposes compact pin and rich list viewport RPCs", () => {
  assert.match(source, /discover_place_pins_in_bounds_v2/);
  assert.match(source, /discover_place_pins_in_bounds_v1/);
  assert.match(source, /discover_places_in_bounds_v1/);
  assert.match(source, /PLACE_SERVER_CLUSTER_MAX_ZOOM/);
});

test("place projection transfers only compact map properties", () => {
  assert.match(source, /interface PlaceMapPin/);
  assert.match(source, /place_count: pin\.count/);
  assert.match(source, /latitude: pin\.latitude/);
  assert.match(source, /longitude: pin\.longitude/);
  assert.doesNotMatch(source, /place_json: pin\.kind/);
});

test("rich place details are loaded and cached only after selection", () => {
  assert.match(source, /get_place_detail_v1/);
  assert.match(source, /placeDetailCache/);
  assert.match(source, /placeDetailRequests/);
  assert.match(source, /description: nullableString/);
  assert.match(source, /opening_hours: nullableString/);
});

test("place labels, free access and accessibility are normalized", () => {
  assert.match(source, /Nature et jardin/);
  assert.match(source, /gratuit/);
  assert.match(source, /designated/);
});
