import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, from, to) {
  const source = readFileSync(path, "utf8");
  if (!source.includes(from)) {
    throw new Error(`Expected block not found in ${path}: ${from.slice(0, 120)}`);
  }
  writeFileSync(path, source.replace(from, to));
}

const mapPath = "src/routes/map.tsx";
replaceOnce(
  mapPath,
  'const MAP_VIEWPORT_REFRESH_DELAY_MS = 220;',
  'const MAP_VIEWPORT_REFRESH_DELAY_MS = 320;',
);
replaceOnce(
  mapPath,
  '      map.setLayoutProperty(layer.id, "visibility", "none");',
  '      if (map.getLayoutProperty(layer.id, "visibility") !== "none") {\n        map.setLayoutProperty(layer.id, "visibility", "none");\n      }',
);
replaceOnce(
  mapPath,
  '    map.on("moveend", scheduleViewportCapture);\n    map.on("zoomend", scheduleViewportCapture);\n    map.on("resize", scheduleViewportCapture);',
  '    // `zoomend` is always followed by `moveend`; listening to both creates\n    // duplicate timers and duplicate viewport requests on every pinch gesture.\n    map.on("moveend", scheduleViewportCapture);\n    map.on("resize", scheduleViewportCapture);',
);
replaceOnce(
  mapPath,
  '      map.off("moveend", scheduleViewportCapture);\n      map.off("zoomend", scheduleViewportCapture);\n      map.off("resize", scheduleViewportCapture);',
  '      map.off("moveend", scheduleViewportCapture);\n      map.off("resize", scheduleViewportCapture);',
);
replaceOnce(
  mapPath,
  `  useEffect(() => {\n    const map = mapInstance;\n    if (!map || !mapReady || readyStyle?.map !== map) return;\n    syncClusterLayers(map, eventMapPoints, compactPinBatch.clustered);\n  }, [compactPinBatch.clustered, eventMapPoints, mapInstance, mapReady, readyStyle]);`,
  `  useEffect(() => {\n    const map = mapInstance;\n    if (!map || !mapReady || readyStyle?.map !== map) return;\n\n    let frame = 0;\n    const applySourceUpdate = () => {\n      window.cancelAnimationFrame(frame);\n      frame = window.requestAnimationFrame(() => {\n        if (!map.getCanvas().isConnected || !map.isStyleLoaded()) return;\n        syncClusterLayers(map, eventMapPoints, compactPinBatch.clustered);\n      });\n    };\n\n    // Parsing a large GeoJSON payload or rebuilding a clustered source during\n    // a touch gesture blocks MapLibre's render thread. Keep the previous pins\n    // visible and apply the new batch only after camera movement has settled.\n    if (map.isMoving() || map.isZooming() || map.isRotating()) {\n      map.once("moveend", applySourceUpdate);\n    } else {\n      applySourceUpdate();\n    }\n\n    return () => {\n      window.cancelAnimationFrame(frame);\n      map.off("moveend", applySourceUpdate);\n    };\n  }, [compactPinBatch.clustered, eventMapPoints, mapInstance, mapReady, readyStyle]);`,
);

const placeLayerPath = "src/hooks/usePlaceMapLayer.ts";
replaceOnce(
  placeLayerPath,
  `  useEffect(() => {\n    if (!map || !ready || !map.isStyleLoaded()) return;\n    const nextData = enabled ? collection : EMPTY_COLLECTION;\n    ensurePlaceSourceAndLayers(map, nextData, pinBatch.clustered);\n  }, [collection, enabled, map, pinBatch.clustered, ready, styleRevision]);`,
  `  useEffect(() => {\n    if (!map || !ready || !map.isStyleLoaded()) return;\n    const nextData = enabled ? collection : EMPTY_COLLECTION;\n    let frame = 0;\n    const applySourceUpdate = () => {\n      window.cancelAnimationFrame(frame);\n      frame = window.requestAnimationFrame(() => {\n        if (!map.getCanvas().isConnected || !map.isStyleLoaded()) return;\n        ensurePlaceSourceAndLayers(map, nextData, pinBatch.clustered);\n      });\n    };\n\n    if (map.isMoving() || map.isZooming() || map.isRotating()) {\n      map.once("moveend", applySourceUpdate);\n    } else {\n      applySourceUpdate();\n    }\n\n    return () => {\n      window.cancelAnimationFrame(frame);\n      map.off("moveend", applySourceUpdate);\n    };\n  }, [collection, enabled, map, pinBatch.clustered, ready, styleRevision]);`,
);

const testPath = "tests/map-interaction-performance.test.ts";
writeFileSync(
  testPath,
  `import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nimport test from "node:test";\n\nconst mapSource = readFileSync("src/routes/map.tsx", "utf8");\nconst placeLayerSource = readFileSync("src/hooks/usePlaceMapLayer.ts", "utf8");\n\ntest("viewport refresh is emitted once per completed camera gesture", () => {\n  assert.match(mapSource, /map\\.on\\("moveend", scheduleViewportCapture\\)/);\n  assert.doesNotMatch(mapSource, /map\\.on\\("zoomend", scheduleViewportCapture\\)/);\n});\n\ntest("event and place GeoJSON updates wait until camera movement settles", () => {\n  assert.match(mapSource, /map\\.isMoving\\(\\) \\|\\| map\\.isZooming\\(\\) \\|\\| map\\.isRotating\\(\\)/);\n  assert.match(placeLayerSource, /map\\.isMoving\\(\\) \\|\\| map\\.isZooming\\(\\) \\|\\| map\\.isRotating\\(\\)/);\n});\n\ntest("basemap POI visibility is not rewritten on every pin refresh", () => {\n  assert.match(mapSource, /getLayoutProperty\\(layer\\.id, "visibility"\\) !== "none"/);\n});\n`,
);

replaceOnce(
  "package.json",
  'tests/map-surface.test.ts tests/map-viewport.test.ts',
  'tests/map-surface.test.ts tests/map-viewport.test.ts tests/map-interaction-performance.test.ts',
);
