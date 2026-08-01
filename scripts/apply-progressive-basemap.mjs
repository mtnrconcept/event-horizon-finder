import { readFile, writeFile } from "node:fs/promises";

const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const testPath = new URL("../tests/map-basemap-loading.test.ts", import.meta.url);

let source = await readFile(mapPath, "utf8");

const replacements = [
  [
    "const MAP_VIEWPORT_REFRESH_DELAY_MS = 220;\n",
    "const MAP_VIEWPORT_REFRESH_DELAY_MS = 220;\nconst MAP_PRIMARY_STYLE_PROBE_TIMEOUT_MS = 1_500;\nconst MAP_REVEAL_TIMEOUT_MS = 5_000;\n",
  ],
  ["        style: PRIMARY_MAP_STYLE,\n", "        style: RASTER_FALLBACK_STYLE,\n"],
  [
    `    let primaryStyleLoaded = false;\n    const markMapReady = () => {\n      setReadyMap(map);\n    };\n    const fallbackTimer = window.setTimeout(() => {\n      if (primaryStyleLoaded) return;\n      map.setStyle(RASTER_FALLBACK_STYLE);\n    }, 8_000);\n    // A raster provider can be slow or blocked while the WebGL canvas is\n    // already usable. Do not let the loading veil hide the map indefinitely.\n    const revealTimer = window.setTimeout(() => {\n      map.resize();\n      setReadyMap(map);\n    }, 2_500);\n`,
    `    let preferredStyleApplied = false;\n    const markMapReady = () => {\n      setReadyMap(map);\n    };\n    const preferredStyleController = new AbortController();\n    const preferredStyleTimer = window.setTimeout(\n      () => preferredStyleController.abort(),\n      MAP_PRIMARY_STYLE_PROBE_TIMEOUT_MS,\n    );\n    void fetch(PRIMARY_MAP_STYLE, {\n      signal: preferredStyleController.signal,\n      cache: "force-cache",\n      mode: "cors",\n    })\n      .then((response) => {\n        if (!response.ok) throw new Error(\`Map style probe failed: \${response.status}\`);\n        return response.json();\n      })\n      .then((style: StyleSpecification) => {\n        if (preferredStyleController.signal.aborted || preferredStyleApplied) return;\n        preferredStyleApplied = true;\n        map.setStyle(style);\n      })\n      .catch(() => undefined)\n      .finally(() => window.clearTimeout(preferredStyleTimer));\n    const revealTimer = window.setTimeout(() => {\n      map.resize();\n      setReadyMap(map);\n    }, MAP_REVEAL_TIMEOUT_MS);\n`,
  ],
  [
    `    map.once("render", markMapReady);\n    map.on("load", markMapReady);\n`,
    `    map.once("idle", markMapReady);\n`,
  ],
  [
    `    map.on("style.load", () => {\n      primaryStyleLoaded = true;\n`,
    `    map.on("style.load", () => {\n`,
  ],
  [
    `      window.clearTimeout(fallbackTimer);\n      window.clearTimeout(revealTimer);\n`,
    `      preferredStyleController.abort();\n      window.clearTimeout(preferredStyleTimer);\n      window.clearTimeout(revealTimer);\n`,
  ],
];

for (const [before, after] of replacements) {
  if (!source.includes(before)) {
    throw new Error(`Expected map source fragment was not found:\n${before.slice(0, 160)}`);
  }
  source = source.replace(before, after);
}

await writeFile(mapPath, source);

const testSource = `import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\n\nconst mapSource = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");\n\ntest("the map renders the raster fallback immediately", () => {\n  assert.match(mapSource, /style: RASTER_FALLBACK_STYLE/);\n  assert.doesNotMatch(mapSource, /style: PRIMARY_MAP_STYLE/);\n});\n\ntest("the preferred vector style is only applied after a bounded probe", () => {\n  assert.match(mapSource, /MAP_PRIMARY_STYLE_PROBE_TIMEOUT_MS = 1_500/);\n  assert.match(mapSource, /fetch\\(PRIMARY_MAP_STYLE/);\n  assert.match(mapSource, /preferredStyleController\\.abort\\(\\)/);\n  assert.match(mapSource, /map\\.setStyle\\(style\\)/);\n});\n\ntest("pins remain covered until the basemap is idle", () => {\n  assert.match(mapSource, /map\\.once\\(\"idle\", markMapReady\\)/);\n  assert.doesNotMatch(mapSource, /map\\.once\\(\"render\", markMapReady\\)/);\n  assert.doesNotMatch(mapSource, /map\\.on\\(\"load\", markMapReady\\)/);\n});\n\ntest("the safety reveal is delayed long enough for mobile tiles", () => {\n  assert.match(mapSource, /MAP_REVEAL_TIMEOUT_MS = 5_000/);\n});\n`;
await writeFile(testPath, testSource);
