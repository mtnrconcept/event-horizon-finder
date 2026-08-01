import { readFile, writeFile } from "node:fs/promises";

const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const testPath = new URL("../tests/poi-map-layer.test.ts", import.meta.url);
let source = await readFile(mapPath, "utf8");

function replaceOnce(before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Expected ${label} fragment was not found`);
  }
  source = source.replace(before, after);
}

function insertBefore(anchor, addition, label) {
  replaceOnce(anchor, `${addition}\n${anchor}`, label);
}

function replaceAllExact(before, after, expectedCount, label) {
  const occurrences = source.split(before).length - 1;
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
    '  const totalEventCount = mapStats.total_count;',
    '  const loadedPointCount = compactPins.length;',
    '  const statsLoading = loading;',
  ].join("\n"),
  [
    '  const totalEventCount = mapStats.total_count;',
    '  const totalPlaceCount = placeDiscovery.pinBatch.totalCount;',
    '  const totalResultCount =',
    '    (eventModeEnabled ? totalEventCount : 0) + (placeModeEnabled ? totalPlaceCount : 0);',
    '  const loadedPointCount = compactPins.length;',
    '  const loadedPlacePointCount = placeDiscovery.pinBatch.pins.length;',
    '  const statsLoading = loading;',
    '  const resultLoading =',
    '    (eventModeEnabled && loading) || (placeModeEnabled && placeDiscovery.pinsLoading);',
  ].join("\n"),
  "combined map result counts",
);

replaceOnce(
  [
    '  useEffect(() => {',
    '    if (!mapDiscoveryParams) return;',
    '    const cachedPins = readSessionMapPins(mapPinCacheKey, mapDiscoveryParams.bounds);',
  ].join("\n"),
  [
    '  useEffect(() => {',
    '    if (!mapDiscoveryParams) {',
    '      setCompactPinBatch(EMPTY_MAP_PIN_BATCH);',
    '      pinLoadingRef.current = false;',
    '      terminalClusterReloadPendingRef.current = false;',
    '      retryMapPinsWhenOnlineRef.current = false;',
    '      setLoading(false);',
    '      setError(null);',
    '      return;',
    '    }',
    '    const cachedPins = readSessionMapPins(mapPinCacheKey, mapDiscoveryParams.bounds);',
  ].join("\n"),
  "event pin cleanup in places-only mode",
);

replaceOnce(
  [
    '  useEffect(() => {',
    '    if (!mapDiscoveryParams || !listRequested) return;',
    '',
    '    let current = true;',
  ].join("\n"),
  [
    '  useEffect(() => {',
    '    if (!mapDiscoveryParams || !listRequested) {',
    '      if (!mapDiscoveryParams) {',
    '        setMobileListHasMore(false);',
    '        setMobileListError(null);',
    '      }',
    '      return;',
    '    }',
    '',
    '    let current = true;',
  ].join("\n"),
  "event list cleanup in places-only mode",
);

replaceOnce(
  [
    '      if (!occurrenceId) return;',
    '',
    '      if (selectedOccurrenceIdRef.current !== occurrenceId) {',
  ].join("\n"),
  [
    '      if (!occurrenceId) return;',
    '      closePlaceSelection();',
    '',
    '      if (selectedOccurrenceIdRef.current !== occurrenceId) {',
  ].join("\n"),
  "close place detail when an event opens",
);

replaceOnce(
  '    [abortEventDetail, closeClusterSelection, eventsByOccurrenceId, resolveEventDetail, tr],',
  '    [abortEventDetail, closeClusterSelection, closePlaceSelection, eventsByOccurrenceId, resolveEventDetail, tr],',
  "event selection dependencies",
);

insertBefore(
  '  const toggleCategory = (slug: string) => {',
  [
    '  const togglePlacesLayer = () => {',
    '    setAdvancedFilters((current) => ({',
    '      ...current,',
    '      contentMode: current.contentMode === "events" ? "all" : "events",',
    '    }));',
    '  };',
    '',
  ].join("\n"),
  "place layer toggle",
);

replaceOnce(
  '        resultCount={statsLoading ? null : totalEventCount}',
  '        resultCount={resultLoading ? null : totalResultCount}',
  "mobile combined result count",
);

replaceOnce(
  [
    '              {loading',
    '                ? tr("Actualisation des événements de la zone visible…")',
    '                : tr("{count} événements dans la zone visible", {',
    '                    count: formatNumber(totalEventCount),',
    '                  })}',
  ].join("\n"),
  [
    '              {resultLoading',
    '                ? tr("Actualisation des résultats de la zone visible…")',
    '                : tr("{count} résultats dans la zone visible", {',
    '                    count: formatNumber(totalResultCount),',
    '                  })}',
  ].join("\n"),
  "mobile combined search status",
);

const mobileEventDialog = [
  '            <SelectedMapEventDialog',
  '              open={eventSelectionOpen}',
  '              event={selectedMapEvent}',
  '              detail={selectedMapEventDetail}',
  '              loading={eventSelectionLoading}',
  '              error={eventSelectionError}',
  '              onOpenChange={(nextOpen) => {',
  '                if (!nextOpen) closeEventSelection();',
  '              }}',
  '              onRetry={() => eventSelectionRetryRef.current?.()}',
  '            />',
].join("\n");
replaceOnce(
  mobileEventDialog,
  [
    mobileEventDialog,
    '            <PlaceDetailDialog',
    '              open={placeSelectionOpen}',
    '              place={selectedPlace}',
    '              onOpenChange={(nextOpen) => {',
    '                if (!nextOpen) closePlaceSelection();',
    '              }}',
    '            />',
  ].join("\n"),
  "mobile place detail dialog",
);

replaceOnce(
  '                    count: statsLoading ? "…" : formatNumber(totalEventCount),',
  '                    count: resultLoading ? "…" : formatNumber(totalResultCount),',
  "mobile list combined title count",
);
replaceOnce(
  '                  shown: COUNT_FORMATTER.format(mobileListEvents.length),',
  '                  shown: COUNT_FORMATTER.format(mobileListEvents.length + placeDiscovery.places.length),',
  "mobile list combined shown count",
);
replaceOnce(
  '                  loaded: COUNT_FORMATTER.format(loadedPointCount),',
  '                  loaded: COUNT_FORMATTER.format(loadedPointCount + loadedPlacePointCount),',
  "mobile list combined loaded count",
);

const placeListSection = [
  '            {placeModeEnabled && (',
  '              <div className={eventModeEnabled ? "mb-5 border-b pb-5" : ""}>',
  '                <PlaceSearchResults',
  '                  places={placeDiscovery.places}',
  '                  totalCount={placeDiscovery.listTotalCount || totalPlaceCount}',
  '                  loading={placeDiscovery.listLoading}',
  '                  loadingMore={placeDiscovery.listLoadingMore}',
  '                  error={placeDiscovery.listError}',
  '                  hasMore={placeDiscovery.listHasMore}',
  '                  onRetry={placeDiscovery.retryList}',
  '                  onLoadMore={placeDiscovery.loadMore}',
  '                  onSelect={openPlaceSelection}',
  '                  compact',
  '                  showEmpty={advancedFilters.contentMode === "places"}',
  '                />',
  '              </div>',
  '            )}',
  '',
].join("\n");
insertBefore(
  '            {(loading || mobileListLoading) && events.length === 0 ? (',
  placeListSection,
  "mobile place result list",
);
replaceOnce(
  '            {(loading || mobileListLoading) && events.length === 0 ? (',
  '            {eventModeEnabled && ((loading || mobileListLoading) && events.length === 0 ? (',
  "wrap mobile event list by content mode",
);
replaceOnce(
  [
    '            )}',
    '',
    '            {hasMoreMobileEvents && (',
  ].join("\n"),
  [
    '            ))}',
    '',
    '            {eventModeEnabled && hasMoreMobileEvents && (',
  ].join("\n"),
  "wrap mobile event pagination by content mode",
);

replaceAllExact(
  [
    '                <LayerToggle',
    '                  active={showEvents}',
    '                  icon={CalendarDays}',
    '                  label={`Événements (${statsLoading ? "…" : COUNT_FORMATTER.format(totalEventCount)})`}',
    '                  onClick={() => setShowEvents((value) => !value)}',
    '                />',
  ].join("\n"),
  [
    '                <LayerToggle',
    '                  active={showEvents}',
    '                  icon={CalendarDays}',
    '                  label={`Événements (${statsLoading ? "…" : COUNT_FORMATTER.format(totalEventCount)})`}',
    '                  onClick={() => setShowEvents((value) => !value)}',
    '                />',
    '                <LayerToggle',
    '                  active={placeModeEnabled}',
    '                  icon={MapPin}',
    '                  label={`Lieux (${placeDiscovery.pinsLoading ? "…" : COUNT_FORMATTER.format(totalPlaceCount)})`}',
    '                  onClick={togglePlacesLayer}',
    '                />',
  ].join("\n"),
  1,
  "mobile layer toggle",
);

replaceOnce(
  [
    '          <LayerToggle',
    '            active={showEvents}',
    '            icon={CalendarDays}',
    '            label={`Événements (${statsLoading ? "…" : COUNT_FORMATTER.format(totalEventCount)})`}',
    '            onClick={() => setShowEvents((value) => !value)}',
    '          />',
  ].join("\n"),
  [
    '          <LayerToggle',
    '            active={showEvents}',
    '            icon={CalendarDays}',
    '            label={`Événements (${statsLoading ? "…" : COUNT_FORMATTER.format(totalEventCount)})`}',
    '            onClick={() => setShowEvents((value) => !value)}',
    '          />',
    '          <LayerToggle',
    '            active={placeModeEnabled}',
    '            icon={MapPin}',
    '            label={`Lieux (${placeDiscovery.pinsLoading ? "…" : COUNT_FORMATTER.format(totalPlaceCount)})`}',
    '            onClick={togglePlacesLayer}',
    '          />',
  ].join("\n"),
  "desktop place layer toggle",
);

source = source.replaceAll(
  "Les événements s’actualisent automatiquement après chaque déplacement ou zoom.",
  "Les événements et les lieux s’actualisent automatiquement après chaque déplacement ou zoom.",
);
source = source.replaceAll(
  "Déplace ou zoome la carte pour actualiser les événements.",
  "Déplace ou zoome la carte pour actualiser les résultats.",
);

replaceOnce(
  [
    '              {loading',
    '                ? tr("Actualisation des événements de la zone visible…")',
    '                : `${COUNT_FORMATTER.format(totalEventCount)} événements visibles · ${COUNT_FORMATTER.format(mapStats.free_count)} gratuits`}',
  ].join("\n"),
  [
    '              {resultLoading',
    '                ? tr("Actualisation des résultats de la zone visible…")',
    '                : `${COUNT_FORMATTER.format(totalResultCount)} résultats visibles`}',
  ].join("\n"),
  "desktop combined result status",
);
replaceOnce(
  [
    '                {tr("{count} points d’événements chargés sur la carte", {',
    '                  count: COUNT_FORMATTER.format(loadedPointCount),',
    '                })}',
  ].join("\n"),
  [
    '                {tr("{count} points chargés sur la carte", {',
    '                  count: COUNT_FORMATTER.format(loadedPointCount + loadedPlacePointCount),',
    '                })}',
  ].join("\n"),
  "desktop combined loaded point count",
);

const desktopPlaceResults = [
  '        {placeModeEnabled && (',
  '          <div className="mt-4 border-t pt-4">',
  '            <PlaceSearchResults',
  '              places={placeDiscovery.places}',
  '              totalCount={placeDiscovery.listTotalCount || totalPlaceCount}',
  '              loading={placeDiscovery.listLoading}',
  '              loadingMore={placeDiscovery.listLoadingMore}',
  '              error={placeDiscovery.listError}',
  '              hasMore={placeDiscovery.listHasMore}',
  '              onRetry={placeDiscovery.retryList}',
  '              onLoadMore={placeDiscovery.loadMore}',
  '              onSelect={openPlaceSelection}',
  '              compact',
  '              showEmpty={advancedFilters.contentMode === "places"}',
  '            />',
  '          </div>',
  '        )}',
  '',
].join("\n");
insertBefore(
  '        {mapUnavailable && events.length > 0 && (',
  desktopPlaceResults,
  "desktop place result list",
);

const desktopEventDialog = [
  '      <SelectedMapEventDialog',
  '        open={eventSelectionOpen}',
  '        event={selectedMapEvent}',
  '        detail={selectedMapEventDetail}',
  '        loading={eventSelectionLoading}',
  '        error={eventSelectionError}',
  '        onOpenChange={(nextOpen) => {',
  '          if (!nextOpen) closeEventSelection();',
  '        }}',
  '        onRetry={() => eventSelectionRetryRef.current?.()}',
  '      />',
].join("\n");
replaceOnce(
  desktopEventDialog,
  [
    desktopEventDialog,
    '      <PlaceDetailDialog',
    '        open={placeSelectionOpen}',
    '        place={selectedPlace}',
    '        onOpenChange={(nextOpen) => {',
    '          if (!nextOpen) closePlaceSelection();',
    '        }}',
    '      />',
  ].join("\n"),
  "desktop place detail dialog",
);

await writeFile(mapPath, source);

const testSource = [
  'import assert from "node:assert/strict";',
  'import { readFile } from "node:fs/promises";',
  'import test from "node:test";',
  'const map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");',
  'test("places use the shared cluster layer", () => { assert.match(map, /usePlaceMapLayer/); assert.match(map, /pinBatch: placeDiscovery\\.pinBatch/); });',
  'test("places open detailed cards", () => { assert.match(map, /PlaceDetailDialog/); assert.match(map, /selectedPlace/); });',
  'test("places appear in mobile and desktop result lists", () => { assert.ok((map.match(/<PlaceSearchResults/g) ?? []).length >= 2); });',
  'test("places-only mode avoids event map requests", () => { assert.match(map, /eventModeEnabled && viewportBounds/); });',
  "",
].join("\n");
await writeFile(testPath, testSource);
