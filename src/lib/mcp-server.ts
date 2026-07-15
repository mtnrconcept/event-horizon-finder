type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type DiscoveredEventRow = {
  event_id: string;
  occurrence_id: string;
  slug: string;
  title: string;
  short_description: string | null;
  cover_image_url: string | null;
  category_slug: string | null;
  genres: string[] | null;
  starts_at: string;
  ends_at: string | null;
  timezone: string;
  venue_name: string | null;
  city_name: string | null;
  is_free: boolean;
  is_verified: boolean;
  status: string;
  price_from: number | null;
  price_to: number | null;
  has_tickets: boolean;
  capacity: number | null;
  wheelchair: boolean;
  location_precision: string;
};

type EventDetailRow = {
  id: string;
  slug: string;
  title: string;
  short_description: string | null;
  description: string | null;
  official_url: string | null;
  cover_image_url: string | null;
  is_free: boolean;
  is_verified: boolean;
  status: string;
  genres: string[] | null;
  category: { slug: string; name_fr: string } | null;
  organizer: { name: string; website: string | null } | null;
  venue: {
    name: string;
    address: string | null;
    postal_code: string | null;
    city: {
      name: string;
      timezone: string;
      country: { code: string; name: string } | null;
      region: { name: string } | null;
    } | null;
  } | null;
  occurrences: Array<{ starts_at: string; ends_at: string | null; timezone: string }>;
  offers: Array<{
    name: string | null;
    price_min: number | null;
    price_max: number | null;
    currency: string | null;
    is_free: boolean;
    ticket_url: string | null;
    status: string | null;
  }>;
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const TOOLS = [
  {
    name: "search",
    title: "Rechercher dans EVENTA",
    description:
      "Use this when the user wants to search EVENTA's public event catalogue by keywords. Returns canonical EVENTA result URLs for citations and follow-up fetches.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, description: "Search query" } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: TOOL_ANNOTATIONS,
  },
  {
    name: "fetch",
    title: "Lire une fiche EVENTA",
    description:
      "Use this when the user wants the full, authoritative details of one EVENTA event returned by search. Accepts an EVENTA event id or slug.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, description: "EVENTA event id or slug" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: TOOL_ANNOTATIONS,
  },
  {
    name: "discover_events",
    title: "Découvrir des événements",
    description:
      "Use this when the user wants event recommendations filtered by city, country, dates, category, music style, price or accessibility. This is a public read-only catalogue search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional artist, venue or event keywords" },
        city: { type: "string", description: "City name, for example Geneva or Paris" },
        country: { type: "string", description: "Country name or ISO code" },
        date_from: { type: "string", format: "date-time", description: "Inclusive ISO-8601 start" },
        date_to: { type: "string", format: "date-time", description: "Exclusive ISO-8601 end" },
        categories: {
          type: "array",
          items: {
            type: "string",
            enum: ["concerts", "festivals", "soirees", "expositions", "theatre", "famille"],
          },
          maxItems: 6,
        },
        genres: { type: "array", items: { type: "string" }, maxItems: 12 },
        free_only: { type: "boolean", default: false },
        tickets_only: { type: "boolean", default: false },
        verified_only: { type: "boolean", default: false },
        accessible_only: { type: "boolean", default: false },
        max_price: { type: "number", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      additionalProperties: false,
    },
    annotations: TOOL_ANNOTATIONS,
  },
] as const;

function publicConfig() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("EVENTA public catalogue is temporarily unavailable.");
  return { url: url.replace(/\/$/, ""), key };
}

function supabaseHeaders(key: string, json = false) {
  const headers = new Headers({ apikey: key, Accept: "application/json" });
  if (json) headers.set("Content-Type", "application/json");
  if (!key.startsWith("sb_publishable_")) headers.set("Authorization", `Bearer ${key}`);
  return headers;
}

