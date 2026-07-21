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
  category: { slug: string; name_fr: string } | { slug: string; name_fr: string }[] | null;
  organizer: { name: string; website: string | null } | { name: string; website: string | null }[] | null;
  venue:
    | {
        name: string;
        address: string | null;
        postal_code: string | null;
        city:
          | {
              name: string;
              timezone: string;
              country: { code: string; name: string } | { code: string; name: string }[] | null;
              region: { name: string } | { name: string }[] | null;
            }
          | Array<{
              name: string;
              timezone: string;
              country: { code: string; name: string } | { code: string; name: string }[] | null;
              region: { name: string } | { name: string }[] | null;
            }>
          | null;
      }
    | Array<{
        name: string;
        address: string | null;
        postal_code: string | null;
        city: {
          name: string;
          timezone: string;
          country: { code: string; name: string } | null;
          region: { name: string } | null;
        } | null;
      }>
    | null;
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

type EventCard = {
  id: string;
  occurrence_id: string;
  title: string;
  url: string;
  description: string | null;
  category: string | null;
  genres: string[];
  starts_at: string;
  ends_at: string | null;
  timezone: string;
  venue: string | null;
  city: string | null;
  free: boolean;
  verified: boolean;
  price_from: number | null;
  price_to: number | null;
  tickets_available: boolean;
  wheelchair_accessible: boolean;
  image_url: string | null;
};

type HelpResult = {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  kind: "article" | "faq" | "legal";
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const WIDGET_URI = "ui://global-party/event-explorer-v2.html";
const WIDGET_MIME_TYPE = "text/html;profile=mcp-app";
const MAX_BODY_BYTES = 1_048_576;
const SERVER_VERSION = "2.0.0";

const SECURITY_SCHEMES = [{ type: "noauth" }];
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const EVENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          occurrence_id: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          description: { type: ["string", "null"] },
          category: { type: ["string", "null"] },
          genres: { type: "array", items: { type: "string" } },
          starts_at: { type: "string" },
          ends_at: { type: ["string", "null"] },
          timezone: { type: "string" },
          venue: { type: ["string", "null"] },
          city: { type: ["string", "null"] },
          free: { type: "boolean" },
          verified: { type: "boolean" },
          price_from: { type: ["number", "null"] },
          price_to: { type: ["number", "null"] },
          tickets_available: { type: "boolean" },
          wheelchair_accessible: { type: "boolean" },
          image_url: { type: ["string", "null"] },
        },
        required: ["id", "occurrence_id", "title", "url", "genres", "starts_at", "timezone", "free", "verified", "tickets_available", "wheelchair_accessible"],
        additionalProperties: false,
      },
    },
    applied_filters: { type: "object", additionalProperties: true },
  },
  required: ["events", "applied_filters"],
  additionalProperties: false,
};

const SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
        },
        required: ["id", "title", "url"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const FETCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    text: { type: "string" },
    url: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
    event: { type: "object", additionalProperties: true },
  },
  required: ["id", "title", "text", "url", "metadata", "event"],
  additionalProperties: false,
};

