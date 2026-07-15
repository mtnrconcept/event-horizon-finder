import assert from "node:assert/strict";
import test from "node:test";

import { buildMapPointCollection } from "../src/lib/map-clusters.ts";
import { selectNearestMapHit } from "../src/lib/map-interactions.ts";
import type { DiscoveredEvent, DiscoveredVenue } from "../src/lib/queries.ts";

function event(overrides: Partial<DiscoveredEvent> = {}): DiscoveredEvent {
  return {
    event_id: "event-1",
    occurrence_id: "occurrence-1",
    venue_id: "venue-1",
    slug: "open-air-geneva",
    title: "Open Air Geneva",
    short_description: null,
    cover_image_url: null,
    category_slug: "concert",
    genres: ["electronic"],
    starts_at: "2026-07-18T20:00:00+02:00",
    ends_at: null,
    timezone: "Europe/Zurich",
    venue_name: "Parc des Bastions",
    city_name: "Genève",
    is_free: false,
    is_verified: true,
    is_demo: false,
    status: "published",
    price_from: 35,
    price_to: 55,
    has_tickets: true,
    capacity: 2_000,
    wheelchair: true,
    location_precision: "exact",
    distance_km: null,
    latitude: 46.2004,
    longitude: 6.1452,
    ...overrides,
  };
}

function venue(overrides: Partial<DiscoveredVenue> = {}): DiscoveredVenue {
  return {
    id: "venue-1",
    slug: "parc-des-bastions",
    name: "Parc des Bastions",
    address: "Promenade des Bastions 1",
    city_name: "Genève",
    capacity: 2_000,
    is_verified: true,
    latitude: 46.2004,
    longitude: 6.1452,
    location_precision: "exact",
    ...overrides,
  };
}

test("builds lightweight event and venue GeoJSON features", () => {
  const points = buildMapPointCollection({
    events: [event()],
    venues: [venue()],
    showEvents: true,
    showVenues: true,
  });

  assert.equal(points.type, "FeatureCollection");
  assert.equal(points.features.length, 2);
  assert.deepEqual(points.features[0], {
    type: "Feature",
    id: "event:occurrence-1",
    geometry: { type: "Point", coordinates: [6.1452, 46.2004] },
    properties: {
      kind: "event",
      entity_id: "occurrence-1",
      label: "Open Air Geneva",
      marker_label: "35",
      is_free: 0,
      approximate: 0,
    },
  });
  assert.equal(points.features[1]?.properties.kind, "venue");
  assert.equal(points.features[1]?.properties.marker_label, "L");
});

test("respects layer toggles and drops invalid world coordinates", () => {
  const points = buildMapPointCollection({
    events: [
      event({ occurrence_id: "free", is_free: true, location_precision: "city" }),
      event({ occurrence_id: "invalid", longitude: 181 }),
    ],
    venues: [venue({ latitude: Number.NaN })],
    showEvents: true,
    showVenues: false,
  });

  assert.equal(points.features.length, 1);
  assert.equal(points.features[0]?.id, "event:free");
  assert.equal(points.features[0]?.properties.marker_label, "0");
  assert.equal(points.features[0]?.properties.is_free, 1);
  assert.equal(points.features[0]?.properties.approximate, 1);
});

test("abbreviates unusually large price labels", () => {
  const points = buildMapPointCollection({
    events: [event({ price_from: 1_250 })],
    venues: [],
    showEvents: true,
    showVenues: true,
  });

  assert.equal(points.features[0]?.properties.marker_label, "1.3k");
});

test("selects one nearby map hit by distance, then by marker priority", () => {
  const nearest = selectNearestMapHit(
    [
      { kind: "cluster", x: 18, y: 10, value: "far-cluster" },
      { kind: "venue", x: 11, y: 10, value: "near-venue" },
    ],
    { x: 10, y: 10 },
    24,
  );
  assert.equal(nearest?.value, "near-venue");

  const sharedPosition = selectNearestMapHit(
    [
      { kind: "venue", x: 10, y: 10, value: "venue" },
      { kind: "event", x: 10, y: 10, value: "event" },
      { kind: "cluster", x: 10, y: 10, value: "cluster" },
    ],
    { x: 10, y: 10 },
    24,
  );
  assert.equal(sharedPosition?.value, "cluster");

  const outsideHitArea = selectNearestMapHit(
    [{ kind: "event", x: 40, y: 40, value: "outside" }],
    { x: 10, y: 10 },
    24,
  );
  assert.equal(outsideHitArea, null);
});
