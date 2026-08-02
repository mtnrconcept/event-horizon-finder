import { readFile, writeFile } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Expected ${label} fragment was not found`);
  }
  return source.replace(before, after);
}

function replacePatternOnce(source, pattern, replacement, label) {
  if (!pattern.test(source)) {
    throw new Error(`Expected ${label} fragment was not found`);
  }
  return source.replace(pattern, replacement);
}

const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const placeLayerPath = new URL("../src/hooks/usePlaceMapLayer.ts", import.meta.url);
const clusterConfigPath = new URL("../src/lib/map-cluster-config.ts", import.meta.url);
const testPath = new URL("../tests/map-adaptive-rendering.test.ts", import.meta.url);

let mapSource = await readFile(mapPath, "utf8");

if (!mapSource.includes("MAP_ADAPTIVE_GLOBE_MAX_ZOOM")) {
  mapSource = replaceOnce(
    mapSource,
    "const MAP_REVEAL_TIMEOUT_MS = 2_000;\n",
    [
      "const MAP_REVEAL_TIMEOUT_MS = 2_000;",
      "const MAP_ADAPTIVE_GLOBE_MAX_ZOOM = 5.5;",
      "const MAP_3D_BUILDING_MIN_ZOOM = 15;",
      'const MAP_3D_BUILDING_LAYER_ID = "global-party-3d-buildings";',
      "",
    ].join("\n"),
    "adaptive map constants",
  );
}

if (!mapSource.includes("function prefersReducedMapEffects()")) {
  const helpers = `function prefersReducedMapEffects(): boolean {
  const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory = navigatorWithMemory.deviceMemory ?? 8;
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    cores <= 4 ||
    memory <= 4
  );
}

function findFirstLabelLayerId(map: maplibregl.Map): string | undefined {
  return map
    .getStyle()
    .layers?.find(
      (layer) =>
        layer.type === "symbol" &&
        "layout" in layer &&
        Boolean(layer.layout?.["text-field"]),
    )?.id;
}

function ensureAdaptiveBuildingLayer(map: maplibregl.Map, enabled: boolean) {
  if (!enabled || map.getLayer(MAP_3D_BUILDING_LAYER_ID)) return;
  const buildingLayer = map.getStyle().layers?.find(
    (layer) =>
      layer.type === "fill" &&
      "source-layer" in layer &&
      typeof layer["source-layer"] === "string" &&
      /building/i.test(layer["source-layer"]),
  );
  if (
    !buildingLayer ||
    !("source" in buildingLayer) ||
    typeof buildingLayer.source !== "string" ||
    !("source-layer" in buildingLayer) ||
    typeof buildingLayer["source-layer"] !== "string"
  )
    return;
  const sourceLayer = buildingLayer["source-layer"];
  if (typeof sourceLayer !== "string") return;

  map.addLayer(
    {
      id: MAP_3D_BUILDING_LAYER_ID,
      type: "fill-extrusion",
      source: buildingLayer.source,
      "source-layer": sourceLayer,
      minzoom: MAP_3D_BUILDING_MIN_ZOOM,
      filter: ["!=", ["get", "hide_3d"], true],
      paint: {
        "fill-extrusion-color": [
          "interpolate",
          ["linear"],
          ["zoom"],
          MAP_3D_BUILDING_MIN_ZOOM,
          "#d7dbe3",
          18,
          "#c1c7d0",
        ],
        "fill-extrusion-height": [
          "coalesce",
          ["to-number", ["get", "render_height"]],
          ["to-number", ["get", "height"]],
          ["*", ["to-number", ["get", "building:levels"]], 3],
          4,
        ],
        "fill-extrusion-base": [
          "coalesce",
          ["to-number", ["get", "render_min_height"]],
          ["to-number", ["get", "min_height"]],
          0,
        ],
        "fill-extrusion-opacity": 0.72,
      },
    } as maplibregl.LayerSpecification,
    findFirstLabelLayerId(map),
  );
}

