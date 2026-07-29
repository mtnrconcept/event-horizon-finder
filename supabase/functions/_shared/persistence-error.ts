const TERMINAL_PERSISTENCE_RPCS = new Set([
  "upsert_ingested_event_serial_v1",
  "upsert_ingested_event_v2",
]);

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "unknown_error";
}

export function terminalPersistenceErrorCode(
  rpcName: string,
  databaseCode: string | null | undefined,
  message: string,
): string | null {
  if (!TERMINAL_PERSISTENCE_RPCS.has(rpcName) || databaseCode !== "P0001") return null;
  return /^invalid_start_date(?:\b|:)/i.test(message.trim())
    ? "persistence_invalid_start_date"
    : null;
}
