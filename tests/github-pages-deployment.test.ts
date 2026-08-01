import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyAppCors, handleAppCorsPreflight } from "../src/lib/app-cors.server.ts";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("GitHub Pages source preparation enables SPA mode and the repository base path", async () => {
  const source = await read("scripts/prepare-github-pages-source.mjs");
  assert.match(source, /spa: \{ enabled: true \}/);
  assert.match(source, /GITHUB_PAGES_BASE_PATH/);
  assert.match(source, /VITE_SERVER_ORIGIN/);
  assert.match(source, /APP_ROUTER_BASE_PATH/);
});

test("GitHub Pages output includes the SPA fallback and disables Jekyll", async () => {
  const output = await read("scripts/prepare-github-pages-output.mjs");
  assert.match(output, /404\.html/);
  assert.match(output, /\.nojekyll/);
  assert.match(output, /manifest\.webmanifest/);
  assert.match(output, /_shell\.html/);
});

test("Vercel previews are disabled for agent branches", async () => {
  const vercel = JSON.parse(await read("vercel.json"));
  assert.equal(vercel.git.deploymentEnabled["agent/*"], false);
});

test("the Vercel fallback allows only the GitHub Pages origin", () => {
  const allowedRequest = new Request("https://event-horizon-finder.vercel.app/api", {
    method: "OPTIONS",
    headers: { origin: "https://mtnrconcept.github.io" },
  });
  const allowed = handleAppCorsPreflight(allowedRequest);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://mtnrconcept.github.io");

  const deniedRequest = new Request("https://event-horizon-finder.vercel.app/api", {
    method: "OPTIONS",
    headers: { origin: "https://example.invalid" },
  });
  assert.equal(handleAppCorsPreflight(deniedRequest).status, 403);

  const proxied = applyAppCors(allowedRequest, new Response("ok"));
  assert.equal(proxied.headers.get("access-control-allow-origin"), "https://mtnrconcept.github.io");
});