function syncAdaptiveMapRendering(
  map: maplibregl.Map,
  reducedEffects: boolean,
  allowBuildings: boolean,
) {
  const targetProjection =
    !reducedEffects && map.getZoom() < MAP_ADAPTIVE_GLOBE_MAX_ZOOM ? "globe" : "mercator";
  const currentProjection = map.getProjection();
  if (currentProjection && currentProjection.type !== targetProjection) {
    map.setProjection({ type: targetProjection });
  }
  ensureAdaptiveBuildingLayer(map, allowBuildings && !reducedEffects);
}

`;
  mapSource = replaceOnce(
    mapSource,
    "function mapFeatureHitKind(feature: MapGeoJSONFeature): MapHitKind | null {\n",
    `${helpers}function mapFeatureHitKind(feature: MapGeoJSONFeature): MapHitKind | null {\n`,
    "adaptive rendering helpers",
  );
}

if (!mapSource.includes("const reducedMapEffects = prefersReducedMapEffects();")) {
  mapSource = replacePatternOnce(
    mapSource,
    /    try \{\n(?=      map = new maplibregl\.Map\(\{\n        container: activeMapContainer,)/,
    [
      "    const reducedMapEffects = prefersReducedMapEffects();",
      "    const allow3DBuildings = !isMobileRef.current && !reducedMapEffects;",
      "    try {",
      "",
    ].join("\n"),
    "adaptive map constructor prelude",
  );
}

if (!mapSource.includes("canvasContextAttributes: { antialias: allow3DBuildings }")) {
  mapSource = replacePatternOnce(
    mapSource,
    /(map = new maplibregl\.Map\(\{[\s\S]*?        zoom: initialCamera\.zoom,\n)/,
    `$1        pitch:
          allow3DBuildings && initialCamera.zoom >= MAP_3D_BUILDING_MIN_ZOOM ? 45 : 0,
        maxPitch: allow3DBuildings ? 70 : 0,
`,
    "adaptive map constructor camera options",
  );

  mapSource = replacePatternOnce(
    mapSource,
    /(map = new maplibregl\.Map\(\{[\s\S]*?        fadeDuration: 0,\n)/,
    `$1        validateStyle: false,
        canvasContextAttributes: { antialias: allow3DBuildings },
`,
    "adaptive map constructor rendering options",
  );
}

if (!mapSource.includes("function scheduleAdaptiveRendering()")) {
  mapSource = replaceOnce(
    mapSource,
    `      setReadyStyle((current) => ({
        map,
        revision: current?.map === map ? current.revision + 1 : 1,
      }));
      markMapReady();
`,
    `      setReadyStyle((current) => ({
        map,
        revision: current?.map === map ? current.revision + 1 : 1,
      }));
      scheduleAdaptiveRendering();
      markMapReady();
`,
    "adaptive style-load scheduling",
  );

  mapSource = replaceOnce(
    mapSource,
    `    map.on("styledata", () => {
      if (map.isStyleLoaded()) setReadyMap(map);
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
`,
    `    map.on("styledata", () => {
      if (map.isStyleLoaded()) setReadyMap(map);
    });
    let adaptiveRenderingFrame = 0;
    function scheduleAdaptiveRendering() {
      window.cancelAnimationFrame(adaptiveRenderingFrame);
      adaptiveRenderingFrame = window.requestAnimationFrame(() => {
        adaptiveRenderingFrame = 0;
        if (map.isMoving() || !map.isStyleLoaded()) return;
        syncAdaptiveMapRendering(map, reducedMapEffects, allow3DBuildings);
      });
    }
    map.on("zoomend", scheduleAdaptiveRendering);
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: allow3DBuildings }),
      "top-right",
    );
`,
    "adaptive style and zoom handlers",
  );
}

if (!mapSource.includes('map.off("zoomend", scheduleAdaptiveRendering);')) {
  mapSource = replaceOnce(
    mapSource,
    `      map.off("error", handleMapError);
      map.off("idle", handleMapIdle);
