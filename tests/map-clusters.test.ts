import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import {
  beginMapSourceUpdate,
  bumpMapSourceRevision,
  completeMapSourceUpdate,
  EVENT_CLUSTER_MAX_ZOOM,
  EVENT_CLUSTER_TERMINAL_ZOOM,
  EVENT_CLUSTER_RADIUS,
  CLUSTER_SELECTION_PAGE_SIZE,
  clusterLeafPageRequest,
  clusterExpansionTargetZoom,
  eventClusterCircleRadiusExpression,
  eventClusterCircleRadius,
  eventClusterCountExpression,
  eventClusterTextSizeExpression,
  eventClusterTextSize,
  isMapSourceRevisionCurrent,
  isMapSourceRevisionReady,
  shouldClusterMapPointsInClient,
  shouldOpenClusterSelection,
  shouldRequestTerminalClusterReload,
  serverClusterExpansionTargetZoom,
} from "../src/lib/map-cluster-config.ts";
import {
  eventCategoryTextColor,
  eventCategoryVisual,
  normalizeEventCategorySlug,
} from "../src/lib/event-category-style.ts";
import {
  mapEventPinOccurrenceId,
  resolveMapEventPinPreview,
  resolveMapEventPinSelection,
  selectHighestPriorityMapHit,
  selectNearestMapHit,
} from "../src/lib/map-interactions.ts";
import { parseCompactMapPins } from "../src/lib/map-pins.ts";
import {
  chunkOccurrenceIds,
  mapPreviewExcerpt,
  mapPreviewVenueNames,
  parseMapOccurrencePreviewRows,
} from "../src/lib/map-occurrence-previews.ts";
import type { DiscoveredEvent } from "../src/lib/queries.ts";
import { loadAllPages } from "../src/lib/load-all-pages.ts";

