import { readFile, writeFile } from "node:fs/promises";

const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const testPath = new URL("../tests/map-basemap-loading.test.ts", import.meta.url);
const queriesPath = new URL("../src/lib/queries.ts", import.meta.url);

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Expected ${label} fragment was not found`);
  }
  return source.replace(before, after);
}

let source = await readFile(mapPath, "utf8");
source = replaceOnce(
  source,
  "const MAP_VIEWPORT_REFRESH_DELAY_MS = 220;\n",
  [
    "const MAP_VIEWPORT_REFRESH_DELAY_MS = 220;",
    "const MAP_PRIMARY_STYLE_TIMEOUT_MS = 3_500;",
    "const MAP_REVEAL_TIMEOUT_MS = 2_000;",
    "",
  ].join("\n"),
  "map loading constants",
);

const originalLoadingBlock = `    let primaryStyleLoaded = false;
    const markMapReady = () => {
      setReadyMap(map);
    };
    const fallbackTimer = window.setTimeout(() => {
      if (primaryStyleLoaded) return;
      map.setStyle(RASTER_FALLBACK_STYLE);
    }, 8_000);
    // A raster provider can be slow or blocked while the WebGL canvas is
    // already usable. Do not let the loading veil hide the map indefinitely.
    const revealTimer = window.setTimeout(() => {
      map.resize();
      setReadyMap(map);
    }, 2_500);
    map.once("render", markMapReady);
    map.on("load", markMapReady);
    map.on("style.load", () => {
      primaryStyleLoaded = true;
`;
const resilientLoadingBlock = `    let primaryStyleLoaded = false;
    let rasterFallbackApplied = false;
    let primaryStyleErrorCount = 0;
    const markMapReady = () => {
      setReadyMap(map);
    };
    const applyRasterFallback = () => {
      if (primaryStyleLoaded || rasterFallbackApplied) return;
      rasterFallbackApplied = true;
      map.setStyle(RASTER_FALLBACK_STYLE);
    };
    const fallbackTimer = window.setTimeout(
      applyRasterFallback,
      MAP_PRIMARY_STYLE_TIMEOUT_MS,
    );
    const handleMapError = () => {
      if (primaryStyleLoaded || rasterFallbackApplied) return;
      primaryStyleErrorCount += 1;
      if (primaryStyleErrorCount >= 3) applyRasterFallback();
    };
    // Prefer the vector style on every device. The former mobile-only public
    // raster path could leave a fully interactive but blank grey canvas when
    // that tile host was throttled. Raster remains a bounded fallback only.
    const revealTimer = window.setTimeout(() => {
      map.resize();
      setReadyMap(map);
    }, MAP_REVEAL_TIMEOUT_MS);
    map.once("render", markMapReady);
    map.on("load", markMapReady);
    map.on("error", handleMapError);
    map.on("style.load", () => {
      if (!rasterFallbackApplied) primaryStyleLoaded = true;
      if (primaryStyleLoaded) window.clearTimeout(fallbackTimer);
`;
source = replaceOnce(
  source,
  originalLoadingBlock,
  resilientLoadingBlock,
  "progressive basemap loading",
);
source = replaceOnce(
  source,
  `      window.clearTimeout(fallbackTimer);
      window.clearTimeout(revealTimer);
`,
  `      map.off("error", handleMapError);
      window.clearTimeout(fallbackTimer);
      window.clearTimeout(revealTimer);
`,
  "basemap cleanup",
);
await writeFile(mapPath, source);

let queries = await readFile(queriesPath, "utf8");
const originalQueryChain = `      // database types include v5.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const request = (supabase as any).rpc("discover_map_pins_in_bounds_v5", args).retry(false);
      let { data, error } = await (signal ? request.abortSignal(signal) : request);
      if (error && ["42883", "PGRST202"].includes(error.code ?? "")) {
        // Keep the map available during the short migration/frontend overlap.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fallback = (supabase as any).rpc("discover_map_pins_in_bounds_v4", args).retry(false);
        ({ data, error } = await (signal ? fallback.abortSignal(signal) : fallback));
      }
      if (error && ["42883", "PGRST202"].includes(error.code ?? "")) {
        // Preserve compatibility with installations that have not received v4 yet.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fallback = (supabase as any).rpc("discover_map_pins_in_bounds_v3", args).retry(false);
        ({ data, error } = await (signal ? fallback.abortSignal(signal) : fallback));
      }
      if (error && ["42883", "PGRST202"].includes(error.code ?? "")) {
        // Preserve compatibility with installations that have not received v3 yet.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const legacyFallback = (supabase as any)
          .rpc("discover_map_pins_in_bounds_v2", args)
          .retry(false);
        ({ data, error } = await (signal ? legacyFallback.abortSignal(signal) : legacyFallback));
      }
`;
const upgradedQueryChain = `      // Keep the cast at the additive RPC rollout boundary until generated
      // database types include v6.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const request = (supabase as any).rpc("discover_map_pins_in_bounds_v6", args).retry(false);
      let { data, error } = await (signal ? request.abortSignal(signal) : request);
      for (const fallbackVersion of ["v5", "v4", "v3", "v2"] as const) {
        if (!error || !["42883", "PGRST202"].includes(error.code ?? "")) break;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fallback = (supabase as any)
          .rpc(\`discover_map_pins_in_bounds_\${fallbackVersion}\`, args)
          .retry(false);
        ({ data, error } = await (signal ? fallback.abortSignal(signal) : fallback));
      }
`;
queries = replaceOnce(
  queries,
  originalQueryChain,
  upgradedQueryChain,
  "complete v6 map pin fallback chain",
);
await writeFile(queriesPath, queries);

const testSource = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mapSource = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");
const queriesSource = await readFile(new URL("../src/lib/queries.ts", import.meta.url), "utf8");

test("the vector basemap is the primary mobile and desktop style", () => {
  assert.match(mapSource, /style: PRIMARY_MAP_STYLE/);
  assert.doesNotMatch(mapSource, /style: RASTER_FALLBACK_STYLE,\\n        center/);
});

test("raster fallback remains bounded and reacts to repeated style errors", () => {
  assert.match(mapSource, /MAP_PRIMARY_STYLE_TIMEOUT_MS = 3_500/);
  assert.match(mapSource, /primaryStyleErrorCount >= 3/);
  assert.match(mapSource, /map\\.setStyle\\(RASTER_FALLBACK_STYLE\\)/);
  assert.match(mapSource, /map\\.off\\("error", handleMapError\\)/);
});

test("the safety reveal does not keep a working canvas covered", () => {
  assert.match(mapSource, /MAP_REVEAL_TIMEOUT_MS = 2_000/);
  assert.match(mapSource, /map\\.once\\("render", markMapReady\\)/);
});

test("the deployed map keeps every rolling RPC fallback", () => {
  assert.match(queriesSource, /discover_map_pins_in_bounds_v6/);
  assert.match(queriesSource, /\\["v5", "v4", "v3", "v2"\\]/);
});
`;
await writeFile(testPath, testSource);
