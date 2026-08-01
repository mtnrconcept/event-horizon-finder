import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.2";
import {
  discoverLadecadanseLinks,
  findLicensedCommonsVenueMedia,
  LADECADANSE_HOST,
  LADECADANSE_ROOT_URL,
  LADECADANSE_VENUE_CATALOG_URL,
  parseLadecadanseEventPage,
  parseLadecadanseVenuePage,
  venuePayload,
  type LadecadanseDiscoveredLink,
} from "../_shared/ladecadanse-adapter.ts";
import {
  normalizeEventCandidate,
  type EventSourceContext,
  type NormalizedEvent,
} from "../_shared/event-precision.ts";
import { evaluateRobotsPolicy, parseRobotsTxt } from "../_shared/robots-policy.ts";

type JsonObject = Record<string, unknown>;
type AdminClient = SupabaseClient;
type QueueItem = {
  id: string;
  kind: "agenda" | "venue_catalog" | "venue" | "event";
  source_url: string;
  external_identifier: string | null;
  attempt_count: number;
  max_attempts: number;
  metadata: JsonObject | null;
};
type DataSource = {
  id: string;
  name: string;
  domain: string;
  category_slug: string | null;
  metadata: JsonObject | null;
  city: {
    id: string;
    name: string;
    timezone: string;
    latitude: number | null;
    longitude: number | null;
    country: { code: string } | null;
  } | null;
};
type UpsertOutcome = {
  event_id?: string;
  action?: string;
  score?: number;
  published?: boolean;
};

const USER_AGENT =
  "GlobalParty-LaDecadanse/1.0 (+https://github.com/mtnrconcept/event-horizon-finder)";
const ROBOTS_AGENT = "GlobalParty-LaDecadanse";
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH_SIZE = 4;
const MAX_BATCH_SIZE = 8;
const DEFAULT_MAX_BATCHES = 1;
const MAX_BATCHES = 25;
const EXECUTION_BUDGET_MS = 110_000;

class SyncError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number;
  readonly terminal: boolean;

  constructor(
    code: string,
    options: { message?: string; retryAfterSeconds?: number; terminal?: boolean } = {},
  ) {
    super(options.message ?? code);
    this.name = "SyncError";
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 300;
    this.terminal = options.terminal ?? false;
  }
}

function json(req: Request, body: unknown, status = 200): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    vary: "Origin",
  });
  const origin = allowedOrigin(req);
  if (origin) headers.set("access-control-allow-origin", origin);
  return new Response(JSON.stringify(body), { status, headers });
}

