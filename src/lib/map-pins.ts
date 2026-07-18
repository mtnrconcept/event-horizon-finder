export type CompactMapPin = readonly [
  occurrenceId: string,
  longitude: number,
  latitude: number,
  categorySlug: string,
  isFree: 0 | 1,
  approximate: 0 | 1,
  eventSlug: string,
];

export function parseCompactMapPins(data: unknown): CompactMapPin[] {
  if (!Array.isArray(data)) throw new Error("Invalid compact map pin response");

  return data.flatMap((row) => {
    if (
      !Array.isArray(row) ||
      row.length !== 7 ||
      typeof row[0] !== "string" ||
      typeof row[1] !== "number" ||
      !Number.isFinite(row[1]) ||
      typeof row[2] !== "number" ||
      !Number.isFinite(row[2]) ||
      typeof row[3] !== "string" ||
      (row[4] !== 0 && row[4] !== 1) ||
      (row[5] !== 0 && row[5] !== 1) ||
      typeof row[6] !== "string"
    ) {
      return [];
    }

    return [row as unknown as CompactMapPin];
  });
}
