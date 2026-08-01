import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const layer = await readFile(new URL("../src/hooks/usePlaceMapLayer.ts", import.meta.url), "utf8");
const card = await readFile(new URL("../src/components/place-card.tsx", import.meta.url), "utf8");
const detail = await readFile(
  new URL("../src/components/place-detail-dialog.tsx", import.meta.url),
  "utf8",
);
const patch = await readFile(
  new URL("../scripts/apply-poi-map-layer.mjs", import.meta.url),
  "utf8",
);

test("places use server or client clustering, never both at once", () => {
  assert.match(layer, /const clientClustered = !serverClustered/);
  assert.match(layer, /previousClientClustered !== clientClustered/);
  assert.match(layer, /MAP_PLACE_CLIENT_CLUSTER_ID/);
  assert.match(layer, /MAP_PLACE_SERVER_CLUSTER_ID/);
  assert.match(layer, /getClusterExpansionZoom/);
});

test("one deterministic click handles clusters, pins and overlapping labels", () => {
  assert.match(layer, /queryRenderedFeatures/);
  assert.match(layer, /firstFeatureForLayer/);
  assert.match(layer, /map\.on\("click", handleMapClick\)/);
  assert.match(layer, /PLACE_SERVER_CLUSTER_MAX_ZOOM \+ 0\.25/);
});

test("place cards and details include useful descriptions", () => {
  assert.match(card, /placeDisplayDescription/);
  assert.match(detail, /placeDisplayDescription/);
  assert.match(detail, /Adresse et localisation/);
  assert.match(detail, /Horaires et accès/);
});

test("map build injects place result lists on mobile and desktop", () => {
  assert.match(patch, /mobile place result list/);
  assert.match(patch, /desktop place result list/);
  assert.match(patch, /PlaceSearchResults/);
  assert.match(patch, /PlaceDetailDialog/);
});
