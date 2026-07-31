import assert from "node:assert/strict";
import test from "node:test";

import { MUSIC_GENRES } from "../src/lib/event-filters.ts";
import {
  getSearchCategory,
  pruneSearchSelections,
  resolveSearchTaxonomyFilters,
  SEARCH_CATEGORIES,
} from "../src/lib/event-search-taxonomy.ts";

test("family and culture expose the requested non-nightlife subcategories", () => {
  const family = getSearchCategory("family");
  const culture = getSearchCategory("culture");

  assert.ok(family);
  assert.ok(culture);
  assert.deepEqual(
    new Set(family.subcategories.map((subcategory) => subcategory.slug)),
    new Set([
      "family-cinema",
      "amusement-parks",
      "parks-leisure",
      "family-events",
      "water-play",
      "zoo-aquarium",
      "kids-shows",
      "family-workshops",
      "educational-activities",
      "circus",
      "farms-animals",
      "playgrounds",
      "family-science",
    ]),
  );
  for (const slug of ["museums", "historical-sites", "art", "exhibitions", "theatre-shows"]) {
    assert.ok(culture.subcategories.some((subcategory) => subcategory.slug === slug));
  }
});

test("every music style lives under Music and no generic category exposes genre chips", () => {
  const music = getSearchCategory("music");
  assert.ok(music);
  assert.deepEqual(
    new Set(music.subcategories.map((subcategory) => subcategory.slug)),
    new Set(MUSIC_GENRES.map(([slug]) => slug)),
  );
  assert.ok(music.subcategories.every((subcategory) => subcategory.kind === "genre"));
  assert.ok(
    SEARCH_CATEGORIES.filter((category) => category.slug !== "music").every((category) =>
      category.subcategories.every((subcategory) => subcategory.kind === "facet"),
    ),
  );
});

test("broad and detailed taxonomy selections resolve to legacy indexed filters", () => {
  assert.deepEqual(resolveSearchTaxonomyFilters(["family"], { genres: [], subcategories: [] }), {
    eventCategorySlugs: ["famille", "cinema", "leisure", "activities", "sports-outdoor"],
    filterValues: ["family"],
  });

  assert.deepEqual(resolveSearchTaxonomyFilters(["culture"], { genres: [], subcategories: [] }), {
    eventCategorySlugs: ["expositions", "theatre", "heritage", "cinema"],
    filterValues: null,
  });

  const rock = resolveSearchTaxonomyFilters(["music"], {
    genres: ["rock"],
    subcategories: [],
  });
  assert.deepEqual(rock.eventCategorySlugs, ["concerts", "festivals", "soirees"]);
  assert.deepEqual(rock.filterValues, ["rock"]);

  const electronic = resolveSearchTaxonomyFilters(["music"], {
    genres: ["electro"],
    subcategories: [],
  });
  assert.deepEqual(electronic.filterValues, ["electro", "electronic"]);

  const waterPlay = resolveSearchTaxonomyFilters(["family"], {
    genres: [],
    subcategories: ["water-play"],
  });
  assert.deepEqual(waterPlay.eventCategorySlugs, [
    "famille",
    "cinema",
    "leisure",
    "activities",
    "sports-outdoor",
  ]);
  assert.deepEqual(waterPlay.filterValues, ["water-play"]);
});

test("deselecting a category removes only its now-hidden details", () => {
  assert.deepEqual(
    pruneSearchSelections(["culture"], {
      genres: ["rock"],
      subcategories: ["museums", "water-play"],
    }),
    { genres: [], subcategories: ["museums"] },
  );
});
