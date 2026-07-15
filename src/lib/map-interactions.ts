export type MapHitKind = "cluster" | "event" | "venue";

export type MapHitCandidate<T> = {
  kind: MapHitKind;
  x: number;
  y: number;
  value: T;
};

const HIT_PRIORITY: Record<MapHitKind, number> = {
  cluster: 3,
  event: 2,
  venue: 1,
};

/**
 * Selects one deterministic feature for a pointer interaction. The distance is
 * considered first; when markers share a coordinate, clusters win over events,
 * then venues. Keeping this logic independent from MapLibre makes the mobile
 * hit-area behaviour straightforward to verify.
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
