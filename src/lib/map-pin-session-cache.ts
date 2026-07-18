import type { CompactMapPin } from "./map-pins.ts";
import {
  isCoordinateInMapViewport,
  normalizeMapViewportBounds,
  type MapViewportBounds,
} from "./map-viewport.ts";

const MAX_FILTER_BUCKETS = 8;
const MAX_ENTRIES_PER_FILTER = 12;
const DEFAULT_VIEWPORT_PADDING_RATIO = 0.35;

type CachedPinRegion = {
  bounds: MapViewportBounds;
  pins: CompactMapPin[];
  lastUsed: number;
};

type InFlightPinRegion = {
  cacheKey: string;
  bounds: MapViewportBounds;
  promise: Promise<CompactMapPin[]>;
};

const sessionPinCache = new Map<string, CachedPinRegion[]>();
const inFlightPinRegions: InFlightPinRegion[] = [];
let cacheClock = 0;

function longitudeSpan(bounds: MapViewportBounds): number {
  return bounds.west <= bounds.east
    ? bounds.east - bounds.west
    : 180 - bounds.west + (bounds.east + 180);
}

function longitudeSegments(bounds: MapViewportBounds): Array<readonly [number, number]> {
  if (bounds.west <= bounds.east) return [[bounds.west, bounds.east]];
  return [
    [bounds.west, 180],
    [-180, bounds.east],
  ];
}

export function mapViewportContainsBounds(
  container: MapViewportBounds,
  target: MapViewportBounds,
): boolean {
  if (container.south > target.south || container.north < target.north) return false;
  const containerSegments = longitudeSegments(container);
  return longitudeSegments(target).every(([targetWest, targetEast]) =>
    containerSegments.some(
      ([containerWest, containerEast]) =>
        containerWest <= targetWest && containerEast >= targetEast,
    ),
  );
}

export function expandMapViewportBounds(
  bounds: MapViewportBounds,
  paddingRatio = DEFAULT_VIEWPORT_PADDING_RATIO,
): MapViewportBounds {
  const normalized = normalizeMapViewportBounds(
    bounds.east < bounds.west ? { ...bounds, east: bounds.east + 360 } : bounds,
  );
  if (!normalized) throw new RangeError("Invalid map viewport bounds");

  const span = longitudeSpan(normalized);
  if (span >= 360) return normalized;
  const adaptivePadding =
    span >= 90
      ? Math.min(paddingRatio, 0.05)
      : span >= 30
        ? Math.min(paddingRatio, 0.15)
        : paddingRatio;
  const longitudePadding = span * adaptivePadding;
  const latitudePadding = (normalized.north - normalized.south) * adaptivePadding;
  const expanded = normalizeMapViewportBounds({
    west: normalized.west - longitudePadding,
    south: normalized.south - latitudePadding,
    east: normalized.west + span + longitudePadding,
    north: normalized.north + latitudePadding,
  });
  if (!expanded) throw new RangeError("Unable to expand map viewport bounds");
  return expanded;
}

export function filterMapPinsToViewport(
  pins: CompactMapPin[],
  bounds: MapViewportBounds,
): CompactMapPin[] {
  return pins.filter((pin) => isCoordinateInMapViewport(bounds, pin[1], pin[2]));
}

function touchFilterBucket(cacheKey: string, regions: CachedPinRegion[]) {
  sessionPinCache.delete(cacheKey);
  sessionPinCache.set(cacheKey, regions);
  while (sessionPinCache.size > MAX_FILTER_BUCKETS) {
    const oldestKey = sessionPinCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    sessionPinCache.delete(oldestKey);
  }
}

export function readSessionMapPins(
  cacheKey: string,
  viewport: MapViewportBounds,
): CompactMapPin[] | null {
  const regions = sessionPinCache.get(cacheKey);
  if (!regions) return null;
  const region = regions
    .filter((candidate) => mapViewportContainsBounds(candidate.bounds, viewport))
    .sort((left, right) => left.pins.length - right.pins.length)[0];
  if (!region) return null;
  region.lastUsed = ++cacheClock;
  touchFilterBucket(cacheKey, regions);
  return filterMapPinsToViewport(region.pins, viewport);
}

export function writeSessionMapPins(
  cacheKey: string,
  bounds: MapViewportBounds,
  pins: CompactMapPin[],
) {
  const current = sessionPinCache.get(cacheKey) ?? [];
  const regions = current.filter((region) => !mapViewportContainsBounds(bounds, region.bounds));
  regions.push({ bounds, pins, lastUsed: ++cacheClock });
  regions.sort((left, right) => right.lastUsed - left.lastUsed);
  if (regions.length > MAX_ENTRIES_PER_FILTER) regions.length = MAX_ENTRIES_PER_FILTER;
  touchFilterBucket(cacheKey, regions);
}

export function clearSessionMapPinCache(cacheKey?: string) {
  if (cacheKey) sessionPinCache.delete(cacheKey);
  else sessionPinCache.clear();
}

export async function loadSessionMapPins({
  cacheKey,
  viewport,
  fetchPins,
}: {
  cacheKey: string;
  viewport: MapViewportBounds;
  fetchPins: (bounds: MapViewportBounds) => Promise<CompactMapPin[]>;
}): Promise<CompactMapPin[]> {
  const cached = readSessionMapPins(cacheKey, viewport);
  if (cached) return cached;

  const sharedRequest = inFlightPinRegions.find(
    (request) =>
      request.cacheKey === cacheKey && mapViewportContainsBounds(request.bounds, viewport),
  );
  if (sharedRequest) {
    return filterMapPinsToViewport(await sharedRequest.promise, viewport);
  }

  const requestBounds = expandMapViewportBounds(viewport);
  const cachedExpanded = readSessionMapPins(cacheKey, requestBounds);
  if (cachedExpanded) return filterMapPinsToViewport(cachedExpanded, viewport);

  const request: InFlightPinRegion = {
    cacheKey,
    bounds: requestBounds,
    promise: Promise.resolve([]),
  };
  request.promise = fetchPins(requestBounds)
    .then((pins) => {
      writeSessionMapPins(cacheKey, requestBounds, pins);
      return pins;
    })
    .finally(() => {
      const index = inFlightPinRegions.indexOf(request);
      if (index >= 0) inFlightPinRegions.splice(index, 1);
    });
  inFlightPinRegions.push(request);
  return filterMapPinsToViewport(await request.promise, viewport);
}

export function getSessionMapPinCacheStats() {
  return {
    filterBuckets: sessionPinCache.size,
    regions: [...sessionPinCache.values()].reduce((count, entries) => count + entries.length, 0),
    pins: [...sessionPinCache.values()].reduce(
      (count, entries) =>
        count + entries.reduce((entryCount, entry) => entryCount + entry.pins.length, 0),
      0,
    ),
    inFlight: inFlightPinRegions.length,
  };
}
