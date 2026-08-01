import { readFile, writeFile } from "node:fs/promises";

const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const testPath = new URL("../tests/map-mobile-performance-poi-filters.test.ts", import.meta.url);
let mapSource = await readFile(mapPath, "utf8");

if (!mapSource.includes("mobile_raster_fast_path")) {
  const before = [
    "    void fetch(PRIMARY_MAP_STYLE, {",
    "      signal: preferredStyleController.signal,",
    '      cache: "force-cache",',
    '      mode: "cors",',
    "    })",
  ].join("\n");
  const after = [
    "    const shouldUpgradeBasemap = !isMobileRef.current && window.devicePixelRatio <= 2;",
    "    const preferredStyleRequest = shouldUpgradeBasemap",
    "      ? fetch(PRIMARY_MAP_STYLE, {",
    "          signal: preferredStyleController.signal,",
    '          cache: "force-cache",',
    '          mode: "cors",',
    "        })",
    '      : Promise.reject(new Error("mobile_raster_fast_path"));',
    "    void preferredStyleRequest",
  ].join("\n");
  if (!mapSource.includes(before)) {
    throw new Error("Expected preferred basemap request was not found");
  }
  mapSource = mapSource.replace(before, after);
  await writeFile(mapPath, mapSource);
}

const testSource = [
  'import assert from "node:assert/strict";',
  'import { readFile } from "node:fs/promises";',
  'import test from "node:test";',
  'const map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");',
  'const filters = await readFile(new URL("../src/lib/event-filters.ts", import.meta.url), "utf8");',
  'const panel = await readFile(new URL("../src/components/event-filter-panel.tsx", import.meta.url), "utf8");',
  'test("mobile map keeps the raster fast path", () => { assert.match(map, /shouldUpgradeBasemap = !isMobileRef\\.current/); });',
  'test("place filters are persistent source code", () => { assert.match(filters, /contentMode: DiscoveryContentMode/); assert.match(filters, /placeCategories: string\\[\\]/); });',
  'test("place controls are visible", () => { assert.match(panel, /Lieux à visiter/); assert.match(panel, /Horaires renseignés/); assert.match(panel, /Accès gratuit/); });',
  "",
].join("\n");
await writeFile(testPath, testSource);