const HELP_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          excerpt: { type: "string" },
          url: { type: "string" },
          kind: { type: "string", enum: ["article", "faq", "legal"] },
        },
        required: ["id", "title", "excerpt", "url", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

function toolMeta(invoking: string, invoked: string, withWidget = true) {
  return {
    securitySchemes: SECURITY_SCHEMES,
    ...(withWidget
      ? {
          ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] },
          "openai/outputTemplate": WIDGET_URI,
          "openai/widgetAccessible": true,
        }
      : {}),
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

const TOOLS = [
  {
    name: "search",
    title: "Rechercher dans Global Party",
    description:
      "Search Global Party's public event catalogue by keywords, artist, venue or city. Use this first for broad catalogue research, then call fetch with one returned id for authoritative details.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 200, description: "Keywords, artist, venue, city or event name" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: SEARCH_OUTPUT_SCHEMA,
    securitySchemes: SECURITY_SCHEMES,
    annotations: TOOL_ANNOTATIONS,
    _meta: toolMeta("Recherche des événements…", "Résultats prêts"),
  },
  {
    name: "fetch",
    title: "Lire une fiche Global Party",
    description:
      "Fetch the full authoritative public details for one Global Party event. Accepts an event UUID or slug returned by search or discover_events.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: 180, description: "Global Party event UUID or slug" } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: FETCH_OUTPUT_SCHEMA,
    securitySchemes: SECURITY_SCHEMES,
    annotations: TOOL_ANNOTATIONS,
    _meta: toolMeta("Chargement de la fiche…", "Fiche prête"),
  },
  {
    name: "discover_events",
    title: "Découvrir des événements",
    description:
      "Recommend public events filtered by city, country, dates, categories, music genres, price, tickets, verification or wheelchair accessibility. Use for travel plans, nights out and activity recommendations.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200, description: "Optional artist, venue or event keywords" },
        city: { type: "string", maxLength: 100, description: "City name, for example Geneva or Paris" },
        country: { type: "string", maxLength: 80, description: "Country name or ISO code" },
        date_from: { type: "string", format: "date-time", description: "Inclusive ISO-8601 start" },
        date_to: { type: "string", format: "date-time", description: "Exclusive ISO-8601 end" },
        categories: {
          type: "array",
          items: { type: "string", enum: ["concerts", "festivals", "soirees", "expositions", "theatre", "famille"] },
          maxItems: 6,
        },
        genres: { type: "array", items: { type: "string", minLength: 1, maxLength: 60 }, maxItems: 12 },
        free_only: { type: "boolean", default: false },
        tickets_only: { type: "boolean", default: false },
        verified_only: { type: "boolean", default: false },
        accessible_only: { type: "boolean", default: false },
        max_price: { type: "number", minimum: 0, maximum: 100000 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      additionalProperties: false,
    },
    outputSchema: EVENT_OUTPUT_SCHEMA,
    securitySchemes: SECURITY_SCHEMES,
    annotations: TOOL_ANNOTATIONS,
    _meta: toolMeta("Recherche selon tes critères…", "Sélection prête"),
  },
  {
    name: "upcoming_events",
    title: "Voir les événements à venir",
    description:
      "Return a compact selection of upcoming public events, optionally for a city or country. Use when the user asks what is happening soon without detailed filters.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", maxLength: 100 },
        country: { type: "string", maxLength: 80 },
        days: { type: "integer", minimum: 1, maximum: 180, default: 30 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      additionalProperties: false,
    },
    outputSchema: EVENT_OUTPUT_SCHEMA,
    securitySchemes: SECURITY_SCHEMES,
    annotations: TOOL_ANNOTATIONS,
    _meta: toolMeta("Chargement des prochains événements…", "Événements prêts"),
  },
  {
    name: "search_help",
    title: "Rechercher dans le centre d’aide",
    description:
      "Search Global Party help articles, FAQ and legal pages. Use for questions about accounts, privacy, social features, cookies, organizers or data rights.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: HELP_OUTPUT_SCHEMA,
    securitySchemes: SECURITY_SCHEMES,
    annotations: TOOL_ANNOTATIONS,
    _meta: toolMeta("Recherche dans l’aide…", "Réponses d’aide prêtes", false),
  },
] as const;

function publicConfig() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Global Party public catalogue is temporarily unavailable.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Global Party public catalogue is temporarily unavailable.");
  }
  if (parsed.protocol !== "https:") throw new Error("Global Party public catalogue is temporarily unavailable.");
  return { url: parsed.origin, key };
}

function supabaseHeaders(key: string, json = false) {
  const headers = new Headers({ apikey: key, Accept: "application/json" });
  if (json) headers.set("Content-Type", "application/json");
  if (!key.startsWith("sb_publishable_")) headers.set("Authorization", `Bearer ${key}`);
  return headers;
}

