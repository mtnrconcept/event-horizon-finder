export type CompactMapPinKind = "event" | "cluster";
export type MapPinClusterMode = "client" | "grid" | "location";

export type CompactMapPin = readonly [
  kind: CompactMapPinKind,
  entityId: string,
  longitude: number,
  latitude: number,
  categorySlug: string,
  isFree: 0 | 1,
  approximate: 0 | 1,
  eventSlug: string,
  eventCount: number,
  freeCount: number,
];

export type CompactMapPinBatch = {
  pins: CompactMapPin[];
  totalCount: number;
  freeCount: number;
  clustered: boolean;
  clusterMode: MapPinClusterMode;
  truncated: boolean;
};

function parseNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseV2Pin(row: unknown): CompactMapPin | null {
  if (
    !Array.isArray(row) ||
    row.length !== 10 ||
    (row[0] !== "event" && row[0] !== "cluster") ||
    typeof row[1] !== "string" ||
    typeof row[2] !== "number" ||
    !Number.isFinite(row[2]) ||
    typeof row[3] !== "number" ||
    !Number.isFinite(row[3]) ||
    typeof row[4] !== "string" ||
    (row[5] !== 0 && row[5] !== 1) ||
    (row[6] !== 0 && row[6] !== 1) ||
    typeof row[7] !== "string"
  ) {
    return null;
  }

  const eventCount = parseNonNegativeInteger(row[8]);
  const freeCount = parseNonNegativeInteger(row[9]);
  if (eventCount === null || eventCount < 1 || freeCount === null || freeCount > eventCount) {
    return null;
  }
  if (row[0] === "event" && eventCount !== 1) return null;

  return row as unknown as CompactMapPin;
}

function parseLegacyPin(row: unknown): CompactMapPin | null {
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
    return null;
  }

  return ["event", row[0], row[1], row[2], row[3], row[4], row[5], row[6], 1, row[4]];
}

function parsePinRows(rows: unknown[]): CompactMapPin[] {
  return rows.flatMap((row) => {
    const parsed = parseV2Pin(row) ?? parseLegacyPin(row);
    return parsed ? [parsed] : [];
  });
}

export function parseCompactMapPinBatch(data: unknown): CompactMapPinBatch {
  if (Array.isArray(data)) {
    const pins = parsePinRows(data);
    return {
      pins,
      totalCount: pins.reduce((count, pin) => count + pin[8], 0),
      freeCount: pins.reduce((count, pin) => count + pin[9], 0),
      clustered: false,
      clusterMode: "client",
      truncated: false,
    };
  }

  if (!data || typeof data !== "object") throw new Error("Invalid compact map pin response");
  const response = data as Record<string, unknown>;
  if (!Array.isArray(response.pins)) throw new Error("Invalid compact map pin response");

  const pins = parsePinRows(response.pins);
  const totalCount = parseNonNegativeInteger(response.total_count);
  const freeCount = parseNonNegativeInteger(response.free_count);
  if (totalCount === null || freeCount === null || freeCount > totalCount) {
    throw new Error("Invalid compact map pin response metadata");
  }

  return {
    pins,
    totalCount,
    freeCount,
    clustered: response.clustered === true,
    clusterMode:
      response.cluster_mode === "location"
        ? "location"
        : response.clustered === true
          ? "grid"
          : "client",
    truncated: response.truncated === true,
  };
}

export function parseCompactMapPins(data: unknown): CompactMapPin[] {
  return parseCompactMapPinBatch(data).pins;
}
