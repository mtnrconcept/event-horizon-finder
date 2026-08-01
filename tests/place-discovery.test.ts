import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/lib/place-discovery.ts", import.meta.url), "utf8");

test("place discovery exposes pin and list viewport RPCs", () => {
  assert.match(source, /discover_place_pins_in_bounds_v1/);
  assert.match(source, /discover_places_in_bounds_v1/);
  assert.match(source, /PLACE_SERVER_CLUSTER_MAX_ZOOM/);
});

test("place projection preserves full cards inside individual features", () => {
  assert.match(source, /place_json: pin\.kind === "place" \? JSON\.stringify\(pin\) : ""/);
  assert.match(source, /placeFromFeatureProperties/);
  assert.match(source, /description: nullableString/);
  assert.match(source, /opening_hours: nullableString/);
});

test("place labels, free access and accessibility are normalized", () => {
  assert.match(source, /Nature et jardin/);
  assert.match(source, /gratuit/);
  assert.match(source, /designated/);
});
