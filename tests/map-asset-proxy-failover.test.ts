import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/map-asset-proxy") {
      return {
        shortCircuit: true,
        url: new URL("../src/lib/map-asset-proxy.ts", import.meta.url).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { handleMapAssetProxy } = await import("../src/lib/map-asset-proxy.server.ts");

const TARGET = "https://tiles.openfreemap.org/styles/positron";
const REQUEST = new Request(
  `https://globalparty.example/api/map-assets?url=${encodeURIComponent(TARGET)}`,
);

test("map asset proxy redirects to the allowlisted upstream after transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw new TypeError("upstream unavailable");
  };
  const transportFailure = await handleMapAssetProxy(REQUEST);
  assert.equal(transportFailure.status, 307);
  assert.equal(transportFailure.headers.get("location"), TARGET);
  assert.equal(transportFailure.headers.get("cache-control"), "no-store");

  globalThis.fetch = async () => new Response(null, { status: 503 });
  const upstreamFailure = await handleMapAssetProxy(REQUEST);
  assert.equal(upstreamFailure.status, 307);
  assert.equal(upstreamFailure.headers.get("location"), TARGET);
});

test("map asset proxy preserves permanent upstream errors", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(null, { status: 404 });
  const response = await handleMapAssetProxy(REQUEST);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("location"), null);
});
