export type MapViewportBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

const MAP_VIEWPORT_COORDINATE_PRECISION = 6;

function roundCoordinate(value: number): number {
  return Number(value.toFixed(MAP_VIEWPORT_COORDINATE_PRECISION));
}

function wrapLongitude(value: number): number {
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && value > 0 ? 180 : wrapped;
}

/**
 * Normalizes MapLibre bounds before they are sent to PostGIS. MapLibre can
 * return longitudes outside [-180, 180] after world wrapping; preserving an
 * east < west pair intentionally represents a viewport crossing the dateline.
 */
export function normalizeMapViewportBounds(bounds: MapViewportBounds): MapViewportBounds | null {
  const { west, south, east, north } = bounds;
  if (![west, south, east, north].every(Number.isFinite)) return null;

  const normalizedSouth = Math.max(-90, Math.min(90, south));
  const normalizedNorth = Math.max(-90, Math.min(90, north));
  if (normalizedNorth <= normalizedSouth) return null;

  const longitudeSpan = east - west;
  if (longitudeSpan >= 360) {
    return {
      west: -180,
      south: roundCoordinate(normalizedSouth),
      east: 180,
      north: roundCoordinate(normalizedNorth),
    };
  }
  if (longitudeSpan <= 0) return null;

  return {
    west: roundCoordinate(wrapLongitude(west)),
    south: roundCoordinate(normalizedSouth),
    east: roundCoordinate(wrapLongitude(east)),
    north: roundCoordinate(normalizedNorth),
  };
}

export function mapViewportBoundsKey(bounds: MapViewportBounds): string {
  return [bounds.west, bounds.south, bounds.east, bounds.north]
    .map((value) => value.toFixed(MAP_VIEWPORT_COORDINATE_PRECISION))
    .join(":");
}

export function isCoordinateInMapViewport(
  bounds: MapViewportBounds,
  longitude: number,
  latitude: number,
): boolean {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  if (latitude < bounds.south || latitude > bounds.north) return false;
  if (bounds.west <= bounds.east) {
    return longitude >= bounds.west && longitude <= bounds.east;
  }
  return longitude >= bounds.west || longitude <= bounds.east;
}
