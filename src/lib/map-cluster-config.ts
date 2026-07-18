import type { ExpressionSpecification } from "maplibre-gl";

export const EVENT_CLUSTER_RADIUS = 82;
export const EVENT_CLUSTER_MAX_ZOOM = 20;
export const EVENT_SOURCE_MAX_ZOOM = 22;
export const EVENT_CLUSTER_EXPANSION_MAX_ZOOM = 20.75;
export const EVENT_CLUSTER_LEAF_BATCH_SIZE = 250;

const CLUSTER_RADIUS_STOPS = [
  [1, 27],
  [10, 32],
  [50, 38],
  [250, 46],
  [1_000, 55],
  [5_000, 66],
] as const;

const CLUSTER_TEXT_STOPS = [
  [1, 14],
  [50, 15],
  [250, 16],
  [1_000, 18],
  [5_000, 19],
] as const;

function steppedValue(count: number, stops: ReadonlyArray<readonly [number, number]>): number {
  const normalizedCount = Number.isFinite(count) ? Math.max(0, count) : 0;
  let value = stops[0]?.[1] ?? 0;

  for (const [threshold, nextValue] of stops) {
    if (normalizedCount < threshold) break;
    value = nextValue;
  }

  return value;
}

export function eventClusterCircleRadius(count: number): number {
  return steppedValue(count, CLUSTER_RADIUS_STOPS);
}

export function eventClusterTextSize(count: number): number {
  return steppedValue(count, CLUSTER_TEXT_STOPS);
}

export function eventClusterCircleRadiusExpression(): ExpressionSpecification {
  return [
    "step",
    ["get", "point_count"],
    CLUSTER_RADIUS_STOPS[0][1],
    ...CLUSTER_RADIUS_STOPS.slice(1).flat(),
  ] as ExpressionSpecification;
}

export function eventClusterTextSizeExpression(): ExpressionSpecification {
  return [
    "step",
    ["get", "point_count"],
    CLUSTER_TEXT_STOPS[0][1],
    ...CLUSTER_TEXT_STOPS.slice(1).flat(),
  ] as ExpressionSpecification;
}

export function clusterExpansionTargetZoom(currentZoom: number, expansionZoom: number): number {
  const safeCurrentZoom = Number.isFinite(currentZoom) ? currentZoom : 0;
  const safeExpansionZoom = Number.isFinite(expansionZoom) ? expansionZoom : safeCurrentZoom + 1;

  return Math.min(
    EVENT_CLUSTER_EXPANSION_MAX_ZOOM,
    Math.max(safeExpansionZoom + 0.35, safeCurrentZoom + 1.25),
  );
}

export function shouldOpenClusterSelection(currentZoom: number, expansionZoom: number): boolean {
  return (
    (Number.isFinite(currentZoom) && currentZoom >= EVENT_CLUSTER_MAX_ZOOM) ||
    !Number.isFinite(expansionZoom) ||
    expansionZoom > EVENT_CLUSTER_MAX_ZOOM
  );
}

export function clusterLeafPageRequests(
  pointCount: number,
  batchSize = EVENT_CLUSTER_LEAF_BATCH_SIZE,
): Array<{ limit: number; offset: number }> {
  const total = Number.isFinite(pointCount) ? Math.max(0, Math.floor(pointCount)) : 0;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("batchSize must be a positive integer");
  }

  const requests: Array<{ limit: number; offset: number }> = [];
  for (let offset = 0; offset < total; offset += batchSize) {
    requests.push({ limit: Math.min(batchSize, total - offset), offset });
  }
  return requests;
}

export async function loadAllClusterLeaves<T>(
  pointCount: number,
  loadPage: (limit: number, offset: number) => Promise<T[]>,
): Promise<T[]> {
  const leaves: T[] = [];
  for (const request of clusterLeafPageRequests(pointCount)) {
    leaves.push(...(await loadPage(request.limit, request.offset)));
  }
  return leaves;
}