function allowedOrigin(req: Request): string | null {
  const configured = (Deno.env.get("APP_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const origin = req.headers.get("origin");
  if (!origin) return configured.includes("*") ? "*" : null;
  return configured.includes("*") || configured.includes(origin) ? origin : null;
}

function optionsResponse(req: Request): Response {
  const headers = new Headers({
    "access-control-allow-headers":
      "authorization, apikey, content-type, x-client-info, x-global-scraper-secret",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "Origin",
  });
  const origin = allowedOrigin(req);
  if (origin) headers.set("access-control-allow-origin", origin);
  return new Response(null, { status: 204, headers });
}

function createAdminClient(): AdminClient {
  const url = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ??
    Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (!url || !serviceKey) throw new SyncError("server_not_configured", { terminal: true });
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function isAuthorized(req: Request, admin: AdminClient): Promise<boolean> {
  const expected = Deno.env.get("GLOBAL_SCRAPER_SECRET")?.trim() ?? "";
  const supplied = req.headers.get("x-global-scraper-secret")?.trim() ?? "";
  if (expected.length >= 32 && supplied.length >= 32 && timingSafeEqual(expected, supplied)) {
    return true;
  }

  const authorization = req.headers.get("authorization");
  if (!authorization) return false;
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { authorization } } },
  );
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return false;
  const { data, error } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .in("role", ["admin", "moderator"]);
  return !error && Boolean(data?.length);
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function exactSourceUrl(value: string): string {
  const url = new URL(value, LADECADANSE_ROOT_URL);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase().replace(/\.$/, "") !== LADECADANSE_HOST
  ) {
    throw new SyncError("source_url_not_allowed", { terminal: true });
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
}

async function limitedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("response_too_large");
        throw new SyncError("response_too_large", { retryAfterSeconds: 3_600 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5",
        "accept-language": "fr-CH,fr;q=0.9,en;q=0.6",
        "user-agent": USER_AGENT,
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    throw new SyncError("source_fetch_failed", {
      message: error instanceof Error ? error.message : "source_fetch_failed",
      retryAfterSeconds: 600,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function robotsRules(): Promise<ReturnType<typeof parseRobotsTxt>> {
  const response = await fetchWithTimeout(`${LADECADANSE_ROOT_URL}robots.txt`, {
    headers: { accept: "text/plain,*/*;q=0.1", "user-agent": USER_AGENT },
  });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new SyncError("robots_disallowed", { terminal: true });
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return { groups: [], sitemaps: [] };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SyncError("robots_unavailable", { retryAfterSeconds: 900 });
  }
  return parseRobotsTxt(await limitedText(response, 512_000));
}

async function fetchSourceHtml(
  sourceUrl: string,
  robots: ReturnType<typeof parseRobotsTxt>,
): Promise<{ html: string; url: string; status: number }> {
  let currentUrl = exactSourceUrl(sourceUrl);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const decision = evaluateRobotsPolicy(robots, currentUrl, ROBOTS_AGENT);
    if (!decision.allowed) throw new SyncError("robots_disallowed", { terminal: true });
    const delayMs = Math.ceil((decision.crawlDelaySeconds ?? 0) * 1_000);
    if (delayMs > 5_000) {
      throw new SyncError("crawl_delay_deferred", {
        retryAfterSeconds: Math.ceil(delayMs / 1_000),
      });
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

    const response = await fetchWithTimeout(currentUrl);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new SyncError("redirect_without_location", { terminal: true });
      currentUrl = exactSourceUrl(new URL(location, currentUrl).toString());
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new SyncError(`source_http_${response.status}`, {
        retryAfterSeconds: response.status === 429 ? 1_800 : 600,
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SyncError(`source_http_${response.status}`, { terminal: response.status === 404 });
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !contentType.includes("html") && !contentType.includes("text/plain")) {
      await response.body?.cancel();
      throw new SyncError("source_non_html", { terminal: true });
    }
    return {
      html: await limitedText(response, MAX_BODY_BYTES),
      url: currentUrl,
      status: response.status,
    };
  }
  throw new SyncError("too_many_redirects", { terminal: true });
}

async function rpc<T>(admin: AdminClient, name: string, args: JsonObject = {}): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new SyncError(`${name}_failed`, { message: error.message });
  return data as T;
}

async function sourceContext(
  admin: AdminClient,
): Promise<{ source: DataSource; context: EventSourceContext }> {
  const { data, error } = await admin
    .from("data_sources")
    .select(
      "id,name,domain,category_slug,metadata,city:cities(id,name,timezone,latitude,longitude,country:countries(code))",
    )
    .eq("status", "active")
    .eq("is_authorized", true)
    .eq("is_verified", true)
    .eq("domain", LADECADANSE_HOST)
    .limit(1)
    .maybeSingle();
  if (error) throw new SyncError("source_lookup_failed", { message: error.message });
  const source = data as unknown as DataSource | null;
  if (!source?.id || !source.city) throw new SyncError("source_not_configured", { terminal: true });
  return {
    source,
    context: {
      id: source.id,
      name: source.name,
      domain: source.domain,
      category_slug: source.category_slug,
      metadata: source.metadata,
      city: {
        name: source.city.name,
        timezone: source.city.timezone,
        latitude: source.city.latitude,
        longitude: source.city.longitude,
        country: source.city.country,
      },
    },
  };
}

function queuedLinks(links: LadecadanseDiscoveredLink[]): JsonObject[] {
  return links.map((link) => ({
    kind: link.kind,
    url: link.url,
    external_identifier: link.externalIdentifier,
    priority: link.priority,
    metadata: { adapter: "ladecadanse-v1" },
  }));
}

async function enqueue(admin: AdminClient, links: LadecadanseDiscoveredLink[]): Promise<number> {
  if (!links.length) return 0;
  let total = 0;
  for (let offset = 0; offset < links.length; offset += 200) {
    total += Number(
      (await rpc<number>(admin, "enqueue_ladecadanse_sync_items_v1", {
        _items: queuedLinks(links.slice(offset, offset + 200)),
      })) ?? 0,
    );
  }
  return total;
}

async function seedCatalog(admin: AdminClient): Promise<number> {
  const links: LadecadanseDiscoveredLink[] = [
    { kind: "agenda", url: LADECADANSE_ROOT_URL, externalIdentifier: null, priority: 5 },
  ];
  for (let page = 1; page <= 4; page += 1) {
    links.push({
      kind: "venue_catalog",
      url:
        page === 1
          ? LADECADANSE_VENUE_CATALOG_URL
          : `${LADECADANSE_VENUE_CATALOG_URL}?page=${page}`,
      externalIdentifier: null,
      priority: 10 + page,
    });
  }
  return await enqueue(admin, links);
}

function eventPayload(event: NormalizedEvent): JsonObject {
  return {
    source_url: event.sourceUrl,
    external_identifier: event.externalId,
    title: event.title,
    description: event.description,
    starts_at: event.startDate,
    ends_at: event.endDate,
    timezone: event.timezone,
    time_precision: event.timePrecision,
    all_day: event.allDay,
    venue_name: event.venueName,
    venue_url: event.venueUrl,
    address: event.address,
    postal_code: event.postalCode,
    city: event.city,
    region: event.region,
    country_code: event.countryCode,
    latitude: event.latitude,
    longitude: event.longitude,
    organizer_name: event.organizerName,
    organizer_url: event.organizerUrl,
    status: event.status,
    language: event.language,
    category: event.category,
    genres: event.genres,
    capacity: event.capacity,
    age_restriction: event.ageRestriction,
    price_min: event.priceMin,
    price_max: event.priceMax,
    currency: event.currency,
    ticket_url: event.ticketUrl,
    ticket_status: event.isFree ? "free" : event.ticketUrl ? "available" : "unknown",
    image_url: event.imageUrl,
    image_attribution: event.imageUrl ? `La Décadanse — ${event.title}` : null,
    is_free: event.isFree,
    performers: event.performers.map((performer) => ({
      name: performer.name,
      type: performer.type,
      image_url: performer.imageUrl,
      is_headliner: performer.isHeadliner,
    })),
    accessibility: event.accessibility
      ? {
          wheelchair: event.accessibility.wheelchair,
          hearing_loop: event.accessibility.hearingLoop,
          sign_language: event.accessibility.signLanguage,
          quiet_space: event.accessibility.quietSpace,
          notes: event.accessibility.notes,
        }
      : null,
    quality_score: event.qualityScore,
    warnings: event.warnings,
    extraction_method: event.extractionMethod,
  };
}

async function persistEvent(
  admin: AdminClient,
  source: DataSource,
  context: EventSourceContext,
  html: string,
  pageUrl: string,
): Promise<JsonObject> {
  const parsed = parseLadecadanseEventPage(html, pageUrl, context);
  if (!parsed) throw new SyncError("event_parse_failed");
  const normalized = normalizeEventCandidate(parsed.candidate, context, pageUrl);
  if (!normalized.ok)
    throw new SyncError(`event_rejected_${normalized.reason}`, { terminal: true });

  const upserted = await rpc<unknown>(admin, "upsert_ingested_event_v2", {
    _data_source_id: source.id,
    _payload: eventPayload(normalized.event),
  });
  const outcome = (Array.isArray(upserted) ? upserted[0] : upserted) as UpsertOutcome | null;
  if (!outcome?.event_id) throw new SyncError("event_upsert_empty");

  if (parsed.venueExternalIdentifier) {
    await rpc<string | null>(admin, "link_event_to_venue_source_v1", {
      _event_id: outcome.event_id,
      _domain: LADECADANSE_HOST,
      _external_identifier: parsed.venueExternalIdentifier,
    });
  }

  const { error: sourceError } = await admin.from("event_sources").upsert(
    {
      event_id: outcome.event_id,
      source_url: normalized.event.sourceUrl,
      canonical_url: normalized.event.sourceUrl,
      domain: LADECADANSE_HOST,
      source_name: "La Décadanse",
      source_title: normalized.event.title,
      source_type: "partner_feed",
      is_primary: true,
      attribution: "La Décadanse",
      image_url: normalized.event.imageUrl,
      booking_url: normalized.event.ticketUrl,
      last_seen_at: new Date().toISOString(),
      last_verified_at: new Date().toISOString(),
    },
    { onConflict: "event_id,canonical_url" },
  );
  if (sourceError)
    throw new SyncError("event_source_upsert_failed", { message: sourceError.message });

  const discoveredLinks = [...parsed.discoveredLinks];
  if (parsed.venueSourceUrl && parsed.venueExternalIdentifier) {
    discoveredLinks.push({
      kind: "venue",
      url: parsed.venueSourceUrl,
      externalIdentifier: parsed.venueExternalIdentifier,
      priority: 10,
    });
  }
  const enqueued = await enqueue(admin, discoveredLinks);
  return {
    entity: "event",
    eventId: outcome.event_id,
    action: outcome.action ?? "updated",
    title: normalized.event.title,
    sourceUrl: normalized.event.sourceUrl,
    linksEnqueued: enqueued,
  };
}

async function persistVenue(
  admin: AdminClient,
  source: DataSource,
  html: string,
  pageUrl: string,
): Promise<JsonObject> {
  const parsed = parseLadecadanseVenuePage(html, pageUrl);
  if (!parsed) throw new SyncError("venue_parse_failed");
  if (!parsed.media.length) {
    parsed.media = await findLicensedCommonsVenueMedia(parsed.name, source.city?.name ?? "Genève");
    if (parsed.media.length) parsed.qualityScore = Math.min(100, parsed.qualityScore + 6);
  }

  const upserted = await rpc<unknown>(admin, "upsert_ingested_venue_v1", {
    _data_source_id: source.id,
    _payload: venuePayload(parsed),
  });
  const outcome = Array.isArray(upserted) ? upserted[0] : upserted;
  if (!record(outcome).venue_id) throw new SyncError("venue_upsert_empty");
  const enqueued = await enqueue(admin, parsed.eventLinks);
  return {
    entity: "venue",
    venueId: record(outcome).venue_id,
    placeId: record(outcome).place_id ?? null,
    action: record(outcome).action ?? "updated",
    name: parsed.name,
    mediaCount: parsed.media.length,
    eventsEnqueued: enqueued,
  };
}

async function processItem(
  admin: AdminClient,
  source: DataSource,
  context: EventSourceContext,
  robots: ReturnType<typeof parseRobotsTxt>,
  item: QueueItem,
): Promise<JsonObject> {
  const fetched = await fetchSourceHtml(item.source_url, robots);
  if (item.kind === "agenda" || item.kind === "venue_catalog") {
    const links = discoverLadecadanseLinks(fetched.html, fetched.url);
    const enqueued = await enqueue(admin, links);
    return {
      entity: item.kind,
      sourceUrl: fetched.url,
      discovered: links.length,
      enqueued,
      httpStatus: fetched.status,
    };
  }
  if (item.kind === "venue") {
    return await persistVenue(admin, source, fetched.html, fetched.url);
  }
  return await persistEvent(admin, source, context, fetched.html, fetched.url);
}

async function work(
  admin: AdminClient,
  batchSize: number,
  maxBatches: number,
): Promise<JsonObject> {
  const startedAt = Date.now();
  const workerId = crypto.randomUUID();
  const { source, context } = await sourceContext(admin);
  const robots = await robotsRules();
  const summaries: JsonObject[] = [];
  let claimed = 0;
  let completed = 0;
  let failed = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    if (Date.now() - startedAt > EXECUTION_BUDGET_MS - 12_000) break;
    const items = await rpc<QueueItem[]>(admin, "claim_ladecadanse_sync_items_v1", {
      _worker_id: workerId,
      _limit: batchSize,
      _lease_seconds: 180,
    });
    if (!items.length) break;
    claimed += items.length;

    for (const item of items) {
      if (Date.now() - startedAt > EXECUTION_BUDGET_MS - 8_000) {
        await rpc<boolean>(admin, "fail_ladecadanse_sync_item_v1", {
          _item_id: item.id,
          _worker_id: workerId,
          _error: "execution_budget_deferred",
          _retry_after_seconds: 60,
          _terminal: false,
        });
        continue;
      }
      try {
        const result = await processItem(admin, source, context, robots, item);
        const acknowledged = await rpc<boolean>(admin, "complete_ladecadanse_sync_item_v1", {
          _item_id: item.id,
          _worker_id: workerId,
          _metadata: result,
        });
        if (!acknowledged) throw new SyncError("queue_completion_lease_lost");
        completed += 1;
        summaries.push({ itemId: item.id, kind: item.kind, ok: true, ...result });
      } catch (error) {
        const failure =
          error instanceof SyncError
            ? error
            : new SyncError("unexpected_error", {
                message: error instanceof Error ? error.message : "unexpected_error",
              });
        await rpc<boolean>(admin, "fail_ladecadanse_sync_item_v1", {
          _item_id: item.id,
          _worker_id: workerId,
          _error: `${failure.code}:${failure.message}`,
          _retry_after_seconds: failure.retryAfterSeconds,
          _terminal: failure.terminal || item.attempt_count >= item.max_attempts,
        });
        failed += 1;
        summaries.push({
          itemId: item.id,
          kind: item.kind,
          sourceUrl: item.source_url,
          ok: false,
          error: failure.code,
        });
      }
    }
  }

  return {
    ok: true,
    action: "work",
    claimed,
    completed,
    failed,
    elapsedMs: Date.now() - startedAt,
    items: summaries,
    status: await rpc<unknown>(admin, "ladecadanse_sync_status_v1"),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);

  let admin: AdminClient;
  try {
    admin = createAdminClient();
  } catch (error) {
    return json(
      req,
      { error: error instanceof Error ? error.message : "server_not_configured" },
      500,
    );
  }
  if (!(await isAuthorized(req, admin))) return json(req, { error: "unauthorized" }, 401);

  try {
    const body = record(await req.json().catch(() => ({})));
    const action = typeof body.action === "string" ? body.action : "sync";
    if (action === "status") {
      return json(req, {
        ok: true,
        action,
        status: await rpc<unknown>(admin, "ladecadanse_sync_status_v1"),
      });
    }
    if (action === "plan") {
      return json(req, {
        ok: true,
        action,
        seeded: await seedCatalog(admin),
        status: await rpc<unknown>(admin, "ladecadanse_sync_status_v1"),
      });
    }
    if (!["work", "sync"].includes(action)) {
      return json(req, { error: "invalid_action" }, 400);
    }
    if (action === "sync") await seedCatalog(admin);
    const batchSize = integer(
      body.batch_size ?? body.batchSize,
      DEFAULT_BATCH_SIZE,
      1,
      MAX_BATCH_SIZE,
    );
    const maxBatches = integer(
      body.max_batches ?? body.maxBatches,
      DEFAULT_MAX_BATCHES,
      1,
      MAX_BATCHES,
    );
    return json(req, await work(admin, batchSize, maxBatches));
  } catch (error) {
    const failure =
      error instanceof SyncError
        ? error
        : new SyncError("unexpected_error", {
            message: error instanceof Error ? error.message : "unexpected_error",
          });
    return json(
      req,
      { ok: false, error: failure.code, message: failure.message },
      failure.terminal ? 400 : 500,
    );
  }
});
