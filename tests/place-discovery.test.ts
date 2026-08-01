import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPlaceFeatureCollection,
  placeCategoryLabel,
  placeFromFeatureProperties,
  placeIsAccessible,
  placeIsFree,
  type PlaceMapPinBatch,
} from "../src/lib/place-discovery.ts";

const placeBatch: PlaceMapPinBatch = {
  totalCount: 2,
  clustered: false,
  truncated: false,
  pins: [
    {
      kind: "place",
      count: 1,
      id: "a8de2f08-a754-4c02-bfe0-2fcb0243dbb9",
      name: "Jardin botanique",
      slug: "jardin-botanique",
      category: "nature",
      subcategory: "garden",
      description: "Un grand jardin public.",
      address: "Genève",
      website: "https://example.com",
      source_url: "https://www.openstreetmap.org/node/1",
      image_url: null,
      opening_hours: "Mo-Su 08:00-18:00",
      fee: "no",
      wheelchair: "yes",
      latitude: 46.2,
      longitude: 6.14,
      quality_score: 90,
    },
    {
      kind: "cluster",
      count: 18,
      id: "cluster-1",
      name: "Lieux regroupés",
      slug: "cluster-1",
      category: "mixed",
      subcategory: null,
      description: null,
      address: null,
      website: null,
      source_url: null,
      image_url: null,
      opening_hours: null,
      fee: null,
      wheelchair: null,
      latitude: 46.21,
      longitude: 6.15,
      quality_score: 0,
    },
  ],
};

test("place batches become clusterable GeoJSON", () => {
  const collection = buildPlaceFeatureCollection(placeBatch);
  assert.equal(collection.features.length, 2);
  assert.equal(collection.features[0]?.properties.place_count, 1);
  assert.equal(collection.features[1]?.properties.place_count, 18);
  assert.equal(collection.features[1]?.properties.entity_kind, "cluster");
});

test("individual place properties round-trip into a card model", () => {
  const collection = buildPlaceFeatureCollection(placeBatch);
  const place = placeFromFeatureProperties(collection.features[0]?.properties);
  assert.equal(place?.name, "Jardin botanique");
  assert.equal(place?.description, "Un grand jardin public.");
  assert.equal(placeCategoryLabel(place?.category ?? ""), "Nature et jardin");
  assert.equal(place ? placeIsFree(place) : false, true);
  assert.equal(place ? placeIsAccessible(place) : false, true);
});