`,
    `      map.off("error", handleMapError);
      map.off("idle", handleMapIdle);
      map.off("zoomend", scheduleAdaptiveRendering);
      window.cancelAnimationFrame(adaptiveRenderingFrame);
`,
    "adaptive rendering cleanup",
  );
}

await writeFile(mapPath, mapSource);

let placeLayer = await readFile(placeLayerPath, "utf8");
if (!placeLayer.includes("maxzoom: 16")) {
  placeLayer = replaceOnce(
    placeLayer,
    `      clusterMaxZoom: PLACE_CLUSTER_MAX_ZOOM,
      ...(clientClustered
`,
    `      clusterMaxZoom: PLACE_CLUSTER_MAX_ZOOM,
      maxzoom: 16,
      buffer: 64,
      tolerance: 0.75,
      ...(clientClustered
`,
    "place GeoJSON worker limits",
  );
}
await writeFile(placeLayerPath, placeLayer);

let clusterConfig = await readFile(clusterConfigPath, "utf8");
clusterConfig = clusterConfig.replace(
  "export const EVENT_SOURCE_MAX_ZOOM = 22;",
  "export const EVENT_SOURCE_MAX_ZOOM = 16;",
);
await writeFile(clusterConfigPath, clusterConfig);

const testSource = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");
const places = await readFile(new URL("../src/hooks/usePlaceMapLayer.ts", import.meta.url), "utf8");
const clusters = await readFile(new URL("../src/lib/map-cluster-config.ts", import.meta.url), "utf8");

test("the map uses adaptive globe rather than a permanently expensive 3D scene", () => {
  assert.match(map, /MAP_ADAPTIVE_GLOBE_MAX_ZOOM = 5\\.5/);
  assert.match(map, /map\\.setProjection\\(\\{ type: targetProjection \\}\\)/);
  assert.match(map, /currentProjection && currentProjection\\.type !== targetProjection/);
  assert.match(map, /targetProjection[\\s\\S]*\\? "globe" : "mercator"/);
});

test("projection changes wait until MapLibre has finished the active zoom render", () => {
  assert.match(map, /function scheduleAdaptiveRendering\\(\\)/);
  assert.match(map, /requestAnimationFrame\\(\\(\\) => \\{/);
  assert.match(map, /map\\.isMoving\\(\\) \\|\\| !map\\.isStyleLoaded\\(\\)/);
  assert.match(map, /map\\.on\\("zoomend", scheduleAdaptiveRendering\\)/);
  assert.match(map, /cancelAnimationFrame\\(adaptiveRenderingFrame\\)/);
});

test("3D buildings reuse the loaded vector source and stay desktop-only", () => {
  assert.match(map, /MAP_3D_BUILDING_MIN_ZOOM = 15/);
  assert.match(map, /type: "fill-extrusion"/);
  assert.match(map, /allow3DBuildings = !isMobileRef\\.current/);
  assert.doesNotMatch(map, /tiles\\.openfreemap\\.org\\/planet/);
});

test("slow devices avoid antialiasing, pitch and decorative map effects", () => {
  assert.match(map, /prefersReducedMapEffects/);
  assert.match(map, /hardwareConcurrency/);
  assert.match(map, /deviceMemory/);
  assert.match(map, /canvasContextAttributes: \\{ antialias: allow3DBuildings \\}/);
});

test("adaptive rendering preserves proxied style and asset request routing", () => {
  assert.match(map, /style: mapAssetProxyUrl\\(PRIMARY_MAP_STYLE\\) \\?\\? PRIMARY_MAP_STYLE/);
  assert.match(map, /transformRequest: transformMapAssetRequest/);
});

test("point sources cap worker tile generation and reduce buffer work", () => {
  assert.match(places, /maxzoom: 16/);
  assert.match(places, /buffer: 64/);
  assert.match(places, /tolerance: 0\\.75/);
  assert.match(clusters, /EVENT_SOURCE_MAX_ZOOM = 16/);
});
`;

await writeFile(testPath, testSource);
