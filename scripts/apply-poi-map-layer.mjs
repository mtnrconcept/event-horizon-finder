import { readFile, writeFile } from "node:fs/promises";

const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const testPath = new URL("../tests/poi-map-layer.test.ts", import.meta.url);
let source = await readFile(mapPath, "utf8");

const committedPoiRuntimeMarkers = [
  "usePlaceMapDiscovery",
  "usePlaceMapLayer",
  "PlaceSearchResults",
  "PlaceDetailDialog",
];

if (committedPoiRuntimeMarkers.every((marker) => source.includes(marker))) {
  console.log("POI runtime is already committed; skipping obsolete text applicator.");
  process.exit(0);
}

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  if (!source.includes(before)) {
    throw new Error(`Expected ${label} fragment was not found`);
  }
  source = source.replace(before, after);
}

function insertBefore(anchor, addition, label) {
  replaceOnce(anchor, `${addition}\n${anchor}`, label);
}

function compactFragment(value) {
  return value.replace(/\s+/g, "");
}

function countCompactOccurrences(haystack, needle) {
  const compactNeedle = compactFragment(needle);
  if (!compactNeedle) return 0;
  return compactFragment(haystack).split(compactNeedle).length - 1;
}

function replaceAllExact(before, after, expectedCount, label) {
  const afterOccurrences = countCompactOccurrences(source, after);
  if (afterOccurrences === expectedCount) return;
  const occurrences = source.split(before).length - 1;
  if (occurrences === 0 && [
      "combined visible total",
      "combined loaded count",
      "place result list integration",
    ].includes(label)) {
    console.log(`Skipping obsolete ${label} rewrite; the rendered counter shape has already changed.`);
    return;
  }
  if (occurrences !== expectedCount) {
    throw new Error(`Expected ${expectedCount} ${label} fragments, found ${occurrences}`);
  }
  source = source.replaceAll(before, after);
}

const eventCardImport = 'import { EventCard, EventCardSkeleton } from "@/components/event-card";';
replaceOnce(
  eventCardImport,
  [
    eventCardImport,
    'import { PlaceDetailDialog } from "@/components/place-detail-dialog";',
    'import { PlaceSearchResults } from "@/components/place-search-results";',
    'import { usePlaceMapDiscovery } from "@/hooks/usePlaceMapDiscovery";',
    'import { usePlaceMapLayer } from "@/hooks/usePlaceMapLayer";',
    'import type { PlaceOfInterest } from "@/lib/place-discovery";',
  ].join("\n"),
  "place experience imports",
);

const placeSelectionState = [
  '  const [eventSelectionError, setEventSelectionError] = useState<string | null>(null);',
  '  const [selectedPlace, setSelectedPlace] = useState<PlaceOfInterest | null>(null);',
  '  const [placeSelectionOpen, setPlaceSelectionOpen] = useState(false);',
  '  const openPlaceSelection = useCallback((place: PlaceOfInterest) => {',
  '    setEventSelectionOpen(false);',
  '    setClusterSelectionOpen(false);',
  '    setSelectedPlace(place);',
  '    setPlaceSelectionOpen(true);',
  '  }, []);',
  '  const closePlaceSelection = useCallback(() => {',
  '    setPlaceSelectionOpen(false);',
  '    setSelectedPlace(null);',
  '  }, []);',
].join("\n");
replaceOnce(
  '  const [eventSelectionError, setEventSelectionError] = useState<string | null>(null);',
  placeSelectionState,
  "place selection state",
);

const placeDiscoveryBlock = [
  '  const mapReady = mapInstance !== null && readyMap === mapInstance;',
  '  const placeModeEnabled = advancedFilters.contentMode !== "events";',
  '  const eventModeEnabled = advancedFilters.contentMode !== "places";',
  '  const placeDiscovery = usePlaceMapDiscovery({',
  '    enabled: placeModeEnabled,',
  '    listEnabled: placeModeEnabled && (!isMobile || listRequested),',
  '    bounds: viewportBounds,',
  '    zoom: viewportZoom,',
  '    categories: advancedFilters.placeCategories,',
  '    query: deferredQuery,',
  '    accessibleOnly: advancedFilters.accessibleOnly,',
  '    freeOnly: advancedFilters.freePlacesOnly,',
  '    hasHoursOnly: advancedFilters.openNowOnly,',
  '  });',
  '  usePlaceMapLayer({',
  '    map: mapInstance,',
  '    ready: Boolean(mapReady && readyStyle?.map === mapInstance),',
  '    styleRevision: readyStyle?.revision ?? 0,',
  '    enabled: placeModeEnabled,',
  '    pinBatch: placeDiscovery.pinBatch,',
  '    onSelect: openPlaceSelection,',
  '  });',
  '  useEffect(() => {',
  '    setShowEvents(eventModeEnabled);',
  '    if (!placeModeEnabled) closePlaceSelection();',
  '  }, [closePlaceSelection, eventModeEnabled, placeModeEnabled]);',
  '  const { from, to } = useMemo(() => computeRange(range), [range]);',
].join("\n");
replaceOnce(
  [
    '  const mapReady = mapInstance !== null && readyMap === mapInstance;',
    '  const { from, to } = useMemo(() => computeRange(range), [range]);',
  ].join("\n"),
  placeDiscoveryBlock,
  "place map discovery hooks",
);

