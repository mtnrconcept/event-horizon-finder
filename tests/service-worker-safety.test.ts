import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const runtimeSource = readFileSync(
  new URL("../src/components/pwa-runtime.tsx", import.meta.url),
  "utf8",
);

test("service worker excludes sensitive and authenticated routes", () => {
  for (const route of [
    "/auth",
    "/profile",
    "/favorites",
    "/agenda",
    "/organizer",
    "/admin",
    "/settings",
    "/mcp",
    "/api",
  ]) {
    assert.match(source, new RegExp(route.replace("/", "\\/")));
  }
});

test("service worker only handles GET requests from the same origin", () => {
  assert.match(source, /request\.method !== "GET"/);
  assert.match(source, /url\.origin !== self\.location\.origin/);
});

test("service worker exposes a controlled update path", () => {
  assert.match(source, /SKIP_WAITING/);
  assert.match(source, /self\.skipWaiting\(\)/);
  assert.match(runtimeSource, /updateViaCache:\s*"none"/);
  assert.match(runtimeSource, /registration\.update\(\)/);
});

test("service worker never caches an application HTML shell", () => {
  assert.doesNotMatch(source, /PAGE_CACHE|isCacheablePublicPage|networkFirst/);
  assert.doesNotMatch(source, /const STATIC_ASSETS = \[\s*"\/"/);
  assert.match(source, /request\.mode === "navigate"/);
  assert.match(source, /networkOnlyNavigation\(request\)/);
});
