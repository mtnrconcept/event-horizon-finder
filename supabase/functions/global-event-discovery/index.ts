// Global, queue-backed event discovery without a paid search or extraction API.
//
// Security model:
// - pg_cron sends x-global-scraper-secret, checked in constant time;
// - interactive calls must carry a verified Supabase user JWT whose role is
//   admin or moderator;
// - the service-role key never leaves this function.
//
// Discovery is intentionally limited to a configured SearXNG JSON endpoint.
// Result pages are fetched through a DNS-pinning proxy, only after a fresh
// origin-scoped robots.txt decision.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.2";
import { scrapeDirectEventSource } from "../_shared/direct-event-scraper.ts";
import {
  deduplicateNormalizedEvents,
  normalizeEventCandidate,
  type EventSourceContext,
  type NormalizedEvent,
} from "../_shared/event-precision.ts";
import {
  buildMultilingualDiscoveryQueries,
  canonicalizeHttpUrl,
  normalizeSearxngResults,
  searchResultDomain,
  type NormalizedSearchResult,
} from "../_shared/global-discovery.ts";
import {
  createRobotsCacheMetadata,
  evaluateRobotsPolicy,
  parseRobotsTxt,
  robotsUrlFor,
  type ParsedRobotsTxt,
} from "../_shared/robots-policy.ts";

const SEARCH_PROVIDER = "searxng";
const SEARCH_RESULT_LIMIT = 10;
const NIGHTLIFE_WINDOW_DAYS = 7;
const DEFAULT_PLAN_CITY_LIMIT = 25;
const MAX_PLAN_CITY_LIMIT = 75;
const DEFAULT_SEARCH_BATCH = 3;
const MAX_SEARCH_BATCH = 5;
const DEFAULT_CRAWL_BATCH = 2;
const MAX_CRAWL_BATCH = 3;
const DEFAULT_PERSISTENCE_BATCH = 10;
const MAX_PERSISTENCE_BATCH = 25;
const SEARCH_TIMEOUT_MS = 10_000;
const ROBOTS_TIMEOUT_MS = 7_000;
const PAGE_TIMEOUT_MS = 8_000;
const MAX_SEARCH_RESPONSE_BYTES = 1_500_000;
const MAX_ROBOTS_RESPONSE_BYTES = 512_000;
const MAX_REQUEST_BODY_BYTES = 32_000;
const SEARCH_LEASE_SECONDS = 120;
const CRAWL_LEASE_SECONDS = 600;
const PERSISTENCE_LEASE_SECONDS = 300;
const MAX_PERSISTENCE_ENQUEUE_ITEMS = 50;
const MAX_PERSISTENCE_ENQUEUE_BYTES = 1_450_000;
const MAX_PERSISTENCE_EVENT_BYTES = 250_000;
const MAX_REDIRECTS = 4;
const MAX_INLINE_CRAWL_DELAY_MS = 5_000;
const CRAWLER_USER_AGENT =
  "GlobalParty-Event-Discovery/1.0 (+https://github.com/mtnrconcept/event-horizon-finder)";
const ROBOTS_USER_AGENT = "GlobalParty-Event-Discovery";

type JsonObject = Record<string, unknown>;
type AdminClient = SupabaseClient;

type CityTarget = {
  city_id: string;
  city_name: string;
  country_code: string | null;
  country_name: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  population: number | null;
  country_population_rank: number | null;
  search_names: string[] | null;
  search_languages: string[] | null;
  query_profile: JsonObject | null;
};

type SearchJob = {
  job_id: string;
  campaign_id: string;
  city_id: string;
  query_kind: string;
  query_text: string;
  query_locale: string | null;
  provider: string;
  cache_key: string;
  attempt_count: number;
  max_attempts: number;
  cached_results: unknown;
};

type CrawlJob = {
  job_id: string;
  campaign_id: string;
  search_job_id: string;
  city_id: string;
  url: string;
  canonical_url: string;
  domain: string;
  attempt_count: number;
  max_attempts: number;
  robots_status: "unknown" | "allowed" | "disallowed" | "unavailable" | "error";
  robots_rules: unknown;
  robots_expires_at: string | null;
  crawl_delay_ms: number | null;
  city_name: string;
  country_code: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  data_source_id?: string | null;
  search_rank?: number | null;
  crawl_kind?: "search_result" | "event" | "pagination";
  crawl_depth?: number;
  parent_job_id?: string | null;
};

type UpsertOutcome = {
  event_id?: string;
  action?: string;
  score?: number;
  published?: boolean;
};

type PersistenceJob = {
  persistence_job_id: string;
  crawl_job_id: string;
  data_source_id: string;
  event_key: string;
  event: unknown;
  attempt_count: number;
  max_attempts: number;
  domain: string;
  search_rank: number | null;
};

type QueuedEventSource = {
  source_url: string;
  title: string;
  fingerprint: string;
  external_id: string | null;
  starts_at: string;
  venue_name: string | null;
  image_url: string | null;
  ticket_url: string | null;
};

type QueuedPersistenceEvent = {
  payload: JsonObject;
  source: QueuedEventSource;
};

class WorkerError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryAfterSeconds: number;
  readonly terminal: boolean;
  readonly redirectSourceUrl: string | null;
  readonly redirectTargetUrl: string | null;

  constructor(
    code: string,
    options: {
      httpStatus?: number;
      retryAfterSeconds?: number;
      terminal?: boolean;
      message?: string;
      redirectSourceUrl?: string;
      redirectTargetUrl?: string;
    } = {},
  ) {
    super(options.message ?? code);
    this.name = "WorkerError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 500;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 300;
    this.terminal = options.terminal ?? false;
    this.redirectSourceUrl = options.redirectSourceUrl ?? null;
    this.redirectTargetUrl = options.redirectTargetUrl ?? null;
  }
}

function json(req: Request, body: unknown, status = 200): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  });
  const origin = allowedOrigin(req);
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(JSON.stringify(body), { status, headers });
}

function allowedOrigin(req: Request): string | null {
  const requestOrigin = req.headers.get("Origin");
  const configured = (Deno.env.get("APP_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!requestOrigin) return configured.includes("*") ? "*" : null;
  return configured.includes("*") || configured.includes(requestOrigin) ? requestOrigin : null;
}

function optionsResponse(req: Request): Response {
  const headers = new Headers({
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info, x-global-scraper-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });
  const origin = allowedOrigin(req);
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(null, { status: 204, headers });
}

function createAdminClient(): AdminClient {
  const url = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ??
    Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (!url || !serviceKey) throw new WorkerError("server_not_configured", { httpStatus: 500 });
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
  const configuredSecret = Deno.env.get("GLOBAL_SCRAPER_SECRET")?.trim() ?? "";
  const providedSecret = req.headers.get("x-global-scraper-secret")?.trim() ?? "";
  if (
    configuredSecret.length >= 32 &&
    providedSecret.length >= 32 &&
    timingSafeEqual(configuredSecret, providedSecret)
  ) {
    return true;
  }

  const authorization = req.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match) return false;

  const { data: userData, error: userError } = await admin.auth.getUser(match[1]);
  if (userError || !userData.user) return false;

  const { data: roles, error: roleError } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id)
    .in("role", ["admin", "moderator"])
    .limit(1);
  return !roleError && Boolean(roles?.length);
}

async function readJsonBody(req: Request): Promise<JsonObject> {
  const declaredLength = Number.parseInt(req.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new WorkerError("request_body_too_large", { httpStatus: 413, terminal: true });
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new WorkerError("request_body_too_large", { httpStatus: 413, terminal: true });
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("object_required");
    return parsed;
  } catch {
    throw new WorkerError("invalid_json", { httpStatus: 400, terminal: true });
  }
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRows<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return value == null ? [] : [value as T];
}

function validUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "unknown_error";
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/([?&](?:key|token|secret|apikey|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

async function rpc<T>(admin: AdminClient, name: string, args: JsonObject): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) {
    throw new WorkerError(`rpc_${name}_failed`, {
      message: `${error.code ?? "database_error"}: ${safeMessage(error)}`,
      retryAfterSeconds: 300,
    });
  }
  return data as T;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function discoveryDate(value: unknown): Date {
  if (typeof value !== "string" || !value.trim()) return new Date();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00.000Z`)
    : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new WorkerError("invalid_discovery_date", { httpStatus: 400, terminal: true });
  }
  const oldest = Date.now() - 24 * 60 * 60 * 1_000;
  const newest = Date.now() + 366 * 24 * 60 * 60 * 1_000;
  if (date.getTime() < oldest || date.getTime() > newest) {
    throw new WorkerError("discovery_date_out_of_range", { httpStatus: 400, terminal: true });
  }
  return date;
}

function campaignPeriod(date: Date): {
  key: string;
  start: string;
  end: string;
} {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  return {
    key: `${SEARCH_PROVIDER}:${monthKey}`,
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function firstSearchName(target: CityTarget): string {
  const names = Array.isArray(target.search_names) ? target.search_names : [];
  return (
    names.find((value) => typeof value === "string" && value.trim())?.trim() ?? target.city_name
  );
}

function searchLocales(target: CityTarget): string[] {
  const profileLocale = isRecord(target.query_profile)
    ? typeof target.query_profile.locale === "string"
      ? target.query_profile.locale
      : typeof target.query_profile.preferred_locale === "string"
        ? target.query_profile.preferred_locale
        : null
    : null;
  const languages = Array.isArray(target.search_languages) ? target.search_languages : [];
  const locales = [profileLocale, ...languages]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim());
  return [...new Set(locales.length ? locales : ["en"])].slice(0, 4);
}

function requestedCountryCodes(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const codes = [
    ...new Set(values.map((item) => String(item).trim().toUpperCase()).filter(Boolean)),
  ];
  if (codes.length > 20 || codes.some((code) => !/^[A-Z]{2}$/.test(code))) {
    throw new WorkerError("invalid_country_codes", { httpStatus: 400, terminal: true });
  }
  return codes;
}

async function handlePlan(admin: AdminClient, body: JsonObject): Promise<JsonObject> {
  const date = discoveryDate(body.date ?? body.target_date);
  const countryCodes = requestedCountryCodes(body.countryCodes ?? body.country_codes);
  const maintenance = await rpc<unknown>(admin, "prune_global_discovery_history", {
    _retention_days: 45,
    _batch_limit: 2_000,
  });
  const period = campaignPeriod(date);
  const cityLimit = boundedInteger(
    body.cityLimit ?? body.batch_size,
    DEFAULT_PLAN_CITY_LIMIT,
    1,
    MAX_PLAN_CITY_LIMIT,
  );
  const campaignScope = countryCodes.length ? `:${countryCodes.join("-")}` : "";
  const campaignKey = `${period.key}${campaignScope}`;
  const campaignId = await rpc<string>(admin, "ensure_global_scrape_campaign", {
    _campaign_key: campaignKey,
    _period_start: period.start,
    _period_end: period.end,
    _provider: SEARCH_PROVIDER,
    _metadata: {
      query_date: date.toISOString().slice(0, 10),
      planner_version: 2,
      nightlife_window_days: NIGHTLIFE_WINDOW_DAYS,
      search_result_limit: SEARCH_RESULT_LIMIT,
      country_codes: countryCodes,
    },
  });
  if (!validUuid(campaignId)) throw new WorkerError("invalid_campaign_response");

  const maximumSearchBacklog = boundedInteger(
    Deno.env.get("GLOBAL_MAX_QUEUED_SEARCH_JOBS"),
    2_000,
    100,
    100_000,
  );
  const maximumCrawlBacklog = boundedInteger(
    Deno.env.get("GLOBAL_MAX_QUEUED_CRAWL_JOBS"),
    5_000,
    100,
    250_000,
  );
  const globalBacklog = asRows<JsonObject>(
    await rpc<unknown>(admin, "global_discovery_backlog", {}),
  )[0];
  const searchBacklog = Math.max(0, Number(globalBacklog?.search_backlog ?? 0));
  const crawlBacklog = Math.max(0, Number(globalBacklog?.crawl_backlog ?? 0));
  if (searchBacklog >= maximumSearchBacklog || crawlBacklog >= maximumCrawlBacklog) {
    return {
      ok: true,
      action: "plan",
      campaignId,
      campaign_id: campaignId,
      campaignKey,
      countryCodes,
      targetCount: 0,
      generatedJobCount: 0,
      enqueuedJobCount: 0,
      hasMoreDueTargets: false,
      has_more: false,
      backpressure: true,
      searchBacklog,
      crawlBacklog,
      maximumSearchBacklog,
      maximumCrawlBacklog,
      maintenance,
    };
  }

  const due = asRows<CityTarget>(
    await rpc<unknown>(admin, "list_due_global_city_targets_v2", {
      _limit: cityLimit,
      _as_of: new Date().toISOString(),
      _country_codes: countryCodes,
    }),
  );

  const jobs: JsonObject[] = [];
  for (const target of due) {
    if (!validUuid(target.city_id) || !target.city_name?.trim()) continue;
    const queries = buildMultilingualDiscoveryQueries({
      cityName: firstSearchName(target),
      countryName: target.country_name,
      date,
      locales: searchLocales(target),
      primaryNightlifeDays: NIGHTLIFE_WINDOW_DAYS,
      maxQueries: 16,
    });
    for (const query of queries) {
      const cacheKey = await sha256(
        `${SEARCH_PROVIDER}|${query.locale}|${query.query.toLocaleLowerCase(query.locale)}`,
      );
      jobs.push({
        city_id: target.city_id,
        query_kind: query.family,
        query_text: query.query,
        query_locale: query.locale,
        provider: SEARCH_PROVIDER,
        cache_key: cacheKey,
        priority: Math.max(1, 100 - (target.country_population_rank ?? 50)),
        available_at: new Date().toISOString(),
      });
    }
  }

  const enqueued = jobs.length
    ? await rpc<number>(admin, "enqueue_global_search_jobs", {
        _campaign_id: campaignId,
        _jobs: jobs,
      })
    : 0;
  return {
    ok: true,
    action: "plan",
    campaignId,
    campaign_id: campaignId,
    campaignKey,
    countryCodes,
    targetCount: due.length,
    generatedJobCount: jobs.length,
    enqueuedJobCount: Number(enqueued ?? 0),
    hasMoreDueTargets: due.length >= cityLimit,
    has_more: due.length >= cityLimit,
    maintenance,
  };
}

function searxngSearchUrl(baseValue: string, job: SearchJob): string {
  const canonicalBase = canonicalizeHttpUrl(baseValue);
  if (!canonicalBase) throw new WorkerError("searxng_url_invalid", { httpStatus: 500 });
  const base = new URL(canonicalBase);
  if (!/\/search\/?$/i.test(base.pathname)) {
    base.pathname = `${base.pathname.replace(/\/$/, "")}/search`;
  }
  base.search = "";
  base.hash = "";
  base.searchParams.set("q", job.query_text);
  base.searchParams.set("format", "json");
  base.searchParams.set("categories", "general");
  base.searchParams.set("language", job.query_locale || "all");
  base.searchParams.set("safesearch", "1");
  return base.toString();
}

function cachedSearchResults(value: unknown): JsonObject[] | null {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.results)) return value.results.filter(isRecord);
  return null;
}

function persistedSearchResults(results: NormalizedSearchResult[]): JsonObject[] {
  const fetchedAt = new Date().toISOString();
  return results.map((result) => ({
    rank: result.rank,
    url: result.url,
    canonical_url: result.url,
    // Keep the exact crawl hostname for origin-scoped robots state. The
    // normalized site domain remains metadata used only for top-10 diversity.
    domain: new URL(result.url).hostname.toLowerCase().replace(/\.$/, ""),
    title: result.title,
    snippet: result.snippet,
    metadata: {
      source_rank: result.sourceRank,
      site_domain: result.domain,
      engines: result.engines,
      score: result.score,
      published_at: result.publishedAt,
      thumbnail_url: result.thumbnailUrl,
      fetched_at: fetchedAt,
    },
  }));
}

async function limitedResponseText(response: Response, maximumBytes: number): Promise<string> {
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
        throw new WorkerError("response_too_large", {
          httpStatus: 502,
          retryAfterSeconds: 900,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function retryAfterSeconds(response: Response, fallback: number): number {
  const value = response.headers.get("retry-after");
  if (!value) return fallback;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return Math.min(86_400, Math.max(1, seconds));
  const date = new Date(value).getTime();
  if (!Number.isFinite(date)) return fallback;
  return Math.min(86_400, Math.max(1, Math.ceil((date - Date.now()) / 1_000)));
}

async function fetchSearxng(job: SearchJob, baseUrl: string): Promise<NormalizedSearchResult[]> {
  const url = searxngSearchUrl(baseUrl, job);
  if (!searchResultDomain(url)) {
    throw new WorkerError("searxng_url_invalid", { httpStatus: 500 });
  }
  const expectedHostname = new URL(url).hostname;
  const authToken = Deno.env.get("SEARXNG_AUTH_TOKEN")?.trim();
  if (authToken && new URL(url).protocol !== "https:") {
    throw new WorkerError("searxng_auth_requires_https", { httpStatus: 500, terminal: true });
  }
  const headers = new Headers({
    Accept: "application/json",
    "Accept-Language": job.query_locale || "en",
    "User-Agent": CRAWLER_USER_AGENT,
  });
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  const response = await secureFetch(
    url,
    { headers },
    expectedHostname,
    SEARCH_TIMEOUT_MS,
    MAX_REDIRECTS,
    false,
  );
  if (!response.ok) {
    const terminal =
      response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status);
    throw new WorkerError(`searxng_http_${response.status}`, {
      httpStatus: response.status,
      retryAfterSeconds: retryAfterSeconds(response, response.status === 429 ? 900 : 300),
      terminal,
    });
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType && !contentType.includes("json")) {
    throw new WorkerError("searxng_non_json_response", {
      httpStatus: 502,
      retryAfterSeconds: 900,
    });
  }
  const text = await limitedResponseText(response, MAX_SEARCH_RESPONSE_BYTES);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new WorkerError("searxng_invalid_json", {
      httpStatus: 502,
      retryAfterSeconds: 900,
    });
  }
  return normalizeSearxngResults(payload, { limit: SEARCH_RESULT_LIMIT });
}

async function failSearchJob(
  admin: AdminClient,
  workerId: string,
  job: SearchJob,
  error: unknown,
): Promise<void> {
  const failure =
    error instanceof WorkerError
      ? error
      : new WorkerError("search_unexpected_error", { message: safeMessage(error) });
  await rpc<boolean>(admin, "fail_global_search_job", {
    _job_id: job.job_id,
    _worker_id: workerId,
    _error_code: failure.code,
    _error_message: safeMessage(failure),
    _http_status: failure.httpStatus || null,
    _retry_after_seconds: failure.retryAfterSeconds,
    _terminal: failure.terminal || job.attempt_count >= job.max_attempts,
  });
}

async function handleSearch(admin: AdminClient, body: JsonObject): Promise<JsonObject> {
  const searxngBaseUrl = Deno.env.get("SEARXNG_BASE_URL")?.trim();
  if (!searxngBaseUrl || !canonicalizeHttpUrl(searxngBaseUrl)) {
    throw new WorkerError("searxng_not_configured", { httpStatus: 503 });
  }
  const searxngToken = Deno.env.get("SEARXNG_AUTH_TOKEN")?.trim() ?? "";
  if (searxngToken.length < 32) {
    throw new WorkerError("searxng_auth_not_configured", { httpStatus: 503 });
  }
  const limit = boundedInteger(
    body.limit ?? body.batch_size,
    DEFAULT_SEARCH_BATCH,
    1,
    MAX_SEARCH_BATCH,
  );
  const workerId = crypto.randomUUID();
  const maximumCrawlBacklog = boundedInteger(
    Deno.env.get("GLOBAL_MAX_QUEUED_CRAWL_JOBS"),
    5_000,
    100,
    250_000,
  );
  const jobs = asRows<SearchJob>(
    await rpc<unknown>(admin, "claim_global_search_jobs", {
      _worker_id: workerId,
      _limit: limit,
      _lease_seconds: SEARCH_LEASE_SECONDS,
      _max_crawl_backlog: maximumCrawlBacklog,
    }),
  );
  const summaries: JsonObject[] = [];
  const cacheTtlSeconds = boundedInteger(
    Deno.env.get("GLOBAL_SEARCH_CACHE_TTL_SECONDS"),
    86_400,
    3_600,
    7 * 86_400,
  );

  for (const job of jobs) {
    try {
      if (job.provider !== SEARCH_PROVIDER) {
        throw new WorkerError("unsupported_search_provider", {
          httpStatus: 400,
          terminal: true,
        });
      }
      const cached = cachedSearchResults(job.cached_results);
      let results: JsonObject[];
      let cacheHit = false;
      if (cached) {
        results = cached.slice(0, SEARCH_RESULT_LIMIT);
        cacheHit = true;
      } else {
        results = persistedSearchResults(await fetchSearxng(job, searxngBaseUrl));
      }
      const crawlJobs = await rpc<number>(admin, "complete_global_search_job", {
        _job_id: job.job_id,
        _worker_id: workerId,
        _results: results,
        _cache_ttl_seconds: cacheTtlSeconds,
        _cache_hit: cacheHit,
      });
      summaries.push({
        jobId: job.job_id,
        ok: true,
        cacheHit,
        resultCount: results.length,
        crawlJobCount: Number(crawlJobs ?? 0),
      });
    } catch (error) {
      try {
        await failSearchJob(admin, workerId, job, error);
      } catch {
        // The lease will expire and make the job claimable again.
      }
      summaries.push({
        jobId: job.job_id,
        ok: false,
        error: error instanceof WorkerError ? error.code : "search_unexpected_error",
      });
    }
  }
  // Per-URL search failures (e.g. searxng_http_429, search_unexpected_error) are expected
  // operational outcomes. Infrastructure failures throw WorkerError and are caught by the
  // outer handler, returning an HTTP error response instead of reaching this return statement.
  return {
    ok: true,
    action: "search",
    claimed: jobs.length,
    completed: summaries.filter((summary) => summary.ok === true).length,
    failed: summaries.filter((summary) => summary.ok === false).length,
    jobs: summaries,
  };
}

function cachedRobotsRules(value: unknown): ParsedRobotsTxt | null {
  const candidate = isRecord(value) && isRecord(value.parsed) ? value.parsed : value;
  if (
    !isRecord(candidate) ||
    !Array.isArray(candidate.groups) ||
    !Array.isArray(candidate.sitemaps)
  ) {
    return null;
  }
  return candidate as unknown as ParsedRobotsTxt;
}

function robotsCacheFresh(job: CrawlJob): boolean {
  if (!job.robots_expires_at) return false;
  const expiry = Date.parse(job.robots_expires_at);
  return Number.isFinite(expiry) && expiry > Date.now();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function updateRobotsState(
  admin: AdminClient,
  workerId: string,
  job: CrawlJob,
  status: CrawlJob["robots_status"],
  rules: JsonObject,
  crawlDelayMs: number,
  expiresAt: string,
): Promise<void> {
  const updated = await rpc<boolean>(admin, "update_global_domain_robots", {
    _domain: job.domain,
    _worker_id: workerId,
    _job_id: job.job_id,
    _robots_status: status,
    _robots_rules: rules,
    _crawl_delay_ms: Math.max(0, Math.min(86_400_000, Math.trunc(crawlDelayMs))),
    _expires_at: expiresAt,
  });
  if (!updated) throw new WorkerError("robots_state_lease_lost", { retryAfterSeconds: 120 });
}

async function freshRobotsDecision(
  admin: AdminClient,
  workerId: string,
  job: CrawlJob,
): Promise<{
  rules: ParsedRobotsTxt;
  crawlDelayMs: number;
  requiresInitialDelay: boolean;
}> {
  if (robotsCacheFresh(job)) {
    if (job.robots_status === "disallowed") {
      throw new WorkerError("robots_disallowed", {
        httpStatus: 403,
        terminal: true,
      });
    }
    if (job.robots_status === "unavailable" || job.robots_status === "error") {
      throw new WorkerError(`robots_${job.robots_status}`, {
        httpStatus: 503,
        retryAfterSeconds: Math.max(
          60,
          Math.ceil((Date.parse(job.robots_expires_at!) - Date.now()) / 1_000),
        ),
      });
    }
    const cached = cachedRobotsRules(job.robots_rules);
    if (job.robots_status === "allowed" && cached) {
      const decision = evaluateRobotsPolicy(cached, job.canonical_url, ROBOTS_USER_AGENT);
      if (!decision.allowed) {
        throw new WorkerError("robots_disallowed", {
          httpStatus: 403,
          terminal: true,
        });
      }
      return {
        rules: cached,
        crawlDelayMs: Math.max(
          job.crawl_delay_ms ?? 0,
          Math.ceil((decision.crawlDelaySeconds ?? 0) * 1_000),
        ),
        requiresInitialDelay: false,
      };
    }
  }

  const robotsUrl = robotsUrlFor(job.canonical_url);
  if (!robotsUrl) {
    throw new WorkerError("robots_url_invalid", { terminal: true, httpStatus: 400 });
  }
  let response: Response;
  try {
    response = await secureFetch(
      robotsUrl,
      {
        headers: {
          Accept: "text/plain,*/*;q=0.1",
          "User-Agent": CRAWLER_USER_AGENT,
        },
      },
      new URL(robotsUrl).hostname,
      ROBOTS_TIMEOUT_MS,
      2,
      false,
      {},
      true,
    );
  } catch (error) {
    // A related-host redirect is not a robots failure. It is handed off to a
    // new exact-origin crawl job so the target obtains its own robots policy.
    if (error instanceof WorkerError && error.redirectSourceUrl && error.redirectTargetUrl) {
      const pageUrl = new URL(job.canonical_url);
      const targetPage = new URL(error.redirectTargetUrl);
      targetPage.pathname = pageUrl.pathname;
      targetPage.search = pageUrl.search;
      targetPage.hash = pageUrl.hash;
      throw new WorkerError("robots_redirect_host_handoff", {
        httpStatus: error.httpStatus,
        terminal: true,
        redirectSourceUrl: job.canonical_url,
        redirectTargetUrl: targetPage.toString(),
        message: safeMessage(error),
      });
    }
    const metadata = createRobotsCacheMetadata({
      pageUrl: job.canonical_url,
      httpStatus: 0,
    });
    if (metadata) {
      await updateRobotsState(admin, workerId, job, "error", {}, 0, metadata.expiresAt);
    }
    if (error instanceof WorkerError && error.terminal) throw error;
    throw new WorkerError("robots_fetch_failed", {
      httpStatus: 503,
      retryAfterSeconds: 900,
      message: safeMessage(error),
    });
  }

  const metadata = createRobotsCacheMetadata({
    pageUrl: job.canonical_url,
    httpStatus: response.status,
    cacheControl: response.headers.get("cache-control"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  });
  if (!metadata) throw new WorkerError("robots_cache_metadata_invalid");

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    await updateRobotsState(admin, workerId, job, "disallowed", {}, 0, metadata.expiresAt);
    throw new WorkerError("robots_disallowed", {
      httpStatus: response.status,
      terminal: true,
    });
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel();
    await updateRobotsState(admin, workerId, job, "unavailable", {}, 0, metadata.expiresAt);
    throw new WorkerError("robots_unavailable", {
      httpStatus: response.status,
      retryAfterSeconds: retryAfterSeconds(response, 900),
    });
  }

  let parsed: ParsedRobotsTxt;
  if (response.ok) {
    const text = await limitedResponseText(response, MAX_ROBOTS_RESPONSE_BYTES);
    parsed = parseRobotsTxt(text);
  } else if (response.status >= 400 && response.status < 500) {
    await response.body?.cancel();
    // RFC 9309 treats most 4xx responses as an unavailable robots file. 404
    // and 410 are the common explicit absence cases; other non-auth 4xx are
    // also allowed here but cached for a bounded period.
    parsed = { groups: [], sitemaps: [] };
  } else {
    await response.body?.cancel();
    await updateRobotsState(admin, workerId, job, "error", {}, 0, metadata.expiresAt);
    throw new WorkerError("robots_invalid_response", {
      httpStatus: response.status,
      retryAfterSeconds: 900,
    });
  }

  const decision = evaluateRobotsPolicy(parsed, job.canonical_url, ROBOTS_USER_AGENT);
  const crawlDelayMs = Math.ceil((decision.crawlDelaySeconds ?? 0) * 1_000);
  const rules = {
    groups: parsed.groups,
    sitemaps: parsed.sitemaps,
    metadata,
  };
  await updateRobotsState(admin, workerId, job, "allowed", rules, crawlDelayMs, metadata.expiresAt);
  if (!decision.allowed) {
    throw new WorkerError("robots_disallowed", {
      httpStatus: 403,
      terminal: true,
    });
  }
  return { rules: parsed, crawlDelayMs, requiresInitialDelay: true };
}

async function ensureDiscoverySource(admin: AdminClient, job: CrawlJob): Promise<string> {
  const sourceId = await rpc<string>(admin, "ensure_global_discovery_source", {
    _city_id: job.city_id,
    _domain: job.domain,
    _base_url: job.canonical_url,
    _source_name: `${job.domain} — découverte web`,
  });
  if (!validUuid(sourceId)) throw new WorkerError("invalid_data_source_response");
  return sourceId;
}

function sourceContext(job: CrawlJob, sourceId: string): EventSourceContext {
  return {
    id: sourceId,
    name: `${job.domain} — ${job.city_name}`,
    domain: job.domain,
    category_slug: null,
    metadata: {
      discovery: true,
      direct_page_fetch_budget: 10,
      // Each job owns one exact hostname and its matching robots.txt state.
      // Links or redirects to www/apex/subdomains must be planned as a new
      // origin job instead of borrowing this host's robots decision.
      direct_exact_host: true,
      max_distance_km: 250,
    },
    city: {
      name: job.city_name,
      timezone: job.timezone || "UTC",
      latitude: job.latitude,
      longitude: job.longitude,
      country: job.country_code ? { code: job.country_code } : null,
    },
  };
}

type SerializedRobotsFetcher = {
  fetcher: typeof fetch;
  getTerminalError: () => WorkerError | null;
  getRedirectHandoffs: () => WorkerError[];
};

async function responseWithQueueRelease(
  response: Response,
  release: () => void,
): Promise<Response> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  const bodyWillNotBeRead =
    !response.body ||
    !response.ok ||
    contentLength === 0 ||
    (contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml") &&
      !contentType.includes("text/plain"));
  if (bodyWillNotBeRead) {
    try {
      await response.body?.cancel("body_not_consumed");
    } catch {
      // The response may already be closed. The caller only needs headers.
    }
    release();
    return response;
  }

  const reader = response.body!.getReader();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          releaseOnce();
          controller.close();
        } else if (chunk.value) {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        releaseOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        releaseOnce();
      }
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // A reconstructed Response has an empty URL. The deterministic scraper uses
  // it to resolve same-domain detail links, so preserve the final redirect URL.
  Object.defineProperty(wrapped, "url", { value: response.url });
  Object.defineProperty(wrapped, "redirected", { value: response.redirected });
  return wrapped;
}

function createSerializedRobotsFetcher(
  job: CrawlJob,
  robots: ParsedRobotsTxt,
  configuredDelayMs: number,
): SerializedRobotsFetcher {
  const expectedHostname = new URL(job.canonical_url).hostname;
  let queue: Promise<void> = Promise.resolve();
  let lastFetchAt = 0;
  let terminalError: WorkerError | null = null;
  const redirectHandoffs = new Map<string, WorkerError>();

  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const previous = queue;
    let releaseQueue!: () => void;
    queue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    return (async () => {
      await previous;
      if (terminalError) {
        releaseQueue();
        throw terminalError;
      }
      try {
        const response = await secureFetch(
          input,
          init,
          expectedHostname,
          PAGE_TIMEOUT_MS,
          MAX_REDIRECTS,
          false,
          {
            beforeRequest: async (url) => {
              if (terminalError) throw terminalError;
              const decision = evaluateRobotsPolicy(robots, url.toString(), ROBOTS_USER_AGENT);
              if (!decision.allowed) {
                terminalError = new WorkerError("robots_disallowed", {
                  httpStatus: 403,
                  terminal: true,
                  message: `robots_disallowed:${url.pathname.slice(0, 200)}`,
                });
                throw terminalError;
              }
              const delayMs = Math.max(
                configuredDelayMs,
                Math.ceil((decision.crawlDelaySeconds ?? 0) * 1_000),
              );
              const remainingDelay = Math.max(0, delayMs - (Date.now() - lastFetchAt));
              if (remainingDelay > 0) await sleep(remainingDelay);
              lastFetchAt = Date.now();
            },
          },
          true,
        );
        return await responseWithQueueRelease(response, releaseQueue);
      } catch (error) {
        if (error instanceof WorkerError && error.redirectSourceUrl && error.redirectTargetUrl) {
          redirectHandoffs.set(`${error.redirectSourceUrl}\n${error.redirectTargetUrl}`, error);
        }
        releaseQueue();
        throw error;
      }
    })();
  }) as typeof fetch;

  return {
    fetcher,
    getTerminalError: () => terminalError,
    getRedirectHandoffs: () => [...redirectHandoffs.values()],
  };
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

function persistenceEventEnvelope(event: NormalizedEvent, job: CrawlJob): QueuedPersistenceEvent {
  const eventSourceUrl = canonicalizeHttpUrl(event.sourceUrl);
  const parentUrl = canonicalizeHttpUrl(job.canonical_url || job.url);
  const sourceUrl =
    eventSourceUrl &&
    new URL(eventSourceUrl).hostname.toLowerCase().replace(/\.$/, "") ===
      job.domain.toLowerCase().replace(/\.$/, "")
      ? eventSourceUrl
      : parentUrl;
  if (!sourceUrl) {
    throw new WorkerError("persistence_source_url_invalid", {
      httpStatus: 400,
      terminal: true,
    });
  }
  const payload = eventPayload(event);
  // Queue provenance is exact-host. JSON-LD occasionally advertises an
  // external canonical URL; retain the fetched page as the durable source so
  // one off-host item cannot invalidate an otherwise healthy batch.
  payload.source_url = sourceUrl;
  return {
    payload,
    source: {
      source_url: sourceUrl,
      title: event.title,
      fingerprint: event.fingerprint,
      external_id: event.externalId,
      starts_at: event.startDate,
      venue_name: event.venueName,
      image_url: event.imageUrl,
      ticket_url: event.ticketUrl,
    },
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseQueuedPersistenceEvent(value: unknown): QueuedPersistenceEvent {
  if (!isRecord(value) || !isRecord(value.payload) || !isRecord(value.source)) {
    throw new WorkerError("persistence_event_invalid", {
      httpStatus: 400,
      terminal: true,
    });
  }
  const sourceUrl = canonicalizeHttpUrl(value.source.source_url);
  const title = nullableString(value.source.title);
  const fingerprint = nullableString(value.source.fingerprint);
  const startsAt = nullableString(value.source.starts_at);
  if (!sourceUrl || !title || !fingerprint || !startsAt) {
    throw new WorkerError("persistence_event_invalid", {
      httpStatus: 400,
      terminal: true,
    });
  }
  return {
    payload: value.payload,
    source: {
      source_url: sourceUrl,
      title,
      fingerprint,
      external_id: nullableString(value.source.external_id),
      starts_at: startsAt,
      venue_name: nullableString(value.source.venue_name),
      image_url: nullableString(value.source.image_url),
      ticket_url: nullableString(value.source.ticket_url),
    },
  };
}

async function registerEventSource(
  admin: AdminClient,
  job: Pick<PersistenceJob, "domain" | "search_rank">,
  event: QueuedPersistenceEvent,
  outcome: UpsertOutcome,
): Promise<void> {
  if (!validUuid(outcome.event_id)) throw new WorkerError("upsert_missing_event_id");
  const identities: JsonObject[] = [
    {
      type: "event_fingerprint",
      value: event.source.fingerprint,
      normalized_value: event.source.fingerprint,
      source_domain: job.domain,
      confidence: 0.9,
      metadata: {
        starts_at: event.source.starts_at,
        venue_name: event.source.venue_name,
      },
    },
  ];
  if (event.source.external_id) {
    identities.push({
      type: "external_id",
      value: event.source.external_id,
      normalized_value: event.source.external_id.toLocaleLowerCase(),
      source_domain: job.domain,
      confidence: 1,
    });
  }
  await rpc<string>(admin, "register_global_event_source", {
    _event_id: outcome.event_id,
    _source_url: event.source.source_url,
    _canonical_url: event.source.source_url,
    _domain: job.domain,
    _source_name: job.domain,
    _source_title: event.source.title,
    _source_type: "discovery",
    _search_rank:
      typeof job.search_rank === "number" && job.search_rank >= 1 && job.search_rank <= 10
        ? Math.trunc(job.search_rank)
        : null,
    _is_primary: outcome.action === "created",
    _attribution: `Source publique : ${job.domain}`,
    _image_url: event.source.image_url,
    _booking_url: event.source.ticket_url,
    _identities: identities,
  });
}

type PersistenceQueueItem = {
  event_key: string;
  event: QueuedPersistenceEvent;
};

function persistenceQueueBatches(items: PersistenceQueueItem[]): PersistenceQueueItem[][] {
  const encoder = new TextEncoder();
  const batches: PersistenceQueueItem[][] = [];
  let batch: PersistenceQueueItem[] = [];
  let batchBytes = 2;

  for (const item of items) {
    const eventBytes = encoder.encode(JSON.stringify(item.event)).byteLength;
    if (eventBytes > MAX_PERSISTENCE_EVENT_BYTES) {
      throw new WorkerError("persistence_event_too_large", {
        httpStatus: 413,
        terminal: true,
      });
    }
    const itemBytes = encoder.encode(JSON.stringify(item)).byteLength + (batch.length ? 1 : 0);
    if (itemBytes + 2 > MAX_PERSISTENCE_ENQUEUE_BYTES) {
      throw new WorkerError("persistence_event_too_large", {
        httpStatus: 413,
        terminal: true,
      });
    }
    if (
      batch.length >= MAX_PERSISTENCE_ENQUEUE_ITEMS ||
      batchBytes + itemBytes > MAX_PERSISTENCE_ENQUEUE_BYTES
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 2;
    }
    batch.push(item);
    batchBytes += itemBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function enqueueEventPersistenceJobs(
  admin: AdminClient,
  workerId: string,
  job: CrawlJob,
  dataSourceId: string,
  events: NormalizedEvent[],
): Promise<{ requested: number; enqueued: number; batches: number }> {
  const items = await Promise.all(
    events.map(async (event) => {
      const envelope = persistenceEventEnvelope(event, job);
      return {
        event_key: await sha256(
          `${event.fingerprint}|${envelope.source.source_url}|${event.startDate}|${event.title}`,
        ),
        event: envelope,
      };
    }),
  );
  const batches = persistenceQueueBatches(items);
  let enqueued = 0;
  for (const batch of batches) {
    enqueued += Number(
      (await rpc<number>(admin, "enqueue_global_event_persistence_jobs", {
        _parent_job_id: job.job_id,
        _worker_id: workerId,
        _data_source_id: dataSourceId,
        _events: batch,
      })) ?? 0,
    );
  }
  return { requested: items.length, enqueued, batches: batches.length };
}

async function persistClaimedEvent(
  admin: AdminClient,
  workerId: string,
  job: PersistenceJob,
): Promise<JsonObject> {
  if (
    !validUuid(job.persistence_job_id) ||
    !validUuid(job.crawl_job_id) ||
    !validUuid(job.data_source_id) ||
    !job.event_key?.trim() ||
    !job.domain?.trim()
  ) {
    throw new WorkerError("persistence_job_invalid", {
      httpStatus: 400,
      terminal: true,
    });
  }
  const event = parseQueuedPersistenceEvent(job.event);
  const upserted = await rpc<unknown>(admin, "upsert_ingested_event_v2", {
    _data_source_id: job.data_source_id,
    _payload: event.payload,
  });
  const outcome = asRows<UpsertOutcome>(upserted)[0];
  if (!outcome) throw new WorkerError("upsert_empty_response");
  await registerEventSource(admin, job, event, outcome);
  if (!validUuid(outcome.event_id)) throw new WorkerError("upsert_missing_event_id");
  const completed = await rpc<boolean>(admin, "complete_global_event_persistence_job", {
    _job_id: job.persistence_job_id,
    _worker_id: workerId,
    _event_id: outcome.event_id,
    _action: nullableString(outcome.action) ?? "updated",
  });
  if (!completed) throw new WorkerError("persistence_completion_lease_lost");
  return {
    jobId: job.persistence_job_id,
    crawlJobId: job.crawl_job_id,
    kind: "persistence",
    ok: true,
    eventId: outcome.event_id,
    result: nullableString(outcome.action) ?? "updated",
  };
}

async function failPersistenceJob(
  admin: AdminClient,
  workerId: string,
  job: PersistenceJob,
  error: unknown,
): Promise<void> {
  const failure =
    error instanceof WorkerError
      ? error
      : new WorkerError("persistence_unexpected_error", { message: safeMessage(error) });
  await rpc<boolean>(admin, "fail_global_event_persistence_job", {
    _job_id: job.persistence_job_id,
    _worker_id: workerId,
    _error_code: failure.code,
    _error_message: safeMessage(failure),
    _retry_after_seconds: failure.retryAfterSeconds,
    _terminal: failure.terminal || job.attempt_count >= job.max_attempts,
  });
}

async function enqueueCrawlContinuations(
  admin: AdminClient,
  workerId: string,
  job: CrawlJob,
  continuations: Array<{ url: string; kind: "event" | "pagination" }>,
): Promise<number> {
  let enqueued = 0;
  for (let offset = 0; offset < continuations.length; offset += 100) {
    const batch = continuations.slice(offset, offset + 100).map((continuation) => ({
      url: continuation.url,
      canonical_url: continuation.url,
      kind: continuation.kind,
    }));
    enqueued += Number(
      (await rpc<number>(admin, "enqueue_global_crawl_continuations", {
        _parent_job_id: job.job_id,
        _worker_id: workerId,
        _continuations: batch,
      })) ?? 0,
    );
  }
  return enqueued;
}

function redirectHandoffDetails(
  job: CrawlJob,
  error: unknown,
): { sourceUrl: string; targetUrl: string } | null {
  if (!(error instanceof WorkerError) || !error.redirectSourceUrl || !error.redirectTargetUrl) {
    return null;
  }
  const sourceUrl = canonicalizeHttpUrl(error.redirectSourceUrl);
  const targetUrl = canonicalizeHttpUrl(error.redirectTargetUrl, sourceUrl ?? undefined);
  if (!sourceUrl || !targetUrl) return null;
  const source = new URL(sourceUrl);
  const target = new URL(targetUrl);
  const jobDomain = job.domain.toLowerCase().replace(/\.$/, "");
  if (
    source.hostname.toLowerCase().replace(/\.$/, "") !== jobDomain ||
    domainMatches(target.hostname, jobDomain, false) ||
    !domainMatches(target.hostname, jobDomain, true) ||
    (source.protocol === "https:" && target.protocol !== "https:")
  ) {
    return null;
  }
  return { sourceUrl, targetUrl };
}

async function enqueueCrawlRedirect(
  admin: AdminClient,
  workerId: string,
  job: CrawlJob,
  error: WorkerError,
): Promise<{ sourceUrl: string; targetUrl: string; enqueued: number }> {
  const redirect = redirectHandoffDetails(job, error);
  if (!redirect) {
    throw new WorkerError("redirect_handoff_invalid", {
      httpStatus: 400,
      terminal: true,
    });
  }
  const result = await rpc<unknown>(admin, "enqueue_global_crawl_redirect", {
    _parent_job_id: job.job_id,
    _worker_id: workerId,
    _redirect_url: redirect.targetUrl,
  });
  if (result === false) throw new WorkerError("redirect_handoff_lease_lost");
  const enqueued = result === true ? 1 : Math.max(0, Number(result ?? 0));
  if (!Number.isFinite(enqueued)) throw new WorkerError("redirect_handoff_invalid_response");
  return { ...redirect, enqueued };
}

async function completeRedirectHandoff(
  admin: AdminClient,
  workerId: string,
  job: CrawlJob,
  error: WorkerError,
): Promise<JsonObject> {
  const handoff = await enqueueCrawlRedirect(admin, workerId, job, error);
  const completed = await rpc<boolean>(admin, "complete_global_crawl_job", {
    _job_id: job.job_id,
    _worker_id: workerId,
    _http_status: error.httpStatus,
    _content_hash: await sha256(`${handoff.sourceUrl}->${handoff.targetUrl}`),
    _event_count: 0,
    _response_metadata: {
      final_url: handoff.sourceUrl,
      redirect_handoff: true,
      redirect_source_url: handoff.sourceUrl,
      redirect_target_url: handoff.targetUrl,
      redirect_jobs_enqueued: handoff.enqueued,
      event_error_count: 0,
    },
  });
  if (!completed) throw new WorkerError("crawl_completion_lease_lost");
  return {
    jobId: job.job_id,
    kind: "crawl",
    ok: true,
    redirected: true,
    redirectJobs: handoff.enqueued,
    targetUrl: handoff.targetUrl,
  };
}

async function scrapeCrawlJob(
  admin: AdminClient,
  workerId: string,
  job: CrawlJob,
): Promise<JsonObject> {
  const canonicalUrl = canonicalizeHttpUrl(job.canonical_url || job.url);
  const exactHostname = canonicalUrl
    ? new URL(canonicalUrl).hostname.toLowerCase().replace(/\.$/, "")
    : null;
  if (
    !canonicalUrl ||
    !exactHostname ||
    exactHostname !== job.domain.toLowerCase().replace(/\.$/, "")
  ) {
    throw new WorkerError("crawl_url_invalid", { httpStatus: 400, terminal: true });
  }

  const robots = await freshRobotsDecision(admin, workerId, {
    ...job,
    canonical_url: canonicalUrl,
  });
  if (robots.requiresInitialDelay && robots.crawlDelayMs > MAX_INLINE_CRAWL_DELAY_MS) {
    throw new WorkerError("crawl_delay_deferred", {
      httpStatus: 429,
      retryAfterSeconds: Math.ceil(robots.crawlDelayMs / 1_000),
    });
  }
  if (robots.requiresInitialDelay && robots.crawlDelayMs > 0) {
    await sleep(robots.crawlDelayMs);
  }

  const dataSourceId = await ensureDiscoverySource(admin, job);
  const source = sourceContext(job, dataSourceId);
  const robotsFetcher = createSerializedRobotsFetcher(job, robots.rules, robots.crawlDelayMs);
  const scraped = await scrapeDirectEventSource(
    { url: canonicalUrl, source },
    {
      fetcher: robotsFetcher.fetcher,
      timeoutMs: PAGE_TIMEOUT_MS,
      rootMaxBytes: 3 * 1024 * 1024,
      detailMaxBytes: 1_500_000,
      pageFetchBudget: 10,
    },
  );
  // The direct scraper records detail-page errors so one broken page does not
  // discard other events. Robots denial is different: it is a terminal policy
  // decision and must fail the entire crawl job even when raised by a detail.
  const robotsError = robotsFetcher.getTerminalError();
  if (robotsError) throw robotsError;
  const normalized = scraped.candidates.map((candidate) =>
    normalizeEventCandidate(candidate, source, canonicalUrl),
  );
  const rejectionReasons: Record<string, number> = {};
  const accepted: NormalizedEvent[] = [];
  for (const result of normalized) {
    if (result.ok) accepted.push(result.event);
    else rejectionReasons[result.reason] = (rejectionReasons[result.reason] ?? 0) + 1;
  }
  const deduplicated = deduplicateNormalizedEvents(accepted);
  // Event persistence is a separate durable queue. The crawl lease only
  // completes after every accepted event has been handed off idempotently.
  const persistence = await enqueueEventPersistenceJobs(
    admin,
    workerId,
    job,
    dataSourceId,
    deduplicated.events,
  );

  // Related-host redirects encountered on detail pages are deliberately not
  // followed with this origin's robots decision. Hand each target to a new
  // exact-origin job and suppress the now-obsolete source continuation.
  const redirectHandoffs = robotsFetcher.getRedirectHandoffs();
  const redirectedSourceUrls = new Set<string>();
  const redirectTargetUrls: string[] = [];
  let redirectJobs = 0;
  for (const redirectError of redirectHandoffs) {
    const handoff = await enqueueCrawlRedirect(admin, workerId, job, redirectError);
    redirectedSourceUrls.add(handoff.sourceUrl);
    redirectTargetUrls.push(handoff.targetUrl);
    redirectJobs += handoff.enqueued;
  }
  const continuations = scraped.continuation.filter((continuation) => {
    const canonical = canonicalizeHttpUrl(continuation.url);
    return !canonical || !redirectedSourceUrls.has(canonical);
  });

  // Network work is bounded per Edge invocation, not globally. Every
  // discovered page outside this invocation's budget (including transient
  // detail failures) becomes a durable child job before the parent completes.
  const continuationJobs = await enqueueCrawlContinuations(admin, workerId, job, continuations);

  const contentHash = await sha256(scraped.rootHtml);
  const completed = await rpc<boolean>(admin, "complete_global_crawl_job", {
    _job_id: job.job_id,
    _worker_id: workerId,
    _http_status: scraped.metadata.rootStatus,
    _content_hash: contentHash,
    // The crawl count records checkpointed events for this page. Individual
    // persistence outcomes are reported by the dedicated queue status.
    _event_count: persistence.requested,
    _response_metadata: {
      final_url: scraped.metadata.rootUrl,
      extraction_mode: scraped.mode,
      candidate_count: scraped.candidates.length,
      accepted_count: deduplicated.events.length,
      persistence_jobs_requested: persistence.requested,
      persistence_jobs_enqueued: persistence.enqueued,
      persistence_batches: persistence.batches,
      rejected_count: normalized.length - accepted.length,
      rejection_reasons: rejectionReasons,
      duplicates_merged: deduplicated.duplicates,
      duplicate_review_count: deduplicated.review.length,
      detail_pages_attempted: scraped.metadata.detailPagesAttempted,
      detail_pages_fetched: scraped.metadata.detailPagesFetched,
      pagination_pages_attempted: scraped.metadata.paginationPagesAttempted,
      pagination_pages_fetched: scraped.metadata.paginationPagesFetched,
      discovered_event_urls: scraped.metadata.discoveredEventUrlCount,
      discovered_pagination_urls: scraped.metadata.discoveredPaginationUrlCount,
      continuation_urls: continuations.length,
      continuation_jobs_enqueued: continuationJobs,
      redirect_handoff_count: redirectHandoffs.length,
      redirect_jobs_enqueued: redirectJobs,
      redirect_target_urls: redirectTargetUrls,
      page_fetch_budget: scraped.metadata.pageFetchBudget,
      budget_exhausted: scraped.metadata.budgetExhausted,
      event_error_count: 0,
    },
  });
  if (!completed) throw new WorkerError("crawl_completion_lease_lost");

  return {
    jobId: job.job_id,
    kind: "crawl",
    ok: true,
    candidates: scraped.candidates.length,
    accepted: deduplicated.events.length,
    persistenceRequested: persistence.requested,
    persistenceJobs: persistence.enqueued,
    persistenceBatches: persistence.batches,
    rejected: normalized.length - accepted.length,
    continuationJobs,
    redirectJobs,
  };
}

async function failCrawlJob(
  admin: AdminClient,
  workerId: string,
  job: CrawlJob,
  error: unknown,
): Promise<void> {
  const failure =
    error instanceof WorkerError
      ? error
      : new WorkerError("crawl_unexpected_error", { message: safeMessage(error) });
  await rpc<boolean>(admin, "fail_global_crawl_job", {
    _job_id: job.job_id,
    _worker_id: workerId,
    _error_code: failure.code,
    _error_message: safeMessage(failure),
    _http_status: failure.httpStatus || null,
    _retry_after_seconds: failure.retryAfterSeconds,
    _terminal: failure.terminal || job.attempt_count >= job.max_attempts,
  });
}

async function handleCrawl(admin: AdminClient, body: JsonObject): Promise<JsonObject> {
  const crawlLimit = boundedInteger(
    body.limit ?? body.batch_size,
    DEFAULT_CRAWL_BATCH,
    1,
    MAX_CRAWL_BATCH,
  );
  const persistenceLimit = boundedInteger(
    body.persistenceLimit ?? body.persistence_limit,
    DEFAULT_PERSISTENCE_BATCH,
    1,
    MAX_PERSISTENCE_BATCH,
  );
  const workerId = crypto.randomUUID();

  // Drain durable writes before doing more network work. This prevents a fast
  // crawler from continuously outrunning database persistence.
  const persistenceJobs = asRows<PersistenceJob>(
    await rpc<unknown>(admin, "claim_global_event_persistence_jobs", {
      _worker_id: workerId,
      _limit: persistenceLimit,
      _lease_seconds: PERSISTENCE_LEASE_SECONDS,
    }),
  );
  const persistenceSummaries: JsonObject[] = [];
  for (const job of persistenceJobs) {
    try {
      persistenceSummaries.push(await persistClaimedEvent(admin, workerId, job));
    } catch (error) {
      try {
        await failPersistenceJob(admin, workerId, job, error);
      } catch {
        // The lease will expire and make the persistence job claimable again.
      }
      persistenceSummaries.push({
        jobId: job.persistence_job_id,
        crawlJobId: job.crawl_job_id,
        kind: "persistence",
        ok: false,
        error: error instanceof WorkerError ? error.code : "persistence_unexpected_error",
      });
    }
  }

  // Validate infrastructure before leasing crawl work. A missing proxy must
  // fail without burning attempts for otherwise healthy network jobs.
  safeFetchProxyConfig();
  const maximumPersistenceBacklog = boundedInteger(
    Deno.env.get("GLOBAL_MAX_QUEUED_PERSISTENCE_JOBS"),
    20_000,
    100,
    250_000,
  );
  const jobs = asRows<CrawlJob>(
    await rpc<unknown>(admin, "claim_global_crawl_jobs", {
      _worker_id: workerId,
      _limit: crawlLimit,
      _lease_seconds: CRAWL_LEASE_SECONDS,
      _max_persistence_backlog: maximumPersistenceBacklog,
    }),
  );
  const crawlSummaries: JsonObject[] = [];
  for (const job of jobs) {
    try {
      crawlSummaries.push(await scrapeCrawlJob(admin, workerId, job));
    } catch (error) {
      let failure = error;
      if (error instanceof WorkerError && redirectHandoffDetails(job, error)) {
        try {
          crawlSummaries.push(await completeRedirectHandoff(admin, workerId, job, error));
          continue;
        } catch (handoffError) {
          failure = handoffError;
        }
      }
      try {
        await failCrawlJob(admin, workerId, job, failure);
      } catch {
        // The lease will expire and make the job claimable again.
      }
      crawlSummaries.push({
        jobId: job.job_id,
        kind: "crawl",
        ok: false,
        error: failure instanceof WorkerError ? failure.code : "crawl_unexpected_error",
      });
    }
  }
  const summaries = [...persistenceSummaries, ...crawlSummaries];
  // Per-URL crawl failures (e.g. robots_disallowed, crawl_delay_deferred,
  // crawl_unexpected_error) are expected operational outcomes. Infrastructure
  // failures (e.g. safe_fetch_proxy_not_configured) throw WorkerError and are
  // caught by the outer handler, returning an HTTP error response instead of
  // reaching this return statement.
  return {
    ok: true,
    action: "crawl",
    claimed: persistenceJobs.length + jobs.length,
    persistenceClaimed: persistenceJobs.length,
    crawlClaimed: jobs.length,
    completed: summaries.filter((summary) => summary.ok === true).length,
    failed: summaries.filter((summary) => summary.ok === false).length,
    persistence: {
      batchLimit: persistenceLimit,
      claimed: persistenceJobs.length,
      completed: persistenceSummaries.filter((summary) => summary.ok === true).length,
      failed: persistenceSummaries.filter((summary) => summary.ok === false).length,
    },
    crawl: {
      claimed: jobs.length,
      completed: crawlSummaries.filter((summary) => summary.ok === true).length,
      failed: crawlSummaries.filter((summary) => summary.ok === false).length,
    },
    jobs: summaries,
  };
}

async function handleStatus(admin: AdminClient, body: JsonObject): Promise<JsonObject> {
  let campaignId = body.campaignId ?? body.campaign_id;
  if (!validUuid(campaignId)) {
    const date = discoveryDate(body.date ?? body.target_date);
    const period = campaignPeriod(date);
    campaignId = await rpc<string>(admin, "ensure_global_scrape_campaign", {
      _campaign_key: period.key,
      _period_start: period.start,
      _period_end: period.end,
      _provider: SEARCH_PROVIDER,
      _metadata: { status_lookup: true },
    });
  }
  if (!validUuid(campaignId)) {
    throw new WorkerError("campaign_id_required", { httpStatus: 400, terminal: true });
  }
  const rows = asRows<JsonObject>(
    await rpc<unknown>(admin, "global_scrape_campaign_status", {
      _campaign_id: campaignId,
    }),
  );
  const backlog =
    asRows<JsonObject>(await rpc<unknown>(admin, "global_discovery_backlog", {}))[0] ?? null;
  const crawlBacklog = Math.max(0, Number(backlog?.crawl_backlog ?? 0));
  const persistenceBacklog = Math.max(0, Number(backlog?.persistence_backlog ?? 0));
  const maximumCrawlBacklog = boundedInteger(
    Deno.env.get("GLOBAL_MAX_QUEUED_CRAWL_JOBS"),
    5_000,
    100,
    250_000,
  );
  const maximumPersistenceBacklog = boundedInteger(
    Deno.env.get("GLOBAL_MAX_QUEUED_PERSISTENCE_JOBS"),
    20_000,
    100,
    250_000,
  );
  const eventPersistence =
    asRows<JsonObject>(
      await rpc<unknown>(admin, "global_event_persistence_campaign_status", {
        _campaign_id: campaignId,
      }),
    )[0] ?? null;
  return {
    ok: true,
    action: "status",
    campaign: rows[0] ?? null,
    global_discovery_backlog: backlog,
    backpressure: {
      search_crawl_backpressure_active: crawlBacklog > maximumCrawlBacklog - SEARCH_RESULT_LIMIT,
      search_backpressure_reason:
        crawlBacklog > maximumCrawlBacklog - SEARCH_RESULT_LIMIT ? "crawl_backlog" : null,
      crawl_fetch_claims_blocked: persistenceBacklog >= maximumPersistenceBacklog,
      crawl_fetch_blocked_by:
        persistenceBacklog >= maximumPersistenceBacklog ? "persistence_backlog" : null,
      persistence_drain_required: persistenceBacklog > 0,
      maximum_crawl_backlog: maximumCrawlBacklog,
      maximum_persistence_backlog: maximumPersistenceBacklog,
    },
    event_persistence: eventPersistence,
  };
}

function isPublicIp(address: string): boolean {
  const normalized = address.toLowerCase();
  if (/^\d+(?:\.\d+){3}$/.test(normalized)) {
    const octets = normalized.split(".").map(Number);
    const [a, b] = octets;
    if (octets.length !== 4 || octets.some((value) => value < 0 || value > 255)) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0) return false;
    return true;
  }
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("::ffff:")) return false;
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (!Number.isFinite(first)) return false;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) {
    return false;
  }
  if (normalized.startsWith("2001:db8:")) return false;
  return /^[0-9a-f:]+$/.test(normalized);
}

async function assertPublicDns(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (/^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(":")) {
    if (!isPublicIp(hostname)) throw new WorkerError("private_address_blocked", { terminal: true });
    return;
  }
  const resolver = (
    Deno as unknown as {
      resolveDns?: (query: string, recordType: "A" | "AAAA") => Promise<string[]>;
    }
  ).resolveDns;
  if (typeof resolver !== "function") {
    throw new WorkerError("dns_validation_unavailable", {
      httpStatus: 503,
      retryAfterSeconds: 900,
    });
  }
  const resolutions = await Promise.allSettled([
    resolver.call(Deno, hostname, "A"),
    resolver.call(Deno, hostname, "AAAA"),
  ]);
  const addresses = resolutions.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (!addresses.length) {
    throw new WorkerError("dns_resolution_failed", {
      httpStatus: 502,
      retryAfterSeconds: 900,
    });
  }
  if (addresses.some((address) => !isPublicIp(address))) {
    throw new WorkerError("private_address_blocked", { terminal: true, httpStatus: 400 });
  }
}

function domainMatches(
  hostname: string,
  expectedDomain: string,
  allowRelatedDomains: boolean,
): boolean {
  const exactHost = hostname.toLowerCase().replace(/\.$/, "");
  const exactExpected = expectedDomain.toLowerCase().replace(/\.$/, "");
  if (!allowRelatedDomains) return exactHost === exactExpected;
  const host = exactHost.replace(/^www\d*\./, "");
  const expected = exactExpected.replace(/^www\d*\./, "");
  return host === expected || host.endsWith(`.${expected}`) || expected.endsWith(`.${host}`);
}

type SecureFetchHooks = {
  beforeRequest?: (url: URL) => void | Promise<void>;
};

function safeFetchProxyConfig(): { url: string; token: string } {
  const rawUrl = Deno.env.get("SAFE_FETCH_PROXY_URL")?.trim();
  const token = Deno.env.get("SAFE_FETCH_AUTH_TOKEN")?.trim() ?? "";
  const url = rawUrl ? canonicalizeHttpUrl(rawUrl) : null;
  if (!url || new URL(url).protocol !== "https:" || token.length < 32) {
    throw new WorkerError("safe_fetch_proxy_not_configured", {
      httpStatus: 503,
      retryAfterSeconds: 900,
    });
  }
  return { url, token };
}

async function fetchThroughSafeProxy(url: URL, signal: AbortSignal): Promise<Response> {
  const proxy = safeFetchProxyConfig();
  let response: Response;
  try {
    response = await fetch(proxy.url, {
      method: "POST",
      headers: {
        Accept: "application/octet-stream,application/problem+json;q=0.1",
        Authorization: `Bearer ${proxy.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: url.toString() }),
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new WorkerError("safe_fetch_proxy_unreachable", {
      httpStatus: 503,
      retryAfterSeconds: 300,
      message: safeMessage(error),
    });
  }

  if (!response.ok) {
    const proxyCode = (response.headers.get("x-safe-fetch-error") ?? "proxy_failed")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .slice(0, 80);
    await response.body?.cancel();
    const targetRejected = response.status === 400 || response.status === 403;
    throw new WorkerError(`safe_fetch_${proxyCode || "proxy_failed"}`, {
      httpStatus: targetRejected ? response.status : 503,
      terminal: targetRejected,
      retryAfterSeconds: response.status === 429 ? 30 : 300,
    });
  }

  const status = Number.parseInt(response.headers.get("x-safe-fetch-status") ?? "", 10);
  if (!Number.isFinite(status) || status < 200 || status > 599) {
    await response.body?.cancel();
    throw new WorkerError("safe_fetch_proxy_invalid_response", {
      httpStatus: 502,
      retryAfterSeconds: 300,
    });
  }
  const headers = new Headers();
  const forwardedHeaders: Array<[string, string]> = [
    ["content-type", "x-safe-fetch-content-type"],
    ["location", "x-safe-fetch-location"],
    ["cache-control", "x-safe-fetch-cache-control"],
    ["etag", "x-safe-fetch-etag"],
    ["last-modified", "x-safe-fetch-last-modified"],
    ["retry-after", "x-safe-fetch-retry-after"],
  ];
  for (const [targetName, proxyName] of forwardedHeaders) {
    const value = response.headers.get(proxyName);
    if (value) headers.set(targetName, value);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength) headers.set("content-length", contentLength);
  const bodylessStatus = status === 204 || status === 205 || status === 304;
  if (bodylessStatus) {
    headers.delete("content-length");
    await response.body?.cancel();
  }
  const wrapped = new Response(bodylessStatus ? null : response.body, {
    status,
    headers,
  });
  Object.defineProperty(wrapped, "url", { value: url.toString() });
  return wrapped;
}