async function postgrest<T>(path: string, init?: RequestInit): Promise<T> {
  const { url, key } = publicConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: supabaseHeaders(key, Boolean(init?.body)),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error("[mcp] catalogue request failed", { status: response.status, path: path.split("?")[0] });
      throw new Error("Global Party catalogue request failed.");
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Global Party catalogue request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeLookupTerm(value: unknown, maxLength: number) {
  return safeText(value, maxLength)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s'’-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeIso(value: unknown, fallback: Date) {
  const text = safeText(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : fallback.toISOString();
}

function canonicalBase(request: Request) {
  const configured = process.env.SITE_URL?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.origin;
    } catch {
      // Fall through to the request origin.
    }
  }
  return new URL(request.url).origin;
}

function eventUrl(request: Request, slug: string) {
  return `${canonicalBase(request)}/event/${encodeURIComponent(slug)}`;
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function resolveCountryId(country: string) {
  const term = safeLookupTerm(country, 80);
  if (!term) return null;
  const query = new URLSearchParams({ select: "id,code,name", limit: "10" });
  query.set("or", `(code.ilike.${term},name.ilike.*${term}*)`);
  const rows = await postgrest<Array<{ id: string; code: string; name: string }>>(`countries?${query}`);
  const normalized = term.toLocaleLowerCase();
  return (
    (rows.find((row) => row.code.toLocaleLowerCase() === normalized || row.name.toLocaleLowerCase() === normalized) ?? rows[0])?.id ?? null
  );
}

async function resolveCityId(city: string, countryId: string | null) {
  const term = safeLookupTerm(city, 100);
  if (!term) return null;
  const query = new URLSearchParams({ select: "id,name,slug", limit: "20" });
  query.set("name", `ilike.*${term}*`);
  if (countryId) query.set("country_id", `eq.${countryId}`);
  const rows = await postgrest<Array<{ id: string; name: string; slug: string }>>(`cities?${query}`);
  const normalized = term.toLocaleLowerCase();
  return (
    (rows.find((row) => row.name.toLocaleLowerCase() === normalized) ?? rows.find((row) => row.name.toLocaleLowerCase().startsWith(normalized)) ?? rows[0])?.id ?? null
  );
}

function normalizeStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => safeLookupTerm(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function validateDateRange(from: string, to: string) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error("date_to must be later than date_from");
  }
  if (toMs - fromMs > 730 * 24 * 60 * 60 * 1_000) {
    throw new Error("The requested date range cannot exceed 730 days");
  }
}

