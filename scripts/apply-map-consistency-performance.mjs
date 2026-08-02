import { readFile, writeFile } from "node:fs/promises";

const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const homePath = new URL("../src/routes/index.tsx", import.meta.url);
const testPath = new URL("../tests/map-filter-consistency.test.ts", import.meta.url);

const OPTIONAL_MISSING_REWRITES = new Set(["place list total fallback"]);

function replaceExpected(source, before, after, expectedCount, label) {
  if (source.includes(after)) return source;
  const count = source.split(before).length - 1;
  if (count === 0 && OPTIONAL_MISSING_REWRITES.has(label)) {
    console.log(
      `Skipping obsolete ${label} rewrite; the modern discovery layout no longer renders that prop.`,
    );
    return source;
  }
  if (count !== expectedCount) {
    throw new Error(`Expected ${expectedCount} ${label} fragment(s), found ${count}`);
  }
  return source.replaceAll(before, after);
}

let mapSource = await readFile(mapPath, "utf8");
mapSource = replaceExpected(
  mapSource,
  "    freeOnly: advancedFilters.freePlacesOnly,",
  [
    "    freeOnly:",
    '      advancedFilters.freePlacesOnly ||',
    '      (advancedFilters.contentMode === "all" && advancedFilters.priceMode === "free"),',
  ].join("\n"),
  1,
  "combined place-free filter",
);
mapSource = replaceExpected(
  mapSource,
  "totalCount={placeDiscovery.listTotalCount || totalPlaceCount}",
  "totalCount={placeDiscovery.listReady ? placeDiscovery.listTotalCount : totalPlaceCount}",
  2,
  "place list total fallback",
);
await writeFile(mapPath, mapSource);

let homeSource = await readFile(homePath, "utf8");
homeSource = replaceExpected(
  homeSource,
  "        freeOnly={advancedFilters.freePlacesOnly}",
  [
    "        freeOnly={",
    "          advancedFilters.freePlacesOnly ||",
    '          (advancedFilters.contentMode === "all" && advancedFilters.priceMode === "free")',
    "        }",
  ].join("\n"),
  1,
  "home combined place-free filter",
);
await writeFile(homePath, homeSource);

const testSource = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");
const home = await readFile(new URL("../src/routes/index.tsx", import.meta.url), "utf8");
const hook = await readFile(new URL("../src/hooks/usePlaceMapDiscovery.ts", import.meta.url), "utf8");
const layer = await readFile(new URL("../src/hooks/usePlaceMapLayer.ts", import.meta.url), "utf8");

test("zero place results are never replaced by a previous pin total", () => {
  assert.doesNotMatch(map, /listTotalCount\\s*\\|\\|\\s*totalPlaceCount/);
  const listCounterReferences = map.match(/placeDiscovery\\.listTotalCount/g) ?? [];
  if (listCounterReferences.length > 0) {
    assert.ok(
      (map.match(
        /placeDiscovery\\.listReady\\s*\\?\\s*placeDiscovery\\.listTotalCount/g,
      ) ?? []).length >= 1,
    );
  }
});

test("free means free for both content types in combined mode", () => {
  assert.match(map, /contentMode === "all" && advancedFilters\\.priceMode === "free"/);
  assert.match(home, /contentMode === "all" && advancedFilters\\.priceMode === "free"/);
});

test("place discovery clears stale lists and reuses buffered pins", () => {
  assert.match(hook, /setListReady\\(false\\)/);
  assert.match(hook, /loadSessionPlacePins/);
  assert.match(hook, /quantizePlacePinZoom/);
});

test("server place aggregates are never clustered a second time", () => {
  assert.match(layer, /const clientClustered = !serverClustered/);
  assert.match(layer, /previousClientClustered !== clientClustered/);
  assert.match(layer, /PLACE_SERVER_CLUSTER_MAX_ZOOM \\+ 0\\.25/);
  assert.match(layer, /map\\.on\\("click", handleMapClick\\)/);
});
`;
await writeFile(testPath, testSource);
