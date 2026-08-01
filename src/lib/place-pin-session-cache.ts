import type { PlaceMapPinBatch } from "@/lib/place-discovery";
import { normalizeMapViewportBounds, type MapViewportBounds } from "@/lib/map-viewport";

const PLACE_PIN_CACHE_TTL_MS = 90_000;
const PLACE_PIN_CACHE_LIMIT = 20;
const PLACE_PIN_BUFFER_RATIO = 0.22;

interface PlacePinCacheEntry {
  key: string;
  bounds: MapViewportBounds;
  batch: PlaceMapPinBatch;
  createdAt: number;
}

const entries: PlacePinCacheEntry[] = [];

function normalizeLongitude(value: number): number {
  let longitude = value;
  while (longitude > 180) longitude -= 360;
  while (longitude < -180) longitude += 360;
  return longitude;
}

function longitudeSpan(bounds: MapViewportBounds): number {
  return bounds.west <= bounds.east
    ? bounds.east - bounds.west
    : 360 - bounds.west + bounds.east;
}

function longitudeSegments(bounds: MapViewportBounds): Array<[number, number]> {
  return bounds.west <= bounds.east
    ? [[bounds.west, bounds.east]]
    : [
        [bounds.west, 180],
        [-180, bounds.east],
      ];
}

function boundsContain(container: MapViewportBounds, target: MapViewportBounds): boolean {
  if (container.south > target.south || container.north < target.north) return false;
  const containerSegments = longitudeSegments(container);
  return longitudeSegments(target).every(([targetWest, targetEast]) =>
    containerSegments.some(
      ([containerWest, containerEast]) =>
        containerWest <= targetWest && containerEast >= targetEast,
    ),
  );
}

function boundsMatch(left: MapViewportBounds, right: MapViewportBounds): boolean {
  return boundsContain(left, right) && boundsContain(right, left);
}

function longitudeInBounds(longitude: number, bounds: MapViewportBounds): boolean {
  return bounds.west <= bounds.east
    ? longitude >= bounds.west && longitude <= bounds.east
    : longitude >= bounds.west || longitude <= bounds.east;
}

function pinInsideBounds(
  pin: { latitude: number; longitude: number },
  bounds: MapViewportBounds,
): boolean {
  return (
    pin.latitude >= bounds.south &&
    pin.latitude <= bounds.north &&
    longitudeInBounds(pin.longitude, bounds)
  );
}

export function placePinCacheMode(zoom: number): string {
  const normalizedZoom = Number.isFinite(zoom) ? Math.max(0, Math.min(22, zoom)) : 0;
  return normalizedZoom < 12 ? `server:${Math.floor(normalizedZoom)}` : "individual";
}

export function expandPlacePinBounds(
  viewport: MapViewportBounds,
  ratio = PLACE_PIN_BUFFER_RATIO,
): MapViewportBounds {
  const normalized = normalizeMapViewportBounds(viewport);
  if (!normalized) throw new RangeError("Invalid place viewport bounds");
  const latitudePadding = Math.max(0.01, (normalized.north - normalized.south) * ratio);
  const longitudePadding = Math.max(0.01, longitudeSpan(normalized) * ratio);
  return {
    west: normalizeLongitude(normalized.west - longitudePadding),
    south: Math.max(-90, normalized.south - latitudePadding),
    east: normalizeLongitude(normalized.east + longitudePadding),
    north: Math.min(90, normalized.north + latitudePadding),
  };
}

function cacheKey(filterKey: string, zoom: number): string {
  return `${filterKey}|${placePinCacheMode(zoom)}`;
}

function projectBatch(
  batch: PlaceMapPinBatch,
  viewport: MapViewportBounds,
): PlaceMapPinBatch {
  if (batch.clustered) return batch;
  const pins = batch.pins.filter((pin) => pinInsideBounds(pin, viewport));
  return {
    pins,
    totalCount: pins.reduce((sum, pin) => sum + pin.count, 0),
    clustered: false,
    truncated: batch.truncated,
  };
}

function prune(now = Date.now()) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (now - entries[index].createdAt > PLACE_PIN_CACHE_TTL_MS) entries.splice(index, 1);
  }
  while (entries.length > PLACE_PIN_CACHE_LIMIT) entries.shift();
}

export function readSessionPlacePins(
  filterKey: string,
  viewport: MapViewportBounds,
  zoom: number,
): PlaceMapPinBatch | null {
  const normalized = normalizeMapViewportBounds(viewport);
  if (!normalized) return null;
  prune();
  const key = cacheKey(filterKey, zoom);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.key !== key || !boundsContain(entry.bounds, normalized)) continue;
    // Server clusters encode a grid calculated from the requested viewport.
    // Reusing them for a smaller or shifted viewport would produce incorrect
    // counts and cluster centres.
    if (entry.batch.clustered && !boundsMatch(entry.bounds, normalized)) continue;
    entries.splice(index, 1);
    entries.push(entry);
    return projectBatch(entry.batch, normalized);
  }
  return null;
}

export async function loadSessionPlacePins({
  filterKey,
  viewport,
  zoom,
  signal,
  fetchPins,
}: {
  filterKey: string;
  viewport: MapViewportBounds;
  zoom: number;
  signal?: AbortSignal;
  fetchPins: (bounds: MapViewportBounds, signal?: AbortSignal) => Promise<PlaceMapPinBatch>;
}): Promise<PlaceMapPinBatch> {
  const normalized = normalizeMapViewportBounds(viewport);
  if (!normalized) throw new RangeError("Invalid place viewport bounds");
  const cached = readSessionPlacePins(filterKey, normalized, zoom);
  if (cached) return cached;

  // Server aggregates are tied to the exact visible grid. Individual pins can
  // safely be fetched with a modest spatial buffer and reused while panning.
  const requestBounds = zoom < 12 ? normalized : expandPlacePinBounds(normalized);
  const batch = await fetchPins(requestBounds, signal);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  entries.push({
    key: cacheKey(filterKey, zoom),
    bounds: requestBounds,
    batch,
    createdAt: Date.now(),
  });
  prune();
  return projectBatch(batch, normalized);
}

export function clearSessionPlacePinCache(filterKey?: string) {
  if (!filterKey) {
    entries.length = 0;
    return;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].key.startsWith(`${filterKey}|`)) entries.splice(index, 1);
  }
}
