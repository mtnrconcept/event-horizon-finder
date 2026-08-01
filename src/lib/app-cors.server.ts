const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://mtnrconcept.github.io",
  "https://event-horizon-finder.vercel.app",
]);

const ALLOWED_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "prefer",
  "range",
  "x-client-info",
  "x-eventa-supabase-path",
].join(", ");

const EXPOSED_HEADERS = ["content-range", "preference-applied", "range-unit"].join(", ");

function configuredOrigins(): Set<string> {
  const origins = new Set(DEFAULT_ALLOWED_ORIGINS);
  const configured = [
    process.env.ALLOWED_APP_ORIGINS ?? "",
    process.env.SITE_URL ?? "",
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "",
  ];

  for (const value of configured.flatMap((entry) => entry.split(","))) {
    const candidate = value.trim();
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // Ignore malformed optional origins.
    }
  }

  return origins;
}

function appendVary(headers: Headers, value: string) {
  const current = headers.get("vary");
  const values = new Set(
    (current ? current.split(",") : []).map((entry) => entry.trim()).filter(Boolean),
  );
  values.add(value);
  headers.set("vary", [...values].join(", "));
}

function corsHeaders(request: Request): Headers | null {
  const origin = request.headers.get("origin");
  if (!origin) return new Headers();
  if (!configuredOrigins().has(origin)) return null;

  const headers = new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-expose-headers": EXPOSED_HEADERS,
    "access-control-max-age": "86400",
  });
  appendVary(headers, "Origin");
  appendVary(headers, "Access-Control-Request-Headers");
  return headers;
}

export function handleAppCorsPreflight(request: Request): Response {
  const headers = corsHeaders(request);
  if (!headers) {
    return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  }
  return new Response(null, { status: 204, headers });
}

export function applyAppCors(request: Request, response: Response): Response {
  const cors = corsHeaders(request);
  if (!cors) {
    return Response.json({ error: "origin_not_allowed" }, { status: 403 });
  }

  const headers = new Headers(response.headers);
  cors.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
