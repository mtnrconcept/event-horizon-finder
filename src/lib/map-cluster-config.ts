import type { ExpressionSpecification } from "maplibre-gl";

export const EVENT_CLUSTER_RADIUS = 120;
export const EVENT_CLUSTER_MAX_ZOOM = 14;
export const EVENT_SOURCE_MAX_ZOOM = 22;
export const EVENT_CLUSTER_TERMINAL_ZOOM = EVENT_CLUSTER_MAX_ZOOM + 1;
export const EVENT_CLUSTER_EXPANSION_MAX_ZOOM = EVENT_CLUSTER_TERMINAL_ZOOM;
export const CLUSTER_SELECTION_PAGE_SIZE = 24;

export function bumpMapSourceRevision<T extends object>(
  revisions: WeakMap<T, number>,
  sourceOwner: T,
): number {
  const revision = (revisions.get(sourceOwner) ?? 0) + 1;
  revisions.set(sourceOwner, revision);
  return revision;
}

export function beginMapSourceUpdate<T extends object>(
  revisions: WeakMap<T, number>,
  pendingRevisions: WeakMap<T, number>,
  sourceOwner: T,
): number {
  const revision = bumpMapSourceRevision(revisions, sourceOwner);
  pendingRevisions.set(sourceOwner, revision);
  return revision;
}

export function completeMapSourceUpdate<T extends object>(
  revisions: WeakMap<T, number>,
  pendingRevisions: WeakMap<T, number>,
  sourceOwner: T,
  expectedRevision: number,
): boolean {
  if (
    !isMapSourceRevisionCurrent(revisions, sourceOwner, expectedRevision) ||
    pendingRevisions.get(sourceOwner) !== expectedRevision
  ) {
    return false;
  }
  pendingRevisions.delete(sourceOwner);
  return true;
}

export function isMapSourceRevisionReady<T extends object>(
  revisions: WeakMap<T, number>,
  pendingRevisions: WeakMap<T, number>,
  sourceOwner: T,
  expectedRevision: number,
): boolean {
  return (
    isMapSourceRevisionCurrent(revisions, sourceOwner, expectedRevision) &&
    pendingRevisions.get(sourceOwner) !== expectedRevision
  );
}

export function isMapSourceRevisionCurrent<T extends object>(
  revisions: WeakMap<T, number>,
  sourceOwner: T,
  expectedRevision: number,
): boolean {
  return (revisions.get(sourceOwner) ?? 0) === expectedRevision;
}

export function shouldClusterMapPointsInClient(serverClustered: boolean): boolean {
  return !serverClustered;
}

export function shouldRequestTerminalClusterReload(
  requestLoading: boolean,
  reloadPending: boolean,
): boolean {
  return !requestLoading && !reloadPending;
}

const CLUSTER_RADIUS_STOPS = [
  [1, 24],
  [10, 29],
  [50, 34],
  [250, 40],
  [1_000, 47],
  [5_000, 54],
] as const;

const CLUSTER_TEXT_STOPS = [
  [1, 14],
  [50, 15],
  [250, 16],
  [1_000, 17],
  [5_000, 18],
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
    ["get", "event_count"],
    CLUSTER_RADIUS_STOPS[0][1],
    ...CLUSTER_RADIUS_STOPS.slice(1).flat(),
  ] as ExpressionSpecification;
}

export function eventClusterTextSizeExpression(): ExpressionSpecification {
  return [
    "step",
    ["get", "event_count"],
    CLUSTER_TEXT_STOPS[0][1],
    ...CLUSTER_TEXT_STOPS.slice(1).flat(),
  ] as ExpressionSpecification;
}

export function eventClusterCountExpression(): ExpressionSpecification {
  return ["get", "event_count"] as ExpressionSpecification;
}

export function clusterExpansionTargetZoom(currentZoom: number, expansionZoom: number): number {
  const safeCurrentZoom = Number.isFinite(currentZoom) ? currentZoom : 0;
  const safeExpansionZoom = Number.isFinite(expansionZoom) ? expansionZoom : safeCurrentZoom + 1;

  return Math.min(
    EVENT_CLUSTER_EXPANSION_MAX_ZOOM,
    Math.max(safeExpansionZoom + 0.35, safeCurrentZoom + 1.25),
  );
}

export function serverClusterExpansionTargetZoom(
  currentZoom: number,
  serverClusterMaxZoom: number,
): number {
  const safeCurrentZoom = Number.isFinite(currentZoom) ? Math.max(0, currentZoom) : 0;
  const safeServerMaxZoom = Number.isFinite(serverClusterMaxZoom)
    ? Math.max(0, serverClusterMaxZoom)
    : safeCurrentZoom + 1;

  return Math.min(safeServerMaxZoom, safeCurrentZoom + 3);
}

export function shouldOpenClusterSelection(currentZoom: number, expansionZoom: number): boolean {
  return (
    (Number.isFinite(currentZoom) && currentZoom >= EVENT_CLUSTER_TERMINAL_ZOOM) ||
    !Number.isFinite(expansionZoom) ||
    expansionZoom > EVENT_CLUSTER_TERMINAL_ZOOM
  );
}

export function clusterLeafPageRequest(
  pointCount: number,
  offset: number,
  batchSize = CLUSTER_SELECTION_PAGE_SIZE,
): { limit: number; offset: number } | null {
  const total = Number.isFinite(pointCount) ? Math.max(0, Math.floor(pointCount)) : 0;
  const normalizedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("batchSize must be a positive integer");
  }
  if (normalizedOffset >= total) return null;
  return {
    limit: Math.min(batchSize, total - normalizedOffset),
    offset: normalizedOffset,
  };
}