async function postgrest<T>(path: string, init?: RequestInit): Promise<T> {
  const { url, key } = publicConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: supabaseHeaders(key, Boolean(init?.body)),
  });
  if (!response.ok) {
    throw new Error(`EVENTA catalogue request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeIso(value: unknown, fallback: Date) {
  const text = safeText(value, 40);
  return text && Number.isFinite(Date.parse(text))
    ? new Date(text).toISOString()
    : fallback.toISOString();
}

function canonicalBase(request: Request) {
  return (process.env.SITE_URL?.trim().replace(/\/$/, "") || new URL(request.url).origin).replace(
    /\/$/,
    "",
  );
}

function eventUrl(request: Request, slug: string) {
  return `${canonicalBase(request)}/event/${encodeURIComponent(slug)}`;
}

async function resolveCountryId(country: string) {
  const term = safeText(country, 80);
  if (!term) return null;
  const query = new URLSearchParams({ select: "id,code,name", limit: "10" });
  query.set("or", `(code.ilike.${term},name.ilike.*${term}*)`);
  const rows = await postgrest<Array<{ id: string; code: string; name: string }>>(
    `countries?${query}`,
  );
  const normalized = term.toLocaleLowerCase();
  return (
    (
      rows.find(
        (row) =>
          row.code.toLocaleLowerCase() === normalized ||
          row.name.toLocaleLowerCase() === normalized,
      ) ?? rows[0]
    )?.id ?? null
  );
}

async function resolveCityId(city: string, countryId: string | null) {
  const term = safeText(city, 100);
  if (!term) return null;
  const query = new URLSearchParams({ select: "id,name,slug", limit: "20" });
  query.set("name", `ilike.*${term}*`);
  if (countryId) query.set("country_id", `eq.${countryId}`);
  const rows = await postgrest<Array<{ id: string; name: string; slug: string }>>(
    `cities?${query}`,
  );
  const normalized = term.toLocaleLowerCase();
  return (
    (
      rows.find((row) => row.name.toLocaleLowerCase() === normalized) ??
      rows.find((row) => row.name.toLocaleLowerCase().startsWith(normalized)) ??
      rows[0]
    )?.id ?? null
  );
}

async function discover(args: Record<string, unknown>) {
  const country = safeText(args.country, 80);
  const city = safeText(args.city, 100);
  const countryId = country ? await resolveCountryId(country) : null;
  const cityId = city ? await resolveCityId(city, countryId) : null;
  const now = new Date();
  const oneYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000);
  const body: Record<string, unknown> = {
    _from: safeIso(args.date_from, now),
    _to: safeIso(args.date_to, oneYear),
    _limit: Math.min(Math.max(Number(args.limit) || 10, 1), 20),
    _offset: 0,
    _free_only: args.free_only === true,
    _tickets_only: args.tickets_only === true,
    _verified_only: args.verified_only === true,
    _accessible_only: args.accessible_only === true,
  };
  const query = safeText(args.query, 200);
  if (query) body._query = query;
  if (countryId) body._country_id = countryId;
  if (cityId) body._city_id = cityId;
  if (Array.isArray(args.categories)) body._category_slugs = args.categories.slice(0, 6);
  if (Array.isArray(args.genres)) body._genres = args.genres.slice(0, 12);
  if (typeof args.max_price === "number" && args.max_price >= 0) body._price_max = args.max_price;

  const rows = await postgrest<DiscoveredEventRow[]>("rpc/discover_events", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return rows.map((row) => ({
    id: row.event_id,
    occurrence_id: row.occurrence_id,
    title: row.title,
    url_slug: row.slug,
    description: row.short_description,
    category: row.category_slug,
    genres: row.genres ?? [],
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    timezone: row.timezone,
    venue: row.venue_name,
    city: row.city_name,
    free: row.is_free,
    verified: row.is_verified,
    price_from: row.price_from,
    price_to: row.price_to,
    tickets_available: row.has_tickets,
    capacity: row.capacity,
    wheelchair_accessible: row.wheelchair,
    location_precision: row.location_precision,
    image_url: row.cover_image_url,
  }));
}

async function searchTool(request: Request, args: Record<string, unknown>) {
  const query = safeText(args.query, 200);
  if (!query) throw new Error("query is required");
  let rows = await discover({ query, limit: 10 });
  if (!rows.length) {
    const cityId = await resolveCityId(query, null);
    if (cityId) {
      const now = new Date();
      const oneYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000);
      const fallback = await postgrest<DiscoveredEventRow[]>("rpc/discover_events", {
        method: "POST",
        body: JSON.stringify({
          _city_id: cityId,
          _from: now.toISOString(),
          _to: oneYear.toISOString(),
          _limit: 10,
          _offset: 0,
        }),
      });
      rows = fallback.map((row) => ({
        id: row.event_id,
        occurrence_id: row.occurrence_id,
        title: row.title,
        url_slug: row.slug,
        description: row.short_description,
        category: row.category_slug,
        genres: row.genres ?? [],
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        timezone: row.timezone,
        venue: row.venue_name,
        city: row.city_name,
        free: row.is_free,
        verified: row.is_verified,
        price_from: row.price_from,
        price_to: row.price_to,
        tickets_available: row.has_tickets,
        capacity: row.capacity,
        wheelchair_accessible: row.wheelchair,
        location_precision: row.location_precision,
        image_url: row.cover_image_url,
      }));
    }
  }
  return {
    results: rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: eventUrl(request, row.url_slug),
    })),
  };
}

async function fetchTool(request: Request, args: Record<string, unknown>) {
  const id = safeText(args.id, 180);
  if (!id) throw new Error("id is required");
  const select =
    "id,slug,title,short_description,description,official_url,cover_image_url,is_free,is_verified,status,genres,category:event_categories(slug,name_fr),organizer:organizers(name,website),venue:venues(name,address,postal_code,city:cities(name,timezone,country:countries(code,name),region:regions(name))),occurrences:event_occurrences(starts_at,ends_at,timezone),offers:ticket_offers(name,price_min,price_max,currency,is_free,ticket_url,status)";
  const query = new URLSearchParams({ select, limit: "1", status: "eq.published" });
  if (/^[0-9a-f-]{36}$/i.test(id)) query.set("id", `eq.${id}`);
  else query.set("slug", `eq.${id}`);
  const rows = await postgrest<EventDetailRow[]>(`events?${query}`);
  const event = rows[0];
  if (!event) throw new Error("Event not found");
  const occurrence = [...(event.occurrences ?? [])].sort((a, b) =>
    a.starts_at.localeCompare(b.starts_at),
  )[0];
  const offer = (event.offers ?? [])[0];
  const location = [
    event.venue?.name,
    event.venue?.address,
    event.venue?.postal_code,
    event.venue?.city?.name,
    event.venue?.city?.region?.name,
    event.venue?.city?.country?.name,
  ]
    .filter(Boolean)
    .join(", ");
  const price =
    offer?.is_free || event.is_free
      ? "Free"
      : offer
        ? [offer.price_min, offer.price_max].filter((value) => value != null).join(" – ") +
          (offer.currency ? ` ${offer.currency}` : "")
        : "Not specified";
  const text = [
    event.short_description,
    event.description,
    occurrence
      ? `Date: ${occurrence.starts_at}${occurrence.ends_at ? ` to ${occurrence.ends_at}` : ""} (${occurrence.timezone})`
      : null,
    location ? `Location: ${location}` : null,
    `Price: ${price}`,
    event.genres?.length ? `Music styles: ${event.genres.join(", ")}` : null,
    event.organizer?.name ? `Organizer: ${event.organizer.name}` : null,
    offer?.ticket_url
      ? `Tickets: ${offer.ticket_url}`
      : event.official_url
        ? `Official page: ${event.official_url}`
        : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    id: event.id,
    title: event.title,
    text,
    url: eventUrl(request, event.slug),
    metadata: {
      slug: event.slug,
      category: event.category?.slug ?? null,
      verified: event.is_verified,
      status: event.status,
      starts_at: occurrence?.starts_at ?? null,
      city: event.venue?.city?.name ?? null,
      image_url: event.cover_image_url,
    },
  };
}

function resultText(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

async function callTool(request: Request, params: Record<string, unknown>) {
  const name = safeText(params.name, 80);
  const args =
    params.arguments && typeof params.arguments === "object"
      ? (params.arguments as Record<string, unknown>)
      : {};
  if (name === "search") return resultText(await searchTool(request, args));
  if (name === "fetch") return resultText(await fetchTool(request, args));
  if (name === "discover_events") {
    const rows = await discover(args);
    return resultText({
      events: rows.map((row) => ({
        ...row,
        url: eventUrl(request, row.url_slug),
        url_slug: undefined,
      })),
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function processMessage(request: Request, message: JsonRpcRequest) {
  const id = message.id ?? null;
  if (message.jsonrpc !== "2.0" || !message.method) {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
  }
  try {
    if (message.method === "initialize") {
      const requested = safeText(message.params?.protocolVersion, 30);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "eventa", title: "EVENTA", version: "1.0.0" },
          instructions:
            "Search and recommend public events from EVENTA. Prefer search then fetch for cited research, and discover_events for filtered recommendations.",
        },
      };
    }
    if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (message.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }
    if (message.method === "tools/call") {
      return { jsonrpc: "2.0", id, result: await callTool(request, message.params ?? {}) };
    }
    if (message.method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    }
    if (message.method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Tool execution failed";
    if (message.method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: messageText }], isError: true },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32603, message: messageText } };
  }
}

const RESPONSE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "MCP-Protocol-Version",
  "MCP-Protocol-Version": DEFAULT_PROTOCOL_VERSION,
  "X-Content-Type-Options": "nosniff",
};

export async function handleMcpRequest(request: Request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, accept, mcp-protocol-version",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ name: "EVENTA MCP", endpoint: "/mcp", transport: "streamable-http" }),
      { status: 405, headers: { ...RESPONSE_HEADERS, Allow: "POST, OPTIONS" } },
    );
  }

  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = (await request.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  if (Array.isArray(payload)) {
    if (!payload.length) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request" },
        }),
        { status: 400, headers: RESPONSE_HEADERS },
      );
    }
    const responses = (
      await Promise.all(
        payload.map((message) =>
          message.id === undefined ? Promise.resolve(null) : processMessage(request, message),
        ),
      )
    ).filter(Boolean);
    return responses.length
      ? new Response(JSON.stringify(responses), { headers: RESPONSE_HEADERS })
      : new Response(null, { status: 202 });
  }

  if (payload.id === undefined) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(await processMessage(request, payload)), {
    headers: RESPONSE_HEADERS,
  });
}

export { TOOLS };
