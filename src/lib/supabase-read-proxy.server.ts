import {
  isAllowedSupabaseReadProxyRequest,
  isSafeSupabaseProxyPublishableKey,
  normalizeSupabaseReadProxyTarget,
  SUPABASE_READ_PROXY_TARGET_HEADER,
} from "@/lib/supabase-read-proxy";

const MAX_PROXY_REQUEST_BYTES = 64 * 1024;
const MAX_PROXY_RESPONSE_BYTES = 5 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 120;
const MAX_RATE_LIMIT_CLIENTS = 2_000;
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "prefer",
  "range",
  "x-client-info",
] as const;

export function createSupabaseProxyUpstreamHeaders(
  request: Request,
  publishableKey: string,
): Headers {
  const headers = new Headers({
    apikey: publishableKey,
    "accept-profile": "public",
    "content-profile": "public",
  });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

type RateLimitEntry = { count: number; resetAt: number };

const rateLimitEntries = new Map<string, RateLimitEntry>();

class ProxyBodyTooLargeError extends Error {
  readonly phase: "request" | "response";

  constructor(phase: "request" | "response") {
    super(`Supabase proxy ${phase} body is too large`);
    this.phase = phase;
  }
}

function proxyClientKey(request: Request): string {
  const vercelForwardedFor = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    vercelForwardedFor || request.headers.get("x-real-ip")?.trim() || forwardedFor || "unknown"
  );
}

function consumeRateLimit(request: Request, now = Date.now()): boolean {
  const key = proxyClientKey(request);
  const current = rateLimitEntries.get(key);
  if (!current || current.resetAt <= now) {
    if (!current && rateLimitEntries.size >= MAX_RATE_LIMIT_CLIENTS) {
      const oldestKey = rateLimitEntries.keys().next().value;
      if (oldestKey) rateLimitEntries.delete(oldestKey);
    }
    rateLimitEntries.delete(key);
    rateLimitEntries.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (current.count >= RATE_LIMIT_REQUESTS) return false;
  current.count += 1;
  return true;
}

export async function readBoundedProxyBody(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
  phase: "request" | "response",
): Promise<ArrayBuffer | undefined> {
  if (!stream) return undefined;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("Proxy body limit exceeded");
        throw new ProxyBodyTooLargeError(phase);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }

  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Supabase proxy body read aborted", "AbortError");
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}
const FORWARDED_RESPONSE_HEADERS = [
  "content-range",
  "content-type",
  "preference-applied",
  "range-unit",
] as const;

function jsonError(status: number, message: string, code: string): Response {
  return Response.json(
    { message, code },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        Vary: "Authorization",
      },
    },
  );
}

/**
 * Relays public/read-only Supabase requests through the application origin.
 * This is a resilience path for browser DNS failures, not a privilege bypass:
 * the publishable key and the caller's bearer token still enforce RLS.
 */
export async function handleSupabaseReadProxy(request: Request): Promise<Response> {
  const method = request.method.toUpperCase();
  const rawTarget = request.headers.get(SUPABASE_READ_PROXY_TARGET_HEADER) ?? "";
  const target = normalizeSupabaseReadProxyTarget(rawTarget);
  if (
    !target ||
    !isAllowedSupabaseReadProxyRequest(method, new URL(target, "https://x").pathname)
  ) {
    return jsonError(403, "Supabase proxy request is not allowed", "SUPABASE_PROXY_FORBIDDEN");
  }

  const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL)?.trim();
  const publishableKey = (
    process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  )?.trim();
  if (!supabaseUrl || !publishableKey) {
    return jsonError(503, "Supabase proxy is not configured", "SUPABASE_PROXY_UNCONFIGURED");
  }
  if (!isSafeSupabaseProxyPublishableKey(publishableKey)) {
    return jsonError(
      503,
      "Supabase proxy requires an anonymous publishable key",
      "SUPABASE_PROXY_UNSAFE_KEY",
    );
  }
  if (!consumeRateLimit(request)) {
    return jsonError(429, "Supabase proxy rate limit exceeded", "SUPABASE_PROXY_RATE_LIMITED");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_REQUEST_BYTES) {
    return jsonError(413, "Supabase proxy request is too large", "SUPABASE_PROXY_TOO_LARGE");
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) forwardAbort();
  else request.signal.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Supabase proxy timed out", "TimeoutError")),
    UPSTREAM_TIMEOUT_MS,
  );

  try {
    const body =
      method === "POST"
        ? await readBoundedProxyBody(
            request.body,
            MAX_PROXY_REQUEST_BYTES,
            controller.signal,
            "request",
          )
        : undefined;
    const headers = createSupabaseProxyUpstreamHeaders(request, publishableKey);

    const upstream = await fetch(new URL(target, `${supabaseUrl.replace(/\/$/, "")}/`), {
      method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    const responseHeaders = new Headers({
      "Cache-Control": "no-store",
      Vary: "Authorization",
    });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    const responseBody =
      method === "HEAD"
        ? undefined
        : await readBoundedProxyBody(
            upstream.body,
            MAX_PROXY_RESPONSE_BYTES,
            controller.signal,
            "response",
          );
    return new Response(responseBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof ProxyBodyTooLargeError) {
      return jsonError(
        413,
        `Supabase proxy ${error.phase} is too large`,
        error.phase === "request"
          ? "SUPABASE_PROXY_REQUEST_TOO_LARGE"
          : "SUPABASE_PROXY_RESPONSE_TOO_LARGE",
      );
    }
    const timedOut = controller.signal.aborted;
    return jsonError(
      timedOut ? 504 : 502,
      timedOut ? "Supabase proxy timed out" : "Supabase proxy is temporarily unavailable",
      timedOut ? "SUPABASE_PROXY_TIMEOUT" : "SUPABASE_PROXY_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", forwardAbort);
  }
}
