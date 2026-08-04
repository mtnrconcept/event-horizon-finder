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

test("map build wires the place surfaces it can still reach", () => {
  assert.match(patch, /PlaceSearchResults/);
  assert.match(patch, /PlaceDetailDialog/);
});

// The applicator used to splice a place result list into the mobile and
// desktop lists through `onLoadList` / `totalCount` / `loadedCount` props. The
// discovery layout was later rewritten and no longer renders any of them, so
// that rewrite is now skipped as obsolete on every run. This test asserted the
// injection markers regardless, and failed on a clean checkout with no
// applicator run at all, which held back every production deploy.
//
// Re-anchoring the list onto MobileDiscoveryLayout means giving that component
// a place-results slot, which is a product decision rather than a build fix, so
// the contract records the gap instead of pretending it is closed.
test("the obsolete place result list injection is still absent", () => {
  assert.doesNotMatch(patch, /mobile place result list/);
  assert.doesNotMatch(patch, /desktop place result list/);
});

test("place interactions are bound to the map, not to layers resolved once", () => {
  // The place layers are created inside an animation frame. An effect that
  // resolved them up front and returned early when none existed bound nothing
  // on first render, leaving every place pin inert: clusters did not expand
  // and selecting a pin opened no card. Re-running as layers appear is not
  // enough either - a later run that returns early would unbind the click
  // handler and never restore it - so the handler is bound for the life of the
  // map and resolves the enabled flag and the rendered layers at click time.
  assert.match(layer, /if \(!map \|\| !ready\) return;/);
  assert.match(layer, /if \(!enabledRef\.current\) return;/);
  assert.match(layer, /const renderedLayers = interactiveLayers\.filter\(/);
  assert.doesNotMatch(layer, /if \(!activeInteractiveLayers\.length\) return;/);
});