const oldMapDiscoveryParams = [
  '  const mapDiscoveryParams = useMemo(',
  '    () =>',
  '      viewportBounds',
  '        ? {',
  '            bounds: viewportBounds,',
  '            zoom: viewportZoom,',
  '            categorySlugs: selectedCategorySlugs,',
  '            query: deferredQuery,',
  '            from,',
  '            to,',
  '            ...advancedDiscoveryFilters,',
  '          }',
  '        : null,',
  '    [',
  '      advancedDiscoveryFilters,',
  '      deferredQuery,',
  '      from,',
  '      selectedCategorySlugs,',
  '      to,',
  '      viewportBounds,',
  '      viewportZoom,',
  '    ],',
  '  );',
].join("\n");
const newMapDiscoveryParams = oldMapDiscoveryParams
  .replace('      viewportBounds', '      eventModeEnabled && viewportBounds')
  .replace('      deferredQuery,\n      from,', '      deferredQuery,\n      eventModeEnabled,\n      from,');
replaceOnce(oldMapDiscoveryParams, newMapDiscoveryParams, "event-only map discovery parameters");

replaceOnce(
  [
    '  useEffect(() => {',
    '    if (!mapPinDiscoveryParams) return;',
    '    const cachedPins = readSessionMapPins(mapPinCacheKey, mapPinDiscoveryParams.bounds);',
  ].join("\n"),
  [
    '  useEffect(() => {',
    '    if (!mapPinDiscoveryParams) {',
    '      setCompactPinBatch(EMPTY_MAP_PIN_BATCH);',
    '      pinLoadingRef.current = false;',
    '      terminalClusterReloadPendingRef.current = false;',
    '      retryMapPinsWhenOnlineRef.current = false;',
    '      setLoading(false);',
    '      setError(null);',
    '      return;',
    '    }',
    '    const cachedPins = readSessionMapPins(mapPinCacheKey, mapPinDiscoveryParams.bounds);',
  ].join("\n"),
  "event pin cleanup in places-only mode",
);

replaceOnce(
  [
    '  useEffect(() => {',
    '    if (!mapDiscoveryParams || !listRequested) return;',
  ].join("\n"),
  [
    '  useEffect(() => {',
    '    if (!mapDiscoveryParams || !listRequested) {',
    '      setEvents([]);',
    '      setMobileListLoading(false);',
    '      setMobileListLoadingMore(false);',
    '      setMobileListHasMore(false);',
    '      setMobileListError(null);',
    '      return;',
    '    }',
  ].join("\n"),
  "event list cleanup in places-only mode",
);

replaceAllExact(
  '            totalCount={mapStats.total_count}',
  '            totalCount={mapStats.total_count + placeDiscovery.pinBatch.totalCount}',
  2,
  "combined visible total",
);

replaceAllExact(
  '            loadedCount={compactPins.length}',
  '            loadedCount={compactPins.length + placeDiscovery.pinBatch.pins.length}',
  2,
  "combined loaded count",
);

replaceAllExact(
  '            onLoadList={requestMobileList}',
  [
    '            onLoadList={requestMobileList}',
    '            placeResults={',
    '              <PlaceSearchResults',
    '                places={placeDiscovery.places}',
    '                loading={placeDiscovery.listLoading}',
    '                loadingMore={placeDiscovery.listLoadingMore}',
    '                error={placeDiscovery.error}',
    '                hasMore={placeDiscovery.listHasMore}',
    '                totalCount={placeDiscovery.listTotalCount}',
    '                onRetry={placeDiscovery.retry}',
    '                onLoadMore={placeDiscovery.loadMore}',
    '                onSelect={openPlaceSelection}',
    '              />',
    '            }',
  ].join("\n"),
  2,
  "place result list integration",
);

const selectedEventDialog = [
  '      <SelectedMapEventDialog',
  '        open={eventSelectionOpen}',
].join("\n");
insertBefore(
  selectedEventDialog,
  [
    '      <PlaceDetailDialog',
    '        open={placeSelectionOpen}',
    '        place={selectedPlace}',
    '        onOpenChange={(open) => {',
    '          if (!open) closePlaceSelection();',
    '          else setPlaceSelectionOpen(true);',
    '        }}',
    '      />',
  ].join("\n"),
  "place detail dialog",
);

await writeFile(mapPath, source);

const testSource = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");

test("the map includes place discovery and a dedicated place layer", () => {
  assert.match(map, /usePlaceMapDiscovery/);
  assert.match(map, /usePlaceMapLayer/);
  assert.match(map, /PlaceSearchResults/);
  assert.match(map, /PlaceDetailDialog/);
});

test("event requests are disabled and cleared in places-only mode", () => {
  assert.match(map, /eventModeEnabled && viewportBounds/);
  assert.match(map, /if \(!mapPinDiscoveryParams\) \{/);
  assert.match(map, /setCompactPinBatch\(EMPTY_MAP_PIN_BATCH\)/);
  assert.match(map, /if \(!mapDiscoveryParams \|\| !listRequested\) \{/);
  assert.match(map, /setEvents\(\[\]\)/);
});

test("visible counters include event and place pins", () => {
  assert.match(map, /mapStats\.total_count \+ placeDiscovery\.pinBatch\.totalCount/);
  assert.match(map, /compactPins\.length \+ placeDiscovery\.pinBatch\.pins\.length/);
});
`;
await writeFile(testPath, testSource);
