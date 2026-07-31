import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  MAP_EVENT_PAGE_SIZE,
  MAP_INITIAL_GEOLOCATION_OPTIONS,
  MAP_REFINEMENT_GEOLOCATION_OPTIONS,
  MOBILE_LIST_BATCH_SIZE,
} from "../src/lib/map-loading.ts";
import {
  isTransientMapRequestError,
  jitteredMapRetryDelay,
  runMapRequestWithRetry,
} from "../src/lib/map-network-retry.ts";
import {
  EVENT_ARTWORK_FAILED_URL_CACHE_LIMIT,
  clearFailedEventArtworkUrls,
  getLocalEventArtworkUrl,
  getSafeEventArtworkSourceUrl,
  hasFailedEventArtworkUrl,
  rememberFailedEventArtworkUrl,
} from "../src/lib/event-artwork.ts";

test("default map discovery stays within the next twelve months", () => {
  const route = readFileSync(new URL("../src/routes/map.tsx", import.meta.url), "utf8");

  assert.match(route, /useMemo\(\(\) => computeRange\(range\), \[range\]\)/);
  assert.doesNotMatch(route, /2100-01-01|MAP_ALL_UPCOMING_END/);
  assert.match(route, /12 prochains mois/);
});

test("rich map cards are fetched in progressive display-sized pages", () => {
  assert.equal(MOBILE_LIST_BATCH_SIZE, 24);
  assert.equal(MAP_EVENT_PAGE_SIZE, 48);
  assert.ok(MAP_EVENT_PAGE_SIZE <= MOBILE_LIST_BATCH_SIZE * 2);
});

test("map location starts coarse and refines without blocking first paint", () => {
  assert.equal(MAP_INITIAL_GEOLOCATION_OPTIONS.enableHighAccuracy, false);
  assert.equal(MAP_INITIAL_GEOLOCATION_OPTIONS.timeout, 4_000);
  assert.equal(MAP_REFINEMENT_GEOLOCATION_OPTIONS.enableHighAccuracy, true);
});

test("map pins stay compact and event content is loaded only on demand", () => {
  const queries = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/routes/map.tsx", import.meta.url), "utf8");

  assert.match(queries, /rpc\("discover_map_pins_in_bounds_v4"/);
  assert.match(queries, /rpc\("discover_map_pins_in_bounds_v3"/);
  assert.match(queries, /rpc\("get_map_occurrence_detail_v1"/);
  assert.match(route, /clusterLeafPageRequest/);
  assert.doesNotMatch(route, /loadAllClusterLeaves/);
  assert.doesNotMatch(route, /resolveEventHoverPreview/);
  assert.doesNotMatch(route, /includeDescription:\s*true/);
});

test("map RPC retries are bounded, jittered, and limited to transient failures", async () => {
  const delays: number[] = [];
  let calls = 0;
  const result = await runMapRequestWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw { status: 503, message: "Service unavailable" };
      return "ready";
    },
    {
      delaysMs: [100, 200],
      random: () => 0.5,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    },
  );

  assert.equal(result, "ready");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.equal(
    jitteredMapRetryDelay(1_000, () => 0),
    800,
  );
  assert.equal(
    jitteredMapRetryDelay(1_000, () => 1),
    1_200,
  );
  assert.equal(isTransientMapRequestError({ code: "57014" }), true);
  assert.equal(isTransientMapRequestError({ code: "53300" }), true);
  assert.equal(isTransientMapRequestError({ code: "57P01" }), true);
  assert.equal(isTransientMapRequestError({ code: "08006" }), true);
  assert.equal(isTransientMapRequestError({ code: "PGRST001" }), true);
});

test("map RPC retries never repeat aborted or permanent requests", async () => {
  for (const failure of [
    Object.assign(new Error("aborted"), { name: "AbortError" }),
    { status: 400, code: "22P02", message: "invalid input syntax" },
  ]) {
    let calls = 0;
    let sleeps = 0;
    await assert.rejects(
      runMapRequestWithRetry(
        async () => {
          calls += 1;
          throw failure;
        },
        {
          delaysMs: [1, 1],
          sleep: async () => {
            sleeps += 1;
          },
        },
      ),
    );
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
  }
});

test("map list refresh keeps the last successful rows visible while reloading", () => {
  const route = readFileSync(new URL("../src/routes/map.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(route, /setEvents\(\[\]\)/);
  assert.match(route, /discoverMapEventsInBounds\([\s\S]*controller\.signal,\s*\)/);
});

test("event artwork blocks placeholder hosts and falls back locally with a bounded failure cache", () => {
  clearFailedEventArtworkUrls();
  assert.equal(getSafeEventArtworkSourceUrl("https://images.com/concert-jazz.jpg"), null);
  assert.equal(
    getSafeEventArtworkSourceUrl("https://www.centreart.ch/images/exposition_peinture.jpg"),
    null,
  );
  assert.equal(getSafeEventArtworkSourceUrl("http://www.festivaljazz.ch/image.jpg"), null);
  assert.equal(getSafeEventArtworkSourceUrl("https://cdn.festival.example.org/concert.jpg"), null);
  assert.equal(
    getSafeEventArtworkSourceUrl("https://media.global-party.app/concert.jpg"),
    "https://media.global-party.app/concert.jpg",
  );
  assert.match(getLocalEventArtworkUrl("event-1"), /^data:image\/svg\+xml/);

  for (let index = 0; index <= EVENT_ARTWORK_FAILED_URL_CACHE_LIMIT; index += 1) {
    rememberFailedEventArtworkUrl(`https://broken.example.test/${index}.jpg`);
  }
  assert.equal(hasFailedEventArtworkUrl("https://broken.example.test/0.jpg"), false);
  assert.equal(
    hasFailedEventArtworkUrl(
      `https://broken.example.test/${EVENT_ARTWORK_FAILED_URL_CACHE_LIMIT}.jpg`,
    ),
    true,
  );
  clearFailedEventArtworkUrls();
});
