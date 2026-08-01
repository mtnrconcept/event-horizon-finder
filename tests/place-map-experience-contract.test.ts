import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const layer = await readFile(new URL("../src/hooks/usePlaceMapLayer.ts", import.meta.url), "utf8");
const card = await readFile(new URL("../src/components/place-card.tsx", import.meta.url), "utf8");
const detail = await readFile(
  new URL("../src/components/place-detail-dialog.tsx", import.meta.url),
  "utf8",
);
const patch = await readFile(new URL("../scripts/apply-poi-map-layer.mjs", import.meta.url), "utf8");

test("places cluster on both server and client projections", () => {
  assert.match(layer, /clusterProperties/);
  assert.match(layer, /MAP_PLACE_CLIENT_CLUSTER_ID/);
  assert.match(layer, /MAP_PLACE_SERVER_CLUSTER_ID/);
  assert.match(layer, /getClusterExpansionZoom/);
});

test("place cards and details include descriptions", () => {
  assert.match(card, /place\.description/);
  assert.match(detail, /place\.description/);
  assert.match(detail, /Adresse et localisation/);
  assert.match(detail, /Horaires et accès/);
});

test("map build injects place result lists on mobile and desktop", () => {
  assert.match(patch, /mobile place result list/);
  assert.match(patch, /desktop place result list/);
  assert.match(patch, /PlaceSearchResults/);
  assert.match(patch, /PlaceDetailDialog/);
});