// The production build resolves the @ alias through Vite. Register the one
// runtime alias used by map-clusters so this dependency-free Node test follows
// the same module graph.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/event-category-style") {
      return {
        shortCircuit: true,
        url: new URL("../src/lib/event-category-style.ts", import.meta.url).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const {
  buildCompactMapPointCollection,
  buildLoadedMapPointCollection,
  buildMapPointCollection,
  coincidentMapPointOccurrenceIds,
  compactMapPinsSignature,
  MAX_SPIDERFY_GROUP_SIZE,
  spreadCoincidentMapPoints,
} = await import("../src/lib/map-clusters.ts");

test("the batch signature separates every field that changes what is drawn", () => {
  const base = parseCompactMapPins([
    ["event", "occurrence-a", 6.1452, 46.2004, "concert", 0, 0, "a", 1, 0],
    ["event", "occurrence-b", 6.1462, 46.2014, "culture", 1, 0, "b", 1, 1],
    ["cluster", "location:6.15:46.2", 6.15, 46.2, "family", 0, 1, "", 7, 2],
  ]);
  const signature = compactMapPinsSignature(base);

  // Recomputing over an equal but distinct array must agree, otherwise every
  // cache read would re-upload the source.
  assert.equal(compactMapPinsSignature(base.map((pin) => [...pin]) as typeof base), signature);

  // Every tuple slot must be observable.
  for (let index = 0; index < base.length; index += 1) {
    for (let field = 0; field < 10; field += 1) {
      const mutated = base.map((pin) => [...pin]) as typeof base;
      const current = mutated[index][field];
      mutated[index][field] =
        typeof current === "number"
          ? ((field === 2 || field === 3 ? current + 0.00001 : current + 1) as never)
          : (`${current}x` as never);
      assert.notEqual(
        compactMapPinsSignature(mutated),
        signature,
        `field ${field} of pin ${index} was not observable`,
      );
    }
  }

  const reordered = [base[1], base[0], base[2]] as typeof base;
  assert.notEqual(compactMapPinsSignature(reordered), signature);
  assert.notEqual(compactMapPinsSignature(base.slice(0, 2) as typeof base), signature);
  assert.equal(compactMapPinsSignature([]), compactMapPinsSignature([]));
});

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

test("builds a lightweight event-only GeoJSON feature with its category visual", () => {
  const points = buildMapPointCollection({
    events: [event()],
    showEvents: true,
  });

  test("event cluster style expressions tolerate missing aggregate counts", () => {
    const expectedCount = [
      "coalesce",
      ["to-number", ["get", "event_count"]],
      ["to-number", ["get", "point_count"]],
      1,
    ];

    assert.deepEqual(eventClusterCountExpression(), expectedCount);
    assert.deepEqual(eventClusterCircleRadiusExpression().slice(0, 2), ["step", expectedCount]);
    assert.deepEqual(eventClusterTextSizeExpression().slice(0, 2), ["step", expectedCount]);
  });

  assert.equal(points.type, "FeatureCollection");
  assert.equal(points.features.length, 1);
  assert.deepEqual(points.features[0], {
    type: "Feature",
    id: "event:occurrence-1",
    geometry: { type: "Point", coordinates: [6.1452, 46.2004] },
    properties: {
      kind: "event",
      entity_id: "occurrence-1",
      label: "Open Air Geneva",
      category_slug: "concerts",
      category_color: "#f43f5e",
      category_icon_image: "event-category-concerts",
      is_free: 0,
      approximate: 0,
      slug: "open-air-geneva",
      event_count: 1,
      free_count: 0,
    },
  });
});

test("builds every compact world pin returned by the uncapped RPC", () => {
  const pins = parseCompactMapPins([
    ["occurrence-1", 6.1452, 46.2004, "concert", 0, 0, "open-air-geneva"],
    ["occurrence-2", -74.006, 40.7128, "nightlife", 1, 1, "night-in-new-york"],
  ]);
  const points = buildCompactMapPointCollection({ pins, showEvents: true });

  assert.equal(points.features.length, 2);
  assert.deepEqual(points.features[1], {
    type: "Feature",
    id: "event:occurrence-2",
    geometry: { type: "Point", coordinates: [-74.006, 40.7128] },
    properties: {
      kind: "event",
      entity_id: "occurrence-2",
      label: "",
      category_slug: "soirees",
      category_color: "#d946ef",
      category_icon_image: "event-category-soirees",
      is_free: 1,
      approximate: 1,
      slug: "night-in-new-york",
      event_count: 1,
      free_count: 1,
    },
  });
});

test("spiderfies coincident terminal pins without moving stored lower-zoom points", () => {
  const points = buildCompactMapPointCollection({
    pins: parseCompactMapPins([
      ["event", "occurrence-b", 6.1452, 46.2004, "concert", 0, 0, "b", 1, 0],
      ["event", "occurrence-a", 6.1452, 46.2004, "culture", 1, 0, "a", 1, 1],
      ["event", "occurrence-c", 6.1452, 46.2004, "family", 0, 0, "c", 1, 0],
    ]),
    showEvents: true,
  });

  assert.equal(
    spreadCoincidentMapPoints(
      points,
      EVENT_CLUSTER_TERMINAL_ZOOM - 1,
      EVENT_CLUSTER_TERMINAL_ZOOM,
    ),
    points,
  );
  const spread = spreadCoincidentMapPoints(
    points,
    EVENT_CLUSTER_TERMINAL_ZOOM,
    EVENT_CLUSTER_TERMINAL_ZOOM,
  );
  assert.equal(spread.features.length, 3);
  assert.deepEqual(spread.features[1]?.geometry.coordinates, [6.1452, 46.2004]);
  assert.equal(
    new Set(spread.features.map((feature) => feature.geometry.coordinates.join(":"))).size,
    3,
  );
  assert.deepEqual(points.features[0]?.geometry.coordinates, [6.1452, 46.2004]);
});

test("turns large coincident venues into a bounded terminal selection", () => {
  const occurrenceIds = Array.from(
    { length: MAX_SPIDERFY_GROUP_SIZE + 1 },
    (_, index) => `occurrence-${index}`,
  );
  const points = buildCompactMapPointCollection({
    pins: parseCompactMapPins(
      occurrenceIds.map((occurrenceId) => [
        "event",
        occurrenceId,
        6.1452,
        46.2004,
        "culture",
        0,
        0,
        occurrenceId,
        1,
        0,
      ]),
    ),
    showEvents: true,
  });

  const layout = spreadCoincidentMapPoints(
    points,
    EVENT_CLUSTER_TERMINAL_ZOOM,
    EVENT_CLUSTER_TERMINAL_ZOOM,
  );
  assert.equal(layout.features.length, 1);
  assert.equal(layout.features[0]?.properties.kind, "coincident_cluster");
  assert.equal(layout.features[0]?.properties.event_count, occurrenceIds.length);
  assert.deepEqual(
    coincidentMapPointOccurrenceIds(layout.features[0]?.properties),
    [...occurrenceIds].sort(),
  );
  assert.deepEqual(layout.features[0]?.geometry.coordinates, [6.1452, 46.2004]);
  assert.deepEqual(coincidentMapPointOccurrenceIds({ kind: "coincident_cluster" }), []);
});

test("invalidates asynchronous cluster work whenever source data changes", () => {
  const revisions = new WeakMap<object, number>();
  const map = {};
  const first = bumpMapSourceRevision(revisions, map);
  assert.equal(isMapSourceRevisionCurrent(revisions, map, first), true);
  const second = bumpMapSourceRevision(revisions, map);
  assert.equal(isMapSourceRevisionCurrent(revisions, map, first), false);
  assert.equal(isMapSourceRevisionCurrent(revisions, map, second), true);
});

test("keeps cluster interaction disabled until the matching source update settles", () => {
  const revisions = new WeakMap<object, number>();
  const pendingRevisions = new WeakMap<object, number>();
  const map = {};

  const first = beginMapSourceUpdate(revisions, pendingRevisions, map);
  assert.equal(isMapSourceRevisionReady(revisions, pendingRevisions, map, first), false);

  const second = beginMapSourceUpdate(revisions, pendingRevisions, map);
  assert.equal(completeMapSourceUpdate(revisions, pendingRevisions, map, first), false);
  assert.equal(isMapSourceRevisionReady(revisions, pendingRevisions, map, second), false);
  assert.equal(completeMapSourceUpdate(revisions, pendingRevisions, map, second), true);
  assert.equal(isMapSourceRevisionReady(revisions, pendingRevisions, map, second), true);
});

test("preserves server aggregate weights for low-zoom clusters", () => {
  const pins = parseCompactMapPins({
    version: 2,
    clustered: true,
    truncated: false,
    total_count: 42,
    free_count: 12,
    pins: [["cluster", "z3:12:28", 6.14, 46.2, "concert", 1, 0, "", 42, 12]],
  });
  const points = buildCompactMapPointCollection({ pins, showEvents: true });

  assert.equal(points.features.length, 1);
  assert.equal(points.features[0]?.id, "cluster:z3:12:28");
  assert.equal(points.features[0]?.properties.kind, "server_cluster");
  assert.equal(points.features[0]?.properties.event_count, 42);
  assert.equal(points.features[0]?.properties.free_count, 12);
});

test("never clusters low-zoom server aggregates a second time in the browser", () => {
  assert.equal(shouldClusterMapPointsInClient(true), false);
  assert.equal(shouldClusterMapPointsInClient(false), true);
});

test("terminal server clusters cannot trigger overlapping reload loops", () => {
  assert.equal(shouldRequestTerminalClusterReload(false, false), true);
  assert.equal(shouldRequestTerminalClusterReload(true, false), false);
  assert.equal(shouldRequestTerminalClusterReload(false, true), false);
  assert.equal(shouldRequestTerminalClusterReload(true, true), false);
});

test("never presents the first 1,000 detailed rows as a complete worldwide map", () => {
  const firstDetailedPage = Array.from({ length: 1_000 }, (_, index) =>
    event({
      occurrence_id: `occurrence-${index}`,
      longitude: 6.1452 + index / 100_000,
    }),
  );

  const points = buildLoadedMapPointCollection({
    unfilteredWorld: true,
    compactPins: null,
    worldPinsReady: false,
    events: firstDetailedPage,
    showEvents: true,
  });

  assert.equal(points.features.length, 0);
});

test("uses every compact pin once the complete worldwide response is ready", () => {
  const pins = parseCompactMapPins([
    ["occurrence-1", 6.1452, 46.2004, "concert", 0, 0, "open-air-geneva"],
    ["occurrence-2", -74.006, 40.7128, "nightlife", 1, 1, "night-in-new-york"],
  ]);

  const points = buildLoadedMapPointCollection({
    unfilteredWorld: true,
    compactPins: pins,
    worldPinsReady: true,
    events: [event()],
    showEvents: true,
  });

  assert.equal(points.features.length, 2);
});

test("preserves the exhaustive detailed fallback when the compact RPC is unavailable", () => {
  const fallbackEvents = [
    event({ occurrence_id: "fallback-1" }),
    event({ occurrence_id: "fallback-2", longitude: 7.4474, latitude: 46.948 }),
  ];

  const points = buildLoadedMapPointCollection({
    unfilteredWorld: true,
    compactPins: null,
    worldPinsReady: true,
    events: fallbackEvents,
    showEvents: true,
  });

  assert.equal(points.features.length, fallbackEvents.length);
});

test("selects compact event pins for an in-place dialog without relying on their slug", () => {
  assert.equal(
    mapEventPinOccurrenceId({
      kind: "event",
      entity_id: "occurrence-world-2501",
      slug: "must-not-trigger-navigation",
    }),
    "occurrence-world-2501",
  );
  assert.equal(mapEventPinOccurrenceId({ kind: "venue", entity_id: "venue-1" }), null);
  assert.equal(mapEventPinOccurrenceId({ kind: "event", entity_id: "  " }), null);
});

test("resolves a compact pin preview for the modal by occurrence id", async () => {
  const requests: string[] = [];
  const preview = { title: "World event" };

  const result = await resolveMapEventPinPreview(
    "occurrence-world-2501",
    async (occurrenceId) => {
      requests.push(occurrenceId);
      return preview;
    },
    () => true,
  );

  assert.deepEqual(requests, ["occurrence-world-2501"]);
  assert.deepEqual(result, { status: "ready", preview });
});

test("ignores a pin preview that resolves after the modal was closed", async () => {
  let selectionIsCurrent = true;
  let resolvePending!: (preview: { title: string } | null) => void;
  const pending = new Promise<{ title: string } | null>((resolve) => {
    resolvePending = resolve;
  });
  const resultPromise = resolveMapEventPinPreview(
    "occurrence-1",
    async () => pending,
    () => selectionIsCurrent,
  );

  selectionIsCurrent = false;
  resolvePending({ title: "Late event" });

  assert.deepEqual(await resultPromise, { status: "stale" });
});

test("keeps compact pin loading failures inside the modal", async () => {
  const missing = await resolveMapEventPinPreview(
    "occurrence-missing",
    async () => null,
    () => true,
  );
  const failed = await resolveMapEventPinPreview(
    "occurrence-offline",
    async () => {
      throw new Error("offline");
    },
    () => true,
  );

  assert.deepEqual(missing, { status: "missing" });
  assert.deepEqual(failed, { status: "error" });
});

test("resolves the full pin selection used by the in-place modal", async () => {
  const detail = { occurrence_id: "occurrence-world-2501", offers: ["all"] };
  const result = await resolveMapEventPinSelection(
    "occurrence-world-2501",
    async () => detail,
    () => true,
  );

  assert.deepEqual(result, { status: "ready", selection: detail });
});

test("does not apply a full event response after the map modal is closed", async () => {
  let current = true;
  let complete!: (value: { title: string }) => void;
  const pending = new Promise<{ title: string }>((resolve) => {
    complete = resolve;
  });
  const result = resolveMapEventPinSelection(
    "occurrence-1",
    () => pending,
    () => current,
  );

  current = false;
  complete({ title: "Too late" });

  assert.deepEqual(await result, { status: "stale" });
});

test("drops malformed compact pin rows without imposing a result limit", () => {
  const validRows = Array.from({ length: 2_505 }, (_, index) => [
    `occurrence-${index}`,
    6.1,
    46.2,
    "concerts",
    0,
    0,
    `event-${index}`,
  ]);
  const pins = parseCompactMapPins([...validRows, ["broken"]]);

  assert.equal(pins.length, 2_505);
});

test("loads every map page without imposing a global result limit", async () => {
  const source = Array.from({ length: 2_505 }, (_, index) => ({ id: `event-${index}` }));
  const requests: Array<{ limit: number; offset: number }> = [];
  const firstPageSnapshots: number[] = [];

  const loaded = await loadAllPages({
    pageSize: 1_000,
    getKey: (item) => item.id,
    fetchPage: async (request) => {
      requests.push(request);
      return source.slice(request.offset, request.offset + request.limit);
    },
    onFirstPage: (items) => firstPageSnapshots.push(items.length),
  });

  assert.equal(loaded.length, source.length);
  assert.deepEqual(firstPageSnapshots, [1_000]);
  assert.deepEqual(requests, [
    { limit: 1_000, offset: 0 },
    { limit: 1_000, offset: 1_000 },
    { limit: 1_000, offset: 2_000 },
  ]);
});

test("stops stale map pagination before requesting another page", async () => {
  let current = true;
  let requests = 0;

  const loaded = await loadAllPages({
    pageSize: 2,
    getKey: (item) => item.id,
    shouldContinue: () => current,
    fetchPage: async () => {
      requests += 1;
      current = false;
      return [{ id: "event-1" }, { id: "event-2" }];
    },
  });

  assert.equal(requests, 1);
  assert.deepEqual(loaded, []);
});

test("respects the event layer toggle and drops invalid world coordinates", () => {
  const hidden = buildMapPointCollection({
    events: [event()],
    showEvents: false,
  });
  assert.equal(hidden.features.length, 0);

  const points = buildMapPointCollection({
    events: [
      event({ occurrence_id: "free", is_free: true, location_precision: "city" }),
      event({ occurrence_id: "invalid-longitude", longitude: 181 }),
      event({ occurrence_id: "invalid-latitude", latitude: Number.NaN }),
    ],
    showEvents: true,
  });

  assert.equal(points.features.length, 1);
  assert.equal(points.features[0]?.id, "event:free");
  assert.equal(points.features[0]?.properties.is_free, 1);
  assert.equal(points.features[0]?.properties.approximate, 1);
});

test("keeps Spain event points in Spain and rejects proven coordinate inversions", () => {
  const points = buildMapPointCollection({
    events: [
      event({
        occurrence_id: "barcelona",
        latitude: 41.3874,
        longitude: 2.1686,
      }),
      event({
        occurrence_id: "barcelona-swapped",
        latitude: 2.1686,
        longitude: 41.3874,
      }),
      event({
        occurrence_id: "madrid",
        latitude: 40.4168,
        longitude: -3.7038,
      }),
      event({
        occurrence_id: "tenerife",
        latitude: 28.2916,
        longitude: -16.6291,
      }),
    ],
    showEvents: true,
    countryCode: "ES",
  });

  assert.deepEqual(
    points.features.map((feature) => feature.id),
    ["event:barcelona", "event:madrid", "event:tenerife"],
  );
  assert.deepEqual(points.features[0]?.geometry.coordinates, [2.1686, 41.3874]);

  const unscopedWorldPoint = buildMapPointCollection({
    events: [
      event({
        occurrence_id: "world-point",
        latitude: 2.1686,
        longitude: 41.3874,
      }),
    ],
    showEvents: true,
  });
  assert.equal(unscopedWorldPoint.features.length, 1);
});

test("normalizes category aliases and applies the explicit fallback visual", () => {
  assert.equal(normalizeEventCategorySlug(" Concert "), "concerts");
  assert.equal(normalizeEventCategorySlug("NIGHTLIFE"), "soirees");
  assert.equal(normalizeEventCategorySlug("family"), "famille");
  assert.equal(normalizeEventCategorySlug("outdoor"), "sports-outdoor");
  assert.equal(normalizeEventCategorySlug("unknown-category"), "other");
  assert.equal(normalizeEventCategorySlug(null), "other");

  assert.deepEqual(eventCategoryVisual("concert"), {
    slug: "concerts",
    color: "#f43f5e",
    colorEnd: "#be123c",
    imageId: "event-category-concerts",
  });
  assert.deepEqual(eventCategoryVisual("unknown-category"), {
    slug: "other",
    color: "#f472b6",
    colorEnd: "#be185d",
    imageId: "event-category-other",
  });
});

test("assigns distinct colors and icons to recognizable event categories", () => {
  const points = buildMapPointCollection({
    events: [
      event({ occurrence_id: "night", category_slug: "soiree" }),
      event({ occurrence_id: "festival", category_slug: "festival", longitude: 6.15 }),
      event({ occurrence_id: "family", category_slug: "family", longitude: 6.16 }),
      event({ occurrence_id: "outdoor", category_slug: "outdoor", longitude: 6.17 }),
    ],
    showEvents: true,
  });

  assert.deepEqual(
    points.features.map((feature) => feature.properties.category_slug),
    ["soirees", "festivals", "famille", "sports-outdoor"],
  );
  assert.equal(
    new Set(points.features.map((feature) => feature.properties.category_color)).size,
    points.features.length,
  );
  assert.equal(
    new Set(points.features.map((feature) => feature.properties.category_icon_image)).size,
    points.features.length,
  );
});

test("uses a readable foreground for every category color", () => {
  for (const slug of [
    "concerts",
    "festivals",
    "expositions",
    "soirees",
    "theatre",
    "famille",
    "sports-outdoor",
    "heritage",
    "gastronomy",
    "activities",
    "conferences",
    "cinema",
    "leisure",
    "other",
  ]) {
    assert.match(eventCategoryTextColor(slug), /^#(?:ffffff|111827)$/);
  }
  assert.equal(eventCategoryTextColor("festivals"), "#111827");
  assert.equal(eventCategoryTextColor("soirees"), "#111827");
});

test("selects one nearby event hit by distance, then by marker priority", () => {
  const nearest = selectNearestMapHit(
    [
      { kind: "cluster", x: 18, y: 10, value: "far-cluster" },
      { kind: "event", x: 11, y: 10, value: "near-event" },
    ],
    { x: 10, y: 10 },
    24,
  );
  assert.equal(nearest?.value, "near-event");

  const sharedPosition = selectNearestMapHit(
    [
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

test("uses large, readable event clusters that grow monotonically", () => {
  const counts = [1, 10, 50, 250, 1_000, 5_000, 20_000];
  const radii = counts.map(eventClusterCircleRadius);
  const textSizes = counts.map(eventClusterTextSize);

  assert.ok(EVENT_CLUSTER_RADIUS >= 72);
  assert.equal(EVENT_CLUSTER_MAX_ZOOM, 14);
  assert.ok(radii[0] >= 24);
  assert.ok(textSizes[0] >= 14);
  assert.deepEqual(
    radii,
    [...radii].sort((left, right) => left - right),
  );
  assert.deepEqual(
    textSizes,
    [...textSizes].sort((left, right) => left - right),
  );
});

test("cluster expansion always zooms in and remains within the supported source zoom", () => {
  assert.equal(clusterExpansionTargetZoom(4, 6), 6.35);
  assert.equal(clusterExpansionTargetZoom(12, 12), 13.25);
  assert.equal(clusterExpansionTargetZoom(20, 21), EVENT_CLUSTER_TERMINAL_ZOOM);
});

test("performs the final expansion to individual pins before opening the cluster list", () => {
  assert.equal(
    shouldOpenClusterSelection(EVENT_CLUSTER_TERMINAL_ZOOM - 1, EVENT_CLUSTER_TERMINAL_ZOOM),
    false,
  );
  assert.equal(shouldOpenClusterSelection(EVENT_CLUSTER_TERMINAL_ZOOM, 21), true);
  assert.equal(shouldOpenClusterSelection(14, EVENT_CLUSTER_TERMINAL_ZOOM + 1), true);
  assert.equal(shouldOpenClusterSelection(12, 14), false);
});

test("server aggregates reach the individual-pin threshold in bounded steps", () => {
  assert.equal(serverClusterExpansionTargetZoom(2, 14), 5);
  assert.equal(serverClusterExpansionTargetZoom(12.5, 14), 14);
  assert.equal(serverClusterExpansionTargetZoom(14, 14), 14);
});

test("requests terminal cluster leaves in small on-demand pages", () => {
  assert.equal(CLUSTER_SELECTION_PAGE_SIZE, 24);
  assert.deepEqual(clusterLeafPageRequest(640, 0), { limit: 24, offset: 0 });
  assert.deepEqual(clusterLeafPageRequest(640, 24), { limit: 24, offset: 24 });
  assert.deepEqual(clusterLeafPageRequest(640, 636), { limit: 4, offset: 636 });
  assert.equal(clusterLeafPageRequest(640, 640), null);
  assert.equal(clusterLeafPageRequest(0, 0), null);
});

test("validates, deduplicates and batches occurrence preview ids", () => {
  const first = "79e46cb5-36e3-4e59-9706-e41f1e3688b9";
  const second = "0f199399-565d-4915-a478-d3f272f4dd67";
  assert.deepEqual(chunkOccurrenceIds([first, first, second], 1), [[first], [second]]);
  assert.throws(() => chunkOccurrenceIds(["not-a-uuid"]), /Invalid occurrence id/);
});

test("parses safe hover previews and derives venue labels and excerpts", () => {
  const previews = parseMapOccurrencePreviewRows([
    {
      id: "79e46cb5-36e3-4e59-9706-e41f1e3688b9",
      starts_at: "2026-11-20T00:00:00+00:00",
      timezone: "Europe/Paris",
      event: {
        id: "4fda1366-38ca-4aa2-a24d-c7c5a97a597e",
        slug: "haroun",
        title: "Haroun",
        short_description: null,
        description: "<p>Une soirée   exceptionnelle au Forum.</p>",
        cover_image_url: "https://example.com/haroun.jpg",
        venue: { name: "  Le Forum  ", city: { name: "Le Mans" } },
        city: { name: "Le Mans" },
      },
    },
  ]);

  assert.equal(previews.length, 1);
  assert.deepEqual(mapPreviewVenueNames(previews), ["Le Forum"]);
  assert.equal(
    mapPreviewExcerpt(previews[0]?.short_description ?? previews[0]?.description, 24),
    "Une soirée exceptionnel…",
  );
});

test("accepts a rendered cluster at the edge of its painted circle", () => {
  const selected = selectHighestPriorityMapHit([
    { kind: "event", x: 100, y: 100, value: "event" },
    { kind: "cluster", x: 48, y: 100, value: "large-cluster" },
  ]);

  assert.equal(selected?.value, "large-cluster");
});
