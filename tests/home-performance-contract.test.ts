import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseHomeCollections } from "../src/lib/home-collections.ts";

test("home collection parser rejects malformed rows without failing the page", () => {
  const event = {
    event_id: "event-1",
    occurrence_id: "occurrence-1",
    title: "Concert",
    starts_at: "2026-07-29T20:00:00.000Z",
  };
  const parsed = parseHomeCollections({
    top: [event, null, { title: "missing identifiers" }],
    free: "invalid",
    nightlife: [event],
  });

  assert.deepEqual(parsed.top, [event]);
  assert.deepEqual(parsed.free, []);
  assert.deepEqual(parsed.nightlife, [event]);
  assert.deepEqual(parsed.festivals, []);
});

test("home page uses one composite collection request instead of four sequential scans", () => {
  const route = readFileSync(new URL("../src/routes/index.tsx", import.meta.url), "utf8");
  const effect = route.split("const loadCollections = async () =>", 2)[1]?.split("};", 1)[0] ?? "";

  assert.match(effect, /fetchHomeCollections/);
  assert.doesNotMatch(effect, /discoverEvents/);
});

test("home discovery starts from the default city without waiting for geography catalogues", () => {
  const route = readFileSync(new URL("../src/routes/index.tsx", import.meta.url), "utf8");

  assert.match(route, /defaultCitiesPromise\.then\(startDefaultDiscovery\)/);
  assert.match(route, /Promise\.all\(\[fetchGeographyCatalog\(\), defaultCitiesPromise\]\)/);
  assert.doesNotMatch(route, /fetchCategories/);
});

test("brand arrival is session-scoped, route-scoped and never preloads its video", () => {
  const root = readFileSync(new URL("../src/routes/__root.tsx", import.meta.url), "utf8");
  const arrival = readFileSync(
    new URL("../src/components/brand/brand-arrival.tsx", import.meta.url),
    "utf8",
  );
  const events = readFileSync(
    new URL("../src/lib/brand-arrival-events.ts", import.meta.url),
    "utf8",
  );

  assert.ok(root.includes('{pathname === "/" && <BrandArrival />}'));
  assert.doesNotMatch(root, /global-party-intro-poster\.jpg[\s\S]*as: "image"/);
  assert.match(arrival, /preload="none"/);
  assert.doesNotMatch(arrival, /document\.body\.style\.overflow = "hidden"/);
  assert.match(events, /sessionStorage/);
});