async function discover(request: Request, args: Record<string, unknown>) {
  const country = safeLookupTerm(args.country, 80);
  const city = safeLookupTerm(args.city, 100);
  const countryId = country ? await resolveCountryId(country) : null;
  const cityId = city ? await resolveCityId(city, countryId) : null;
  const now = new Date();
  const oneYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000);
  const from = safeIso(args.date_from, now);
  const to = safeIso(args.date_to, oneYear);
  validateDateRange(from, to);
  const limit = Math.min(Math.max(Math.trunc(Number(args.limit)) || 10, 1), 20);
  const body: Record<string, unknown> = {
    _from: from,
    _to: to,
    _limit: limit,
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
  const categories = normalizeStringArray(args.categories, 6, 40);
  const genres = normalizeStringArray(args.genres, 12, 60);
  if (categories?.length) body._category_slugs = categories;
  if (genres?.length) body._genres = genres;
  if (typeof args.max_price === "number" && Number.isFinite(args.max_price) && args.max_price >= 0) {
    body._price_max = Math.min(args.max_price, 100_000);
  }

  const rows = await postgrest<DiscoveredEventRow[]>("rpc/discover_events", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const events: EventCard[] = rows.map((row) => ({
    id: row.event_id,
    occurrence_id: row.occurrence_id,
    title: row.title,
    url: eventUrl(request, row.slug),
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
    wheelchair_accessible: row.wheelchair,
    image_url: row.cover_image_url,
  }));
  return {
    events,
    applied_filters: {
      query: query || null,
      city: city || null,
      country: country || null,
      date_from: from,
      date_to: to,
      categories: categories ?? [],
      genres: genres ?? [],
      free_only: body._free_only,
      tickets_only: body._tickets_only,
      verified_only: body._verified_only,
      accessible_only: body._accessible_only,
      max_price: body._price_max ?? null,
    },
  };
}

async function searchTool(request: Request, args: Record<string, unknown>) {
  const query = safeText(args.query, 200);
  if (!query) throw new Error("query is required");
  let payload = await discover(request, { query, limit: 10 });
  if (!payload.events.length) {
    const cityId = await resolveCityId(query, null);
    if (cityId) {
      const now = new Date();
      const oneYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000);
      const rows = await postgrest<DiscoveredEventRow[]>("rpc/discover_events", {
        method: "POST",
        body: JSON.stringify({ _city_id: cityId, _from: now.toISOString(), _to: oneYear.toISOString(), _limit: 10, _offset: 0 }),
      });
      payload = {
        events: rows.map((row) => ({
          id: row.event_id,
          occurrence_id: row.occurrence_id,
          title: row.title,
          url: eventUrl(request, row.slug),
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
          wheelchair_accessible: row.wheelchair,
          image_url: row.cover_image_url,
        })),
        applied_filters: { city: query },
      };
    }
  }
  return {
    results: payload.events.map((event) => ({ id: event.id, title: event.title, url: event.url })),
    events: payload.events,
  };
}

async function fetchTool(request: Request, args: Record<string, unknown>) {
  const rawId = safeText(args.id, 180);
  if (!rawId) throw new Error("id is required");
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawId);
  const id = isUuid ? rawId : rawId.toLocaleLowerCase();
  if (!isUuid && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("Invalid event id or slug");
  const select =
    "id,slug,title,short_description,description,official_url,cover_image_url,is_free,is_verified,status,genres,category:event_categories(slug,name_fr),organizer:organizers(name,website),venue:venues(name,address,postal_code,city:cities(name,timezone,country:countries(code,name),region:regions(name))),occurrences:event_occurrences(starts_at,ends_at,timezone),offers:ticket_offers(name,price_min,price_max,currency,is_free,ticket_url,status)";
  const query = new URLSearchParams({ select, limit: "1", status: "eq.published" });
  query.set(isUuid ? "id" : "slug", `eq.${id}`);
  const rows = await postgrest<EventDetailRow[]>(`events?${query}`);
  const event = rows[0];
  if (!event) throw new Error("Event not found");
  const occurrence = [...(event.occurrences ?? [])].sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  const offer = (event.offers ?? [])[0];
  const venue = firstRelation(event.venue);
  const city = firstRelation(venue?.city);
  const country = firstRelation(city?.country);
  const region = firstRelation(city?.region);
  const category = firstRelation(event.category);
  const organizer = firstRelation(event.organizer);
  const location = [venue?.name, venue?.address, venue?.postal_code, city?.name, region?.name, country?.name].filter(Boolean).join(", ");
  const price = offer?.is_free || event.is_free
    ? "Free"
    : offer
      ? `${[offer.price_min, offer.price_max].filter((value) => value != null).join(" – ")}${offer.currency ? ` ${offer.currency}` : ""}`
      : "Not specified";
  const text = [
    event.short_description,
    event.description,
    occurrence ? `Date: ${occurrence.starts_at}${occurrence.ends_at ? ` to ${occurrence.ends_at}` : ""} (${occurrence.timezone})` : null,
    location ? `Location: ${location}` : null,
    `Price: ${price}`,
    event.genres?.length ? `Music styles: ${event.genres.join(", ")}` : null,
    organizer?.name ? `Organizer: ${organizer.name}` : null,
    offer?.ticket_url ? `Tickets: ${offer.ticket_url}` : event.official_url ? `Official page: ${event.official_url}` : null,
  ].filter(Boolean).join("\n\n");
  const url = eventUrl(request, event.slug);
  return {
    id: event.id,
    title: event.title,
    text,
    url,
    metadata: {
      slug: event.slug,
      category: category?.slug ?? null,
      verified: event.is_verified,
      status: event.status,
      starts_at: occurrence?.starts_at ?? null,
      city: city?.name ?? null,
      image_url: event.cover_image_url,
    },
    event: {
      id: event.id,
      occurrence_id: occurrence?.starts_at ? `${event.id}:${occurrence.starts_at}` : event.id,
      title: event.title,
      url,
      description: event.short_description ?? event.description,
      category: category?.slug ?? null,
      genres: event.genres ?? [],
      starts_at: occurrence?.starts_at ?? "",
      ends_at: occurrence?.ends_at ?? null,
      timezone: occurrence?.timezone ?? city?.timezone ?? "Europe/Zurich",
      venue: venue?.name ?? null,
      city: city?.name ?? null,
      free: event.is_free || Boolean(offer?.is_free),
      verified: event.is_verified,
      price_from: offer?.price_min ?? null,
      price_to: offer?.price_max ?? null,
      tickets_available: Boolean(offer?.ticket_url),
      wheelchair_accessible: false,
      image_url: event.cover_image_url,
    },
  };
}

