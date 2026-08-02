export const MAP_REQUEST_RETRY_DELAYS_MS = [300, 900, 1_800] as const;

type MapRequestError = {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
};

export type MapRequestRetryOptions = {
  signal?: AbortSignal;
  delaysMs?: readonly number[];
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
};

function normalizedCode(error: MapRequestError): string {
  return typeof error.code === "string" ? error.code.trim().toUpperCase() : "";
}

function normalizedStatus(error: MapRequestError): number | null {
  const candidate = error.status ?? error.statusCode;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) return Number(candidate);
  return null;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "";
  const candidate = error as MapRequestError;
  return [candidate.message, candidate.details, candidate.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

export function isMapRequestAborted(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!error || typeof error !== "object") return false;
  return (error as MapRequestError).name === "AbortError";
}

/**
 * Retries only failures that are expected to recover without changing the
 * request. Schema, validation, authorization, and other permanent errors are
 * deliberately excluded.
 */
export function isTransientMapRequestError(error: unknown, signal?: AbortSignal): boolean {
  if (isMapRequestAborted(error, signal)) return false;

  const candidate = error && typeof error === "object" ? (error as MapRequestError) : {};
  const code = normalizedCode(candidate);
  const status = normalizedStatus(candidate);
  const message = errorText(error);

  // A database statement timeout is deterministic for the same query plan.
  // Repeating it only multiplies load and delays the visible recovery path.
  if (
    code === "57014" ||
    code.startsWith("SUPABASE_PROXY_") ||
    /statement timeout|canceling statement due to statement timeout/i.test(message)
  ) {
    return false;
  }
  if (status !== null && status >= 500 && status <= 599) return true;
  if (/^5\d\d$/.test(code)) return true;
  if (/^08[A-Z0-9]{3}$/.test(code)) return true;
  if (["53300", "57P01", "57P02", "57P03"].includes(code)) return true;
  if (/^PGRST00[0-3]$/.test(code)) return true;

  return /failed to fetch|fetch failed|networkerror|network request|name_not_resolved|load failed|service unavailable|bad gateway|gateway timeout|internal server error|connection (?:closed|refused|reset)|timed? ?out|\bhttp\s+5\d\d\b/i.test(
    message,
  );
}

export function jitteredMapRetryDelay(
  baseDelayMs: number,
  random: () => number = Math.random,
): number {
  const normalizedBase = Number.isFinite(baseDelayMs) ? Math.max(0, baseDelayMs) : 0;
  const normalizedRandom = Math.min(1, Math.max(0, random()));
  return Math.round(normalizedBase * (0.8 + normalizedRandom * 0.4));
}

export function waitForMapRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The request was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export async function runMapRequestWithRetry<T>(
  request: (attempt: number) => Promise<T>,
  {
    signal,
    delaysMs = MAP_REQUEST_RETRY_DELAYS_MS,
    random = Math.random,
    sleep = waitForMapRetry,
  }: MapRequestRetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await request(attempt);
    } catch (error) {
      if (
        attempt >= delaysMs.length ||
        isMapRequestAborted(error, signal) ||
        !isTransientMapRequestError(error, signal)
      ) {
        throw error;
      }
      await sleep(jitteredMapRetryDelay(delaysMs[attempt], random), signal);
    }
  }
}
