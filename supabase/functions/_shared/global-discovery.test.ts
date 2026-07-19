import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLocalizedDiscoveryQueries,
  buildMultilingualDiscoveryQueries,
  canonicalizeHttpUrl,
  normalizeSearxngResults,
  searchResultDomain,
  selectAdaptiveCityLimit,
  selectLargestCities,
} from "./global-discovery.ts";

test("national population tiers select 1/3/8/15/25/40/50 cities", () => {
  assert.deepEqual(
    [0, 100_000, 1_000_000, 5_000_000, 20_000_000, 50_000_000, 100_000_000].map((population) =>
      selectAdaptiveCityLimit(population),
    ),
    [1, 3, 8, 15, 25, 40, 50],
  );
  assert.equal(selectAdaptiveCityLimit(200_000_000, 12), 12);
  assert.equal(selectAdaptiveCityLimit(10_000_000, 0), 0);
  assert.equal(selectAdaptiveCityLimit(undefined), 1);
});

test("largest-city selection is deterministic and does not mutate its input", () => {
  const cities = [
    { name: "Small", population: 20_000 },
    { name: "Large", population: 2_000_000 },
    { name: "Medium", population: 500_000 },
    { name: "Unknown", population: null },
  ];
  const snapshot = structuredClone(cities);

  assert.deepEqual(
    selectLargestCities(cities, 150_000).map((city) => city.name),
    ["Large", "Medium", "Small"],
  );
  assert.deepEqual(cities, snapshot);
});

test("French discovery builds the four requested day/month query families", () => {
  const queries = buildLocalizedDiscoveryQueries({
    cityName: "  Genève ",
    countryName: "Suisse",
    date: "2026-07-27",
    locale: "fr_CH",
  });

  assert.deepEqual(
    queries.map(({ family, query, dateScope }) => ({ family, query, dateScope })),
    [
      {
        family: "nightlife",
        query: "Agenda soirées Genève, Suisse 27 juillet 2026",
        dateScope: "day",
      },
      {
        family: "family",
        query: "Agenda sorties en famille à Genève, Suisse juillet 2026",
        dateScope: "month",
      },
      {
        family: "outdoor",
        query: "Activités de plein air à Genève, Suisse juillet 2026",
        dateScope: "month",
      },
      {
        family: "culture",
        query: "Agenda culturel Genève, Suisse juillet 2026",
        dateScope: "month",
      },
    ],
  );
  assert.ok(queries.every((query) => query.locale === "fr-CH"));
  assert.ok(queries.every((query) => query.dateKey === "2026-07-27"));
  assert.ok(queries.every((query) => query.monthKey === "2026-07"));
});

test("unsupported query locales fall back to English templates", () => {
  const queries = buildLocalizedDiscoveryQueries({
    cityName: "Nairobi",
    date: "2026-07-27",
    locale: "sw-KE",
  });
  assert.equal(queries[0].locale, "en");
  assert.equal(queries[0].query, "Nightlife events Nairobi July 27 2026");
  assert.throws(
    () => buildLocalizedDiscoveryQueries({ cityName: " ", date: "2026-07-27" }),
    /discovery_city_required/,
  );
});

test("a weekly window covers every nightlife date and every touched month", () => {
  const queries = buildLocalizedDiscoveryQueries({
    cityName: "Genève",
    countryName: "Suisse",
    date: "2026-07-27",
    locale: "fr-CH",
    nightlifeDays: 7,
  });

  assert.equal(queries.filter((query) => query.family === "nightlife").length, 7);
  assert.deepEqual(
    queries.filter((query) => query.family === "nightlife").map((query) => query.dateKey),
    [
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ],
  );
  assert.equal(queries.length, 13);
  assert.deepEqual(
    [
      ...new Set(
        queries.filter((query) => query.dateScope === "month").map((query) => query.monthKey),
      ),
    ],
    ["2026-07", "2026-08"],
  );
  assert.throws(
    () =>
      buildLocalizedDiscoveryQueries({
        cityName: "Genève",
        date: "2026-07-27",
        nightlifeDays: 32,
      }),
    /discovery_nightlife_days_invalid/,
  );
});

test("multilingual discovery keeps the weekly primary locale and supplements local languages", () => {
  const queries = buildMultilingualDiscoveryQueries({
    cityName: "Genève",
    countryName: "Switzerland",
    date: "2026-07-20",
    locales: ["de-CH", "fr-CH", "it-CH"],
    primaryNightlifeDays: 7,
    maxQueries: 16,
  });
  assert.equal(queries.length, 16);
  assert.equal(queries.filter((query) => query.locale === "de-CH").length, 10);
  assert.deepEqual(
    queries.filter((query) => query.locale === "fr-CH").map((query) => query.family),
    ["nightlife", "culture", "family", "outdoor"],
  );
  assert.deepEqual(
    queries.filter((query) => query.locale === "it-CH").map((query) => query.family),
    ["nightlife", "culture"],
  );
});

test("URL canonicalization keeps only safe HTTP(S) URLs and removes trackers", () => {
  assert.equal(
    canonicalizeHttpUrl(
      " HTTPS://WWW.Example.COM:443/events/../event?a=2&utm_source=list&a=1#details ",
    ),
    "https://www.example.com/event?a=2&a=1",
  );
  assert.equal(
    canonicalizeHttpUrl("../event?gclid=secret&lang=fr", "https://agenda.example.com/city/list"),
    "https://agenda.example.com/event?lang=fr",
  );
  assert.equal(canonicalizeHttpUrl("ftp://example.com/events"), null);
  assert.equal(canonicalizeHttpUrl("https://user:password@example.com/events"), null);
  assert.equal(canonicalizeHttpUrl("http://localhost/events"), null);
  assert.equal(canonicalizeHttpUrl("http://127.0.0.1/events"), null);
  assert.equal(canonicalizeHttpUrl("http://169.254.169.254/latest/meta-data"), null);
  assert.equal(canonicalizeHttpUrl("http://[::1]/events"), null);
  assert.equal(searchResultDomain("https://www2.Events.Example.com/show"), "events.example.com");
});

test("SearXNG normalization returns at most ten distinct domains in result order", () => {
  const payload = {
    results: [
      {
        url: "https://www.events-one.com/show?utm_campaign=july",
        title: "<b>Festival</b> &amp; more",
        content: "A&nbsp;summer   event",
        engines: ["bing", "bing", "brave"],
        score: 9.5,
        thumbnail: "https://cdn.images.com/poster.jpg",
      },
      { url: "https://events-one.com/duplicate", title: "Same site" },
      { url: "http://127.0.0.1/private", title: "Unsafe" },
      ...Array.from({ length: 12 }, (_, index) => ({
        url: `https://site-${index}.com/event`,
        title: `Result ${index}`,
        engine: "duckduckgo",
      })),
    ],
  };

  const results = normalizeSearxngResults(payload);
  assert.equal(results.length, 10);
  assert.deepEqual(
    results.map((result) => result.rank),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.equal(results[0].sourceRank, 1);
  assert.equal(results[1].sourceRank, 4);
  assert.equal(results[0].domain, "events-one.com");
  assert.equal(results[0].url, "https://www.events-one.com/show");
  assert.equal(results[0].title, "Festival & more");
  assert.equal(results[0].snippet, "A summer event");
  assert.deepEqual(results[0].engines, ["bing", "brave"]);
  assert.equal(results[0].thumbnailUrl, "https://cdn.images.com/poster.jpg");
  assert.equal(new Set(results.map((result) => result.domain)).size, 10);
  assert.deepEqual(normalizeSearxngResults({}), []);
});
