import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("place scraper enriches tourism content, media, websites and booking links", async () => {
  const [scraper, enrichment, migration, applicator] = await Promise.all([
    read("supabase/functions/global-place-discovery/index.ts"),
    read("supabase/functions/global-place-discovery/enrichment.ts"),
    read("supabase/migrations/20260801134500_enrich_places_content_and_home_search.sql"),
    read("scripts/apply-place-scraper-enrichment.mjs"),
  ]);
  assert.match(scraper, /enrichPlacesFromPublicSources/);
  assert.match(scraper, /booking_url/);
  assert.match(enrichment, /wikivoyage\.org/);
  assert.match(enrichment, /wikipedia\.org/);
  assert.match(enrichment, /wikidata\.org/);
  assert.match(migration, /image_urls text\[\]/);
  assert.match(migration, /booking_url text/);
  assert.match(migration, /discover_places_for_home_v1/);
  assert.match(
    applicator,
    /source\.includes\("const places = await enrichPlacesFromPublicSources\("\)/,
  );
});

test("home and map place experiences expose rich detail", async () => {
  const [home, mapScript, dialog, discovery] = await Promise.all([
    read("src/routes/index.tsx"),
    read("scripts/apply-poi-map-layer.mjs"),
    read("src/components/place-detail-dialog.tsx"),
    read("src/lib/place-discovery.ts"),
  ]);
  assert.match(home, /HomePlaceSearchResults/);
  assert.match(mapScript, /PlaceSearchResults/);
  assert.match(dialog, /fetchPlaceDetail/);
  assert.match(dialog, /booking_url/);
  assert.match(dialog, /image_urls/);
  assert.match(discovery, /get_place_detail_v1/);
});

test("place cluster interaction is locked to one expansion per click", async () => {
  const layer = await read("src/hooks/usePlaceMapLayer.ts");
  assert.match(layer, /clusterClickLockedRef/);
  assert.match(layer, /getClusterExpansionZoom/);
  assert.match(layer, /originalEvent\.stopPropagation/);
  assert.match(layer, /map\.once\("moveend"/);
});