async function searchHelp(request: Request, args: Record<string, unknown>) {
  const query = safeLookupTerm(args.query, 160);
  if (!query) throw new Error("query is required");
  const articleParams = new URLSearchParams({
    select: "id,slug,title,excerpt",
    locale: "eq.fr",
    is_published: "eq.true",
    limit: "8",
  });
  articleParams.set("or", `(title.ilike.*${query}*,excerpt.ilike.*${query}*)`);
  const faqParams = new URLSearchParams({
    select: "id,question,answer_markdown,category",
    locale: "eq.fr",
    is_published: "eq.true",
    limit: "8",
  });
  faqParams.set("or", `(question.ilike.*${query}*,answer_markdown.ilike.*${query}*)`);
  const [articles, faqs] = await Promise.all([
    postgrest<Array<{ id: string; slug: string; title: string; excerpt: string | null }>>(`help_articles?${articleParams}`),
    postgrest<Array<{ id: string; question: string; answer_markdown: string; category: string }>>(`faq_items?${faqParams}`),
  ]);
  const base = canonicalBase(request);
  const results: HelpResult[] = [
    ...articles.map((article) => ({ id: article.id, title: article.title, excerpt: article.excerpt ?? "", url: `${base}/help?q=${encodeURIComponent(article.title)}`, kind: "article" as const })),
    ...faqs.map((faq) => ({ id: faq.id, title: faq.question, excerpt: faq.answer_markdown.slice(0, 280), url: `${base}/faq?q=${encodeURIComponent(faq.question)}`, kind: "faq" as const })),
  ];
  const legal = [
    { id: "privacy", title: "Politique de confidentialité", excerpt: "Données, finalités, destinataires et droits.", url: `${base}/privacy`, kind: "legal" as const },
    { id: "cookies", title: "Politique de cookies", excerpt: "Stockages nécessaires et choix facultatifs.", url: `${base}/cookies`, kind: "legal" as const },
    { id: "terms", title: "Conditions générales d’utilisation", excerpt: "Règles du service et de la communauté.", url: `${base}/terms`, kind: "legal" as const },
  ].filter((item) => `${item.title} ${item.excerpt}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return { results: [...results, ...legal].slice(0, 15) };
}

function textContent(payload: unknown, summary?: string) {
  return [{ type: "text", text: summary || JSON.stringify(payload) }];
}

function toolResult(structuredContent: unknown, summary?: string, meta?: Record<string, unknown>) {
  return {
    structuredContent,
    content: textContent(structuredContent, summary),
    ...(meta ? { _meta: meta } : {}),
  };
}

async function callTool(request: Request, params: Record<string, unknown>) {
  const name = safeText(params.name, 80);
  const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
    ? (params.arguments as Record<string, unknown>)
    : {};

  if (name === "search") {
    const payload = await searchTool(request, args);
    return toolResult({ results: payload.results }, `Found ${payload.results.length} Global Party events.`, { events: payload.events });
  }
  if (name === "fetch") {
    const payload = await fetchTool(request, args);
    return toolResult(payload, `${payload.title}\n\n${payload.text}`);
  }
  if (name === "discover_events") {
    const payload = await discover(request, args);
    return toolResult(payload, `Found ${payload.events.length} events matching the requested filters.`);
  }
  if (name === "upcoming_events") {
    const days = Math.min(Math.max(Math.trunc(Number(args.days)) || 30, 1), 180);
    const now = new Date();
    const payload = await discover(request, {
      city: args.city,
      country: args.country,
      date_from: now.toISOString(),
      date_to: new Date(now.getTime() + days * 24 * 60 * 60 * 1_000).toISOString(),
      limit: args.limit,
    });
    return toolResult(payload, `Found ${payload.events.length} upcoming events for the next ${days} days.`);
  }
  if (name === "search_help") {
    const payload = await searchHelp(request, args);
    return toolResult(payload, `Found ${payload.results.length} help resources.`);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function widgetHtml() {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--bg:light-dark(#fff,#121217);--card:light-dark(#f7f7fa,#1b1b22);--border:light-dark(#e5e5eb,#30303b);--text:light-dark(#17171d,#f8f8fb);--muted:light-dark(#666675,#aaaab8);--accent:#8b5cf6;--accent2:#ec4899}*{box-sizing:border-box}body{margin:0;background:transparent;color:var(--text)}#root{padding:12px}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.brand{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:800}.dot{width:10px;height:10px;border-radius:999px;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 0 16px color-mix(in srgb,var(--accent) 55%,transparent)}.count{font-size:11px;color:var(--muted)}.grid{display:grid;gap:10px}.card{display:grid;grid-template-columns:62px minmax(0,1fr);gap:12px;padding:12px;border:1px solid var(--border);border-radius:18px;background:var(--card);text-decoration:none;color:inherit;transition:.18s ease}.card:hover{border-color:color-mix(in srgb,var(--accent) 55%,var(--border));transform:translateY(-1px)}.date{display:grid;place-items:center;align-content:center;min-height:62px;border-radius:14px;background:linear-gradient(145deg,color-mix(in srgb,var(--accent) 18%,transparent),color-mix(in srgb,var(--accent2) 12%,transparent));text-align:center}.day{font-size:22px;font-weight:900;line-height:1}.month{margin-top:4px;font-size:10px;font-weight:800;text-transform:uppercase;color:var(--muted)}.title{font-size:14px;font-weight:850;line-height:1.25}.meta{display:flex;flex-wrap:wrap;gap:5px 9px;margin-top:6px;font-size:11px;color:var(--muted)}.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.chip{padding:3px 7px;border-radius:999px;background:color-mix(in srgb,var(--accent) 12%,transparent);font-size:9px;font-weight:750;color:color-mix(in srgb,var(--accent) 80%,var(--text))}.empty{padding:28px 16px;border:1px dashed var(--border);border-radius:18px;text-align:center;color:var(--muted);font-size:13px}.error{color:#ef4444}.detail{padding:16px;border:1px solid var(--border);border-radius:20px;background:var(--card)}.detail h2{margin:0;font-size:18px}.detail p{white-space:pre-wrap;font-size:12px;line-height:1.55;color:var(--muted)}.open{display:inline-flex;margin-top:10px;padding:8px 12px;border-radius:999px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;text-decoration:none;font-size:11px;font-weight:800}@media(max-width:420px){#root{padding:8px}.card{grid-template-columns:54px minmax(0,1fr);padding:10px}.date{min-height:54px}.day{font-size:19px}}
</style>
</head>
<body><div id="root"><div class="empty">Chargement des événements…</div></div>
<script>
(()=>{const root=document.getElementById('root');const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const fmt=(v)=>{const d=new Date(v);return Number.isFinite(d.getTime())?{day:new Intl.DateTimeFormat('fr',{day:'2-digit'}).format(d),month:new Intl.DateTimeFormat('fr',{month:'short'}).format(d),full:new Intl.DateTimeFormat('fr',{dateStyle:'medium',timeStyle:'short'}).format(d)}:{day:'–',month:'',full:''}};const eventCard=(e)=>{const d=fmt(e.starts_at);const price=e.free?'Gratuit':e.price_from!=null?'Dès '+esc(e.price_from):'';return '<a class="card" href="'+esc(e.url)+'" target="_blank" rel="noopener"><div class="date"><span class="day">'+d.day+'</span><span class="month">'+esc(d.month)+'</span></div><div><div class="title">'+esc(e.title)+'</div><div class="meta"><span>'+esc(d.full)+'</span>'+(e.city?'<span>📍 '+esc(e.city)+'</span>':'')+(e.venue?'<span>'+esc(e.venue)+'</span>':'')+'</div><div class="chips">'+(e.verified?'<span class="chip">Vérifié</span>':'')+(price?'<span class="chip">'+price+'</span>':'')+(e.wheelchair_accessible?'<span class="chip">Accessible</span>':'')+(e.genres||[]).slice(0,3).map(g=>'<span class="chip">'+esc(g)+'</span>').join('')+'</div></div></a>'};const render=(raw)=>{const p=raw?.structuredContent??raw?.result?.structuredContent??raw?.toolOutput??raw;if(!p){root.innerHTML='<div class="empty">Aucune donnée reçue.</div>';return}if(p.event){root.innerHTML='<div class="detail"><h2>'+esc(p.title||p.event.title)+'</h2><p>'+esc(p.text||p.event.description||'')+'</p><a class="open" href="'+esc(p.url||p.event.url)+'" target="_blank" rel="noopener">Ouvrir la fiche</a></div>';return}const events=p.events??raw?._meta?.events??[];if(Array.isArray(events)){root.innerHTML='<div class="top"><div class="brand"><span class="dot"></span>Global Party</div><span class="count">'+events.length+' résultat'+(events.length>1?'s':'')+'</span></div>'+(events.length?'<div class="grid">'+events.map(eventCard).join('')+'</div>':'<div class="empty">Aucun événement ne correspond à ces critères.</div>');return}root.innerHTML='<div class="empty">Résultat prêt dans la conversation.</div>'};window.addEventListener('message',e=>{if(e.source!==window.parent)return;const m=e.data;if(!m||m.jsonrpc!=='2.0'||m.method!=='ui/notifications/tool-result')return;render(m.params)}, {passive:true});if(window.openai?.toolOutput)render(window.openai.toolOutput)})();
</script></body></html>`;
}

function resourceDescriptor() {
  return {
    uri: WIDGET_URI,
    name: "global-party-event-explorer",
    title: "Global Party Event Explorer",
    description: "Interactive compact event cards for Global Party search and recommendations.",
    mimeType: WIDGET_MIME_TYPE,
  };
}

function resourceContents(request: Request) {
  const base = canonicalBase(request);
  const resourceDomains = [base];
  try {
    resourceDomains.push(publicConfig().url);
  } catch {
    // The resource remains usable without external assets.
  }
  return {
    uri: WIDGET_URI,
    mimeType: WIDGET_MIME_TYPE,
    text: widgetHtml(),
    _meta: {
      ui: {
        prefersBorder: true,
        domain: base,
        csp: { connectDomains: [], resourceDomains },
      },
      "openai/widgetDescription": "Displays Global Party event recommendations as compact date cards with city, venue, price and accessibility indicators.",
      "openai/widgetPrefersBorder": true,
      "openai/widgetCSP": { connect_domains: [], resource_domains: resourceDomains },
    },
  };
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
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
          },
          serverInfo: { name: "global-party", title: "Global Party", version: SERVER_VERSION },
          instructions:
            "Search and recommend public Global Party events. Use discover_events for filtered recommendations, search then fetch for authoritative event research, upcoming_events for near-term discovery, and search_help for product or privacy questions. Never invent missing event details; present dates with their timezone and link to the canonical Global Party page.",
        },
      };
    }
    if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (message.method === "tools/call") return { jsonrpc: "2.0", id, result: await callTool(request, message.params ?? {}) };
    if (message.method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [resourceDescriptor()] } };
    if (message.method === "resources/read") {
      const uri = safeText(message.params?.uri, 300);
      if (uri !== WIDGET_URI) return { jsonrpc: "2.0", id, error: { code: -32002, message: "Resource not found" } };
      return { jsonrpc: "2.0", id, result: { contents: [resourceContents(request)] } };
    }
    if (message.method === "resources/templates/list") return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    if (message.method === "prompts/list") return { jsonrpc: "2.0", id, result: { prompts: [] } };
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Tool execution failed";
    console.error("[mcp] request failed", { method: message.method, message: messageText });
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

