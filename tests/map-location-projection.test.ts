import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { locationClusterSelectionBounds } from "../src/lib/map-cluster-config.ts";
import { parseCompactMapPinBatch } from "../src/lib/map-pins.ts";

const migration = readFileSync(
  new URL("../supabase/migrations/20260802012208_map_location_projection_v7.sql", import.meta.url),
  "utf8",
);
const route = readFileSync(new URL("../src/routes/map.tsx", import.meta.url), "utf8");
const queries = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");

test("v7 keeps grid clusters until street zoom then emits one marker per location", () => {
  assert.match(migration, /when _zoom >= 14 then 14/);
  assert.match(migration, /'cluster_mode', 'grid'/);
  assert.match(migration, /'cluster_mode', 'location'/);
  assert.match(migration, /group by longitude, latitude/);
  assert.match(migration, /when count\(\*\) = 1 then/);
  assert.match(migration, /else jsonb_build_array\(\s*'cluster'/);
  assert.doesNotMatch(migration, /delete from|truncate table|drop table/i);
});

test("the client requests v7 and retains a complete rolling fallback chain", () => {
  assert.match(queries, /rpc\("discover_map_pins_in_bounds_v7"/);
  assert.match(queries, /\["v6", "v5", "v4", "v3", "v2"\]/);
});

test("terminal location groups are loaded in pages only after selection", () => {
  assert.match(route, /loadServerLocationSelectionPage/);
  assert.match(route, /discoverMapEventsInBounds\(\{/);
  assert.match(route, /limit: page\.limit/);
  assert.match(route, /offset: page\.offset/);
  assert.doesNotMatch(route, /requestMapPinReload\(\);\s*return;\s*}\s*map\.easeTo/);
});

test("location cluster selection uses the same five-decimal spatial cell", () => {
  assert.deepEqual(locationClusterSelectionBounds(6.14561, 46.20176), {
    west: 6.1456,
    south: 46.20175,
    east: 6.14562,
    north: 46.20177,
  });
  assert.equal(locationClusterSelectionBounds(Number.NaN, 46.2), null);
});

test("v7 location batches stay server-grouped and reusable", () => {
  const batch = parseCompactMapPinBatch({
    version: 7,
    clustered: true,
    cluster_mode: "location",
    truncated: false,
    total_count: 24,
    free_count: 3,
    pins: [["cluster", "location:6.1456:46.20176", 6.1456, 46.20176, "culture", 1, 0, "", 24, 3]],
  });

  assert.equal(batch.clustered, true);
  assert.equal(batch.clusterMode, "location");
  assert.equal(batch.pins.length, 1);
  assert.equal(batch.totalCount, 24);
});
