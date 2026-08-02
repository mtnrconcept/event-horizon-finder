import { readFile, writeFile } from "node:fs/promises";

const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const testPath = new URL("../tests/map-mobile-performance-poi-filters.test.ts", import.meta.url);
const mapSource = await readFile(mapPath, "utf8");

const primaryVectorStylePattern =
  /style:\s*(?:mapAssetProxyUrl\(PRIMARY_MAP_STYLE\)\s*\?\?\s*)?PRIMARY_MAP_STYLE/;

if (!primaryVectorStylePattern.test(mapSource)) {
  throw new Error("The responsive map must start with the primary vector style");
}

if (mapSource.includes("mobile_raster_fast_path")) {
  throw new Error("The obsolete mobile raster-only branch is still present");
}

const testSource = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");
const filters = await readFile(new URL("../src/lib/event-filters.ts", import.meta.url), "utf8");
const panel = await readFile(
  new URL("../src/components/event-filter-panel.tsx", import.meta.url),
  "utf8",
);

test("mobile and desktop start with the vector map style", () => {
  assert.match(
    map,
    /style:\\s*(?:mapAssetProxyUrl\\(PRIMARY_MAP_STYLE\\)\\s*\\?\\?\\s*)?PRIMARY_MAP_STYLE/,
  );
  assert.doesNotMatch(map, /mobile_raster_fast_path/);
});

test("the raster style remains a bounded fallback", () => {
  assert.match(map, /map\\.setStyle\\(RASTER_FALLBACK_STYLE\\)/);
});

test("place filters are persistent source code", () => {
  assert.match(filters, /contentMode: DiscoveryContentMode/);
  assert.match(filters, /placeCategories: string\\[\\]/);
});

test("place controls are visible", () => {
  assert.match(panel, /Lieux à visiter/);
  assert.match(panel, /Horaires renseignés/);
  assert.match(panel, /Accès gratuit/);
});
`;

await writeFile(testPath, testSource);