function responseHeaders(protocolVersion = DEFAULT_PROTOCOL_VERSION) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "MCP-Protocol-Version, MCP-Session-Id, Server-Timing",
    "MCP-Protocol-Version": protocolVersion,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

export async function handleMcpRequest(request: Request) {
  const startedAt = Date.now();
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const payload = {
      name: "Global Party MCP",
      version: SERVER_VERSION,
      endpoint: "/mcp",
      transport: "streamable-http",
      protocol_versions: SUPPORTED_PROTOCOL_VERSIONS,
      tools: TOOLS.map((tool) => tool.name),
      widget: WIDGET_URI,
      status: "ok",
    };
    return new Response(request.method === "HEAD" ? null : JSON.stringify(payload), {
      status: 200,
      headers: { ...responseHeaders(), "Server-Timing": `app;dur=${Date.now() - startedAt}` },
    });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...responseHeaders(), Allow: "GET, HEAD, POST, OPTIONS" },
    });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request body too large" } }), {
      status: 413,
      headers: responseHeaders(),
    });
  }

  let raw = "";
  try {
    raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new Error("too-large");
  } catch (error) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: error instanceof Error && error.message === "too-large" ? "Request body too large" : "Unable to read request" } }), {
      status: error instanceof Error && error.message === "too-large" ? 413 : 400,
      headers: responseHeaders(),
    });
  }

  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), {
      status: 400,
      headers: responseHeaders(),
    });
  }

  const requestedProtocol = safeText(request.headers.get("mcp-protocol-version"), 30);
  const protocol = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedProtocol) ? requestedProtocol : DEFAULT_PROTOCOL_VERSION;
  const headers = { ...responseHeaders(protocol), "Server-Timing": `app;dur=${Date.now() - startedAt}` };

  if (Array.isArray(payload)) {
    if (!payload.length) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }), {
        status: 400,
        headers,
      });
    }
    const responses = (
      await Promise.all(payload.map((message) => message && typeof message === "object" && message.id !== undefined ? processMessage(request, message) : Promise.resolve(null)))
    ).filter(Boolean);
    return responses.length
      ? new Response(JSON.stringify(responses), { headers })
      : new Response(null, { status: 202, headers });
  }

  if (!payload || typeof payload !== "object") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }), { status: 400, headers });
  }
  if (payload.id === undefined) return new Response(null, { status: 202, headers });
  return new Response(JSON.stringify(await processMessage(request, payload)), { headers });
}

export { TOOLS, WIDGET_URI, WIDGET_MIME_TYPE };
