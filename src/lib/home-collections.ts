import type { DiscoveredEvent } from "./queries";

export type HomeCollections = {
  top: DiscoveredEvent[];
  free: DiscoveredEvent[];
  nightlife: DiscoveredEvent[];
  festivals: DiscoveredEvent[];
};

function parseHomeCollection(value: unknown): DiscoveredEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is DiscoveredEvent =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as Partial<DiscoveredEvent>).event_id === "string" &&
      typeof (row as Partial<DiscoveredEvent>).occurrence_id === "string" &&
      typeof (row as Partial<DiscoveredEvent>).title === "string" &&
      typeof (row as Partial<DiscoveredEvent>).starts_at === "string",
  );
}

export function parseHomeCollections(value: unknown): HomeCollections {
  const payload =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    top: parseHomeCollection(payload.top),
    free: parseHomeCollection(payload.free),
    nightlife: parseHomeCollection(payload.nightlife),
    festivals: parseHomeCollection(payload.festivals),
  };
}
