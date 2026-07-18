export type MapHitKind = "cluster" | "event";

export type MapHitCandidate<T> = {
  kind: MapHitKind;
  x: number;
  y: number;
  value: T;
};

export type MapEventPinPreviewResult<T> =
  | { status: "ready"; preview: T }
  | { status: "missing" }
  | { status: "error" }
  | { status: "stale" };

export type MapEventPinSelectionResult<T> =
  | { status: "ready"; selection: T }
  | { status: "missing" }
  | { status: "error" }
  | { status: "stale" };

const HIT_PRIORITY: Record<MapHitKind, number> = {
  cluster: 2,
  event: 1,
};

/**
 * Returns the occurrence selected by an event pin. Compact worldwide pins are
 * intentionally identified by occurrence id only: a slug must never turn a
 * map click into implicit navigation.
 */
export function mapEventPinOccurrenceId(
  properties: { kind?: unknown; entity_id?: unknown; [key: string]: unknown } | null | undefined,
): string | null {
  if (properties?.kind !== "event" || typeof properties.entity_id !== "string") return null;
  const occurrenceId = properties.entity_id.trim();
  return occurrenceId || null;
}

/**
 * Resolves the lightweight details needed by the in-place event dialog while
 * keeping late responses from reopening or replacing a newer selection.
 */
export async function resolveMapEventPinPreview<T>(
  occurrenceId: string,
  resolvePreview: (occurrenceId: string) => Promise<T | null>,
  isCurrent: () => boolean,
): Promise<MapEventPinPreviewResult<T>> {
  const result = await resolveMapEventPinSelection(occurrenceId, resolvePreview, isCurrent);
  return result.status === "ready" ? { status: "ready", preview: result.selection } : result;
}

/**
 * Resolves the full in-place selection while preventing a late request from
 * reopening a dialog that was closed or replacing a more recent pin click.
 */
export async function resolveMapEventPinSelection<T>(
  occurrenceId: string,
  resolveSelection: (occurrenceId: string) => Promise<T | null>,
  isCurrent: () => boolean,
): Promise<MapEventPinSelectionResult<T>> {
  try {
    const selection = await resolveSelection(occurrenceId);
    if (!isCurrent()) return { status: "stale" };
    return selection ? { status: "ready", selection } : { status: "missing" };
  } catch {
    return isCurrent() ? { status: "error" } : { status: "stale" };
  }
}

/**
 * Picks the visually dominant feature from features rendered directly below a
 * pointer. This deliberately ignores marker-center distance: a large cluster
 * remains clickable all the way to the edge of its painted circle.
 */
export function selectHighestPriorityMapHit<T>(
  candidates: MapHitCandidate<T>[],
): MapHitCandidate<T> | null {
  let selected: MapHitCandidate<T> | null = null;

  for (const candidate of candidates) {
    if (!selected || HIT_PRIORITY[candidate.kind] > HIT_PRIORITY[selected.kind]) {
      selected = candidate;
    }
  }

  return selected;
}

/**
 * Selects one deterministic feature for a pointer interaction. The distance is
 * considered first; when markers share a coordinate, clusters win over events.
 * Keeping this logic independent from MapLibre makes the mobile hit-area
 * behaviour straightforward to verify.
 */
export function selectNearestMapHit<T>(
  candidates: MapHitCandidate<T>[],
  target: { x: number; y: number },
  radius: number,
): MapHitCandidate<T> | null {
  const maximumDistanceSquared = Math.max(0, radius) ** 2;
  let selected: MapHitCandidate<T> | null = null;
  let selectedDistanceSquared = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const deltaX = candidate.x - target.x;
    const deltaY = candidate.y - target.y;
    const distanceSquared = deltaX * deltaX + deltaY * deltaY;
    if (distanceSquared > maximumDistanceSquared) continue;

    const isCloser = distanceSquared < selectedDistanceSquared;
    const hasHigherPriorityAtSamePosition =
      distanceSquared === selectedDistanceSquared &&
      selected != null &&
      HIT_PRIORITY[candidate.kind] > HIT_PRIORITY[selected.kind];

    if (!selected || isCloser || hasHigherPriorityAtSamePosition) {
      selected = candidate;
      selectedDistanceSquared = distanceSquared;
    }
  }

  return selected;
}