async function secureFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  expectedDomain: string,
  timeoutMs: number,
  maximumRedirects = MAX_REDIRECTS,
  allowRelatedDomains = true,
  hooks: SecureFetchHooks = {},
  usePinnedProxy = false,
): Promise<Response> {
  let current = canonicalizeHttpUrl(input instanceof Request ? input.url : String(input));
  if (!current) throw new WorkerError("outbound_url_invalid", { terminal: true, httpStatus: 400 });
  const requestUrl = current;
  const initialProtocol = new URL(current).protocol;
  const requestInit =
    input instanceof Request
      ? { ...init, method: init?.method ?? input.method, headers: init?.headers ?? input.headers }
      : { ...init };

  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    const url = new URL(current);
    if (initialProtocol === "https:" && url.protocol !== "https:") {
      throw new WorkerError("outbound_https_downgrade_blocked", {
        terminal: true,
        httpStatus: 400,
      });
    }
    if (!domainMatches(url.hostname, expectedDomain, allowRelatedDomains)) {
      throw new WorkerError("outbound_redirect_domain_blocked", {
        terminal: true,
        httpStatus: 400,
      });
    }
    if (!usePinnedProxy) await assertPublicDns(url);
    await hooks.beforeRequest?.(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const signal = requestInit.signal
      ? AbortSignal.any([requestInit.signal, controller.signal])
      : controller.signal;
    let response: Response;
    try {
      const headers = new Headers(requestInit.headers);
      headers.set("User-Agent", CRAWLER_USER_AGENT);
      if (usePinnedProxy) {
        const method = (requestInit.method ?? "GET").toUpperCase();
        if (method !== "GET") {
          throw new WorkerError("safe_fetch_method_not_allowed", {
            terminal: true,
            httpStatus: 400,
          });
        }
        response = await fetchThroughSafeProxy(url, signal);
      } else {
        response = await fetch(url, {
          ...requestInit,
          headers,
          redirect: "manual",
          signal,
        });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new WorkerError("outbound_timeout", {
          httpStatus: 504,
          retryAfterSeconds: 300,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new WorkerError("outbound_redirect_without_location", { httpStatus: 502 });
    const redirected = canonicalizeHttpUrl(location, current);
    if (!redirected) throw new WorkerError("outbound_redirect_invalid", { terminal: true });
    const redirectTarget = new URL(redirected);
    if (initialProtocol === "https:" && redirectTarget.protocol !== "https:") {
      throw new WorkerError("outbound_https_downgrade_blocked", {
        terminal: true,
        httpStatus: 400,
      });
    }
    if (!domainMatches(redirectTarget.hostname, expectedDomain, allowRelatedDomains)) {
      if (!allowRelatedDomains && domainMatches(redirectTarget.hostname, expectedDomain, true)) {
        throw new WorkerError("outbound_redirect_host_handoff", {
          httpStatus: response.status,
          terminal: true,
          redirectSourceUrl: requestUrl,
          redirectTargetUrl: redirected,
          message: `related_host_redirect:${new URL(current).hostname}->${redirectTarget.hostname}`,
        });
      }
      throw new WorkerError("outbound_redirect_domain_blocked", {
        terminal: true,
        httpStatus: 400,
      });
    }
    current = redirected;
  }
  throw new WorkerError("outbound_redirect_limit", { httpStatus: 502, retryAfterSeconds: 900 });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);

  try {
    const admin = createAdminClient();
    if (!(await isAuthorized(req, admin))) {
      return json(req, { error: "unauthorized" }, 401);
    }
    const body = await readJsonBody(req);
    const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
    let result: JsonObject;
    switch (action) {
      case "plan":
        result = await handlePlan(admin, body);
        break;
      case "search":
        result = await handleSearch(admin, body);
        break;
      case "crawl":
        result = await handleCrawl(admin, body);
        break;
      case "status":
        result = await handleStatus(admin, body);
        break;
      default:
        return json(req, { error: "invalid_action" }, 400);
    }
    return json(req, result);
  } catch (error) {
    const failure =
      error instanceof WorkerError
        ? error
        : new WorkerError("internal_error", { message: safeMessage(error) });
    return json(req, { error: failure.code }, failure.httpStatus >= 400 ? failure.httpStatus : 500);
  }
});
