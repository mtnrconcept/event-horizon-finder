import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.2";
import {
  normalizeEventCandidate,
  type EventSourceContext,
  type NormalizedEvent,
} from "../_shared/event-precision.ts";
import {
  evaluateRobotsPolicy,
  parseRobotsTxt,
  robotsUrlFor,
  type ParsedRobotsTxt,
} from "../_shared/robots-policy.ts";
import {
  parseLaDecadanseDocument,
  type LaDecadanseDiscoveredLink,
  type SourceVenueCandidate,
} from "./parser.ts";
import { enrichVenueWithOpenLicenseMedia } from "./media.ts";

type JsonObject = Record<string, unknown>;
type SourceContextRow = {
  source_id: string;
  source_name: string;
  city_id: string;
  city_name: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  country_id: string;
  country_code: string;
};
type CrawlJob = {
  job_id: string;
  parent_job_id: string | null;
  url: string;
  job_kind: string;
  crawl_depth: number;
  attempt_count: number;
  max_attempts: number;
};

const USER_AGENT =
  "GlobalParty-LaDecadanse/1.0 (+https://github.com/mtnrconcept/event-horizon-finder)";
const MAX_DOCUMENT_BYTES = 6 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 24_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
    : fallback;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorize(req: Request, admin: SupabaseClient): Promise<boolean> {
  const configuredSecret = Deno.env.get("GLOBAL_SCRAPER_SECRET")?.trim() ?? "";
  const providedSecret = req.headers.get("x-global-scraper-secret")?.trim() ?? "";
  if (configuredSecret.length >= 32 && constantTimeEqual(configuredSecret, providedSecret)) return true;

  const schedulerToken = req.headers.get("x-global-discovery-cron-token")?.trim() ?? "";
  if (!/^[a-f0-9]{64}$/i.test(schedulerToken)) return false;
  const tokenHash = await sha256Hex(schedulerToken.toLowerCase());
  const { data, error } = await admin.rpc("claim_global_discovery_scheduler_token_v1", {
    _token_hash: tokenHash,
  });
  return !error && data === true;
}

async function sourceContext(admin: SupabaseClient): Promise<{
  row: SourceContextRow;
  source: EventSourceContext;
}> {
  const { data, error } = await admin.rpc("ladecadanse_source_context_v1");
  if (error) throw new Error(`source_context:${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as SourceContextRow | null;
  if (!row?.source_id || !row.city_id) throw new Error("ladecadanse_source_missing");
  return {
    row,
    source: {
      id: row.source_id,
      name: row.source_name,
      domain: "www.ladecadanse.ch",
      category_slug: null,
      metadata: {
        adapter: "ladecadanse_v1",
        locale: "fr",
        max_distance_km: 120,
      },
      city: {
        name: row.city_name,
        timezone: row.timezone || "Europe/Zurich",
        latitude: row.latitude,
        longitude: row.longitude,
        country: { code: row.country_code || "CH" },
      },
    },
  };
}

async function responseTextLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_DOCUMENT_BYTES) throw new Error("document_too_large");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error("document_too_large");
  }
  return text;
}

async function fetchText(url: string): Promise<{ status: number; contentType: string; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,text/plain;q=0.8",
        "user-agent": USER_AGENT,
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      const error = new Error(`source_http_${response.status}`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (
      response.ok &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml") &&
      !contentType.includes("application/xml") &&
      !contentType.includes("text/xml") &&
      !contentType.includes("application/rss+xml") &&
      !contentType.includes("text/plain")
    ) {
      throw new Error(`unsupported_content_type:${contentType.slice(0, 120)}`);
    }
    return {
      status: response.status,
      contentType,
      text: response.ok ? await responseTextLimited(response) : "",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function robotsPolicy(): Promise<ParsedRobotsTxt> {
  const robotsUrl = robotsUrlFor("https://www.ladecadanse.ch/");
  if (!robotsUrl) return { groups: [], sitemaps: [] };
  try {
    const response = await fetch(robotsUrl, {
      headers: { accept: "text/plain", "user-agent": USER_AGENT },
      redirect: "follow",
    });
    if (response.status === 404 || response.status === 410) return { groups: [], sitemaps: [] };
    if (!response.ok) throw new Error(`robots_http_${response.status}`);
    return parseRobotsTxt(await responseTextLimited(response));
  } catch {
    // Fail closed for a short interval through the job retry policy.
    throw new Error("robots_unavailable");
  }
}

function eventPayload(event: NormalizedEvent): JsonObject {
  return {
    external_identifier: event.externalId,
    source_url: event.sourceUrl,
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
    performers: event.performers.map((performer) => ({
      name: performer.name,
      type: performer.type,
      image_url: performer.imageUrl,
      is_headliner: performer.isHeadliner,
    })),
    age_restriction: event.ageRestriction,
    accessibility: event.accessibility
      ? {
          wheelchair: event.accessibility.wheelchair,
          hearing_loop: event.accessibility.hearingLoop,
          sign_language: event.accessibility.signLanguage,
          quiet_space: event.accessibility.quietSpace,
          notes: event.accessibility.notes,
        }
      : null,
    capacity: event.capacity,
    price_min: event.priceMin,
    price_max: event.priceMax,
    currency: event.currency,
    ticket_url: event.ticketUrl,
    image_url: event.imageUrl,
    is_free: event.isFree,
    quality_score: event.qualityScore,
    fingerprint: event.fingerprint,
    warnings: event.warnings,
    extraction_method: "ladecadanse_microformat_v1",
  };
}

async function upsertVenue(
  admin: SupabaseClient,
  sourceId: string,
  venue: SourceVenueCandidate,
): Promise<{ venueId: string | null; placeId: string | null }> {
  const { data, error } = await admin.rpc("upsert_ladecadanse_venue_v1", {
    _data_source_id: sourceId,
    _venue: {
      external_id: venue.externalId,
      source_url: venue.sourceUrl,
      name: venue.name,
      category: venue.category,
      subcategory: venue.subcategory,
      description: venue.description,
      address: venue.address,
      postal_code: venue.postalCode,
      city: venue.city,
      country_code: venue.countryCode,
      latitude: venue.latitude,
      longitude: venue.longitude,
      website: venue.website,
      opening_hours: venue.openingHours,
      booking_url: venue.bookingUrl,
      image_urls: venue.imageUrls,
      media: venue.media.map((item) => ({
        url: item.url,
        thumbnail_url: item.thumbnailUrl,
        attribution: item.attribution,
        license: item.license,
        license_url: item.licenseUrl,
        creator: item.creator,
        source_url: item.sourceUrl,
        source_provider: item.sourceProvider,
        is_fallback: item.isFallback,
      })),
      source_urls: venue.sourceUrls,
      content_sources: venue.contentSources,
      quality_score: venue.qualityScore,
    },
  });
  if (error) throw new Error(`venue_upsert:${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { venue_id?: string | null; place_id?: string | null }
    | null;
  return { venueId: row?.venue_id ?? null, placeId: row?.place_id ?? null };
}

async function persistEvents(
  admin: SupabaseClient,
  source: EventSourceContext,
  candidates: ReturnType<typeof parseLaDecadanseDocument>["events"],
): Promise<{ accepted: number; rejected: number; created: number; updated: number }> {
  let accepted = 0;
  let rejected = 0;
  let created = 0;
  let updated = 0;
  for (const candidate of candidates) {
    const normalized = normalizeEventCandidate(candidate, source, candidate.sourceUrl ?? source.domain);
    if (!normalized.ok) {
      rejected += 1;
      continue;
    }
    const { data, error } = await admin.rpc("upsert_ingested_event_serial_v1", {
      _data_source_id: source.id,
      _payload: eventPayload(normalized.event),
    });
    if (error) throw new Error(`event_upsert:${error.message}`);
    const outcome = (Array.isArray(data) ? data[0] : data) as
      | { event_id?: string; action?: string }
      | null;
    if (!outcome?.event_id || !UUID_PATTERN.test(outcome.event_id)) {
      throw new Error("event_upsert_missing_id");
    }
    accepted += 1;
    if (outcome.action === "created") created += 1;
    else updated += 1;
    const { error: placeError } = await admin.rpc("sync_event_venue_place_v1", {
      _event_id: outcome.event_id,
    });
    if (placeError) throw new Error(`event_venue_sync:${placeError.message}`);
  }
  return { accepted, rejected, created, updated };
}

async function enqueueLinks(
  admin: SupabaseClient,
  job: CrawlJob,
  workerId: string,
  links: LaDecadanseDiscoveredLink[],
): Promise<number> {
  if (!links.length) return 0;
  const { data, error } = await admin.rpc("enqueue_ladecadanse_urls_v1", {
    _parent_job_id: job.job_id,
    _worker_id: workerId,
    _items: links.map((link) => ({
      url: link.url,
      kind: link.kind,
      priority: link.priority,
      refresh_after_seconds: link.refreshAfterSeconds,
    })),
  });
  if (error) throw new Error(`enqueue_links:${error.message}`);
  return Number(data ?? 0);
}

function retryPolicy(error: unknown): { terminal: boolean; delay: number; code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const status = Number((error as { status?: number } | null)?.status ?? 0);
  if (status === 404 || status === 410) return { terminal: true, delay: 0, code: "source_removed", message };
  if (status === 429) return { terminal: false, delay: 1800, code: "source_rate_limited", message };
  if ([408, 425, 500, 502, 503, 504].includes(status) || /abort|timeout|unavailable/i.test(message)) {
    return { terminal: false, delay: 600, code: "source_transient", message };
  }
  if (/robots.*disallow/i.test(message)) return { terminal: true, delay: 0, code: "robots_disallowed", message };
  return { terminal: false, delay: 900, code: "source_error", message };
}

async function reserveRequestSlot(admin: SupabaseClient, workerId: string, delaySeconds: number): Promise<void> {
  const { data, error } = await admin.rpc("reserve_ladecadanse_request_slot_v1", {
    _worker_id: workerId,
    _minimum_delay_seconds: delaySeconds,
  });
  if (error) throw new Error(`request_slot:${error.message}`);
  const waitMs = boundedInteger(data, 0, 0, 120_000);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function processJob(
  admin: SupabaseClient,
  job: CrawlJob,
  workerId: string,
  context: Awaited<ReturnType<typeof sourceContext>>,
  robots: ParsedRobotsTxt,
): Promise<JsonObject> {
  const decision = evaluateRobotsPolicy(robots, job.url, USER_AGENT);
  if (!decision.allowed) throw new Error("robots_disallowed");
  const delaySeconds = Math.max(15, Math.ceil(decision.crawlDelaySeconds ?? 15));
  await reserveRequestSlot(admin, workerId, delaySeconds);
  const document = await fetchText(job.url);
  if (document.status === 404 || document.status === 410) {
    const { error } = await admin.rpc("complete_ladecadanse_job_v1", {
      _job_id: job.job_id,
      _worker_id: workerId,
      _http_status: document.status,
      _content_hash: null,
      _metadata: { removed: true },
    });
    if (error) throw new Error(`complete_removed:${error.message}`);
    return { job_id: job.job_id, removed: true, http_status: document.status };
  }

  const parsed = parseLaDecadanseDocument(document.text, job.url, context.source);
  let venueCount = 0;
  let placeCount = 0;
  for (const rawVenue of parsed.venues) {
    const venue = job.job_kind === "venue" ? await enrichVenueWithOpenLicenseMedia(rawVenue) : rawVenue;
    const outcome = await upsertVenue(admin, context.row.source_id, venue);
    venueCount += outcome.venueId ? 1 : 0;
    placeCount += outcome.placeId ? 1 : 0;
  }
  const events = await persistEvents(admin, context.source, parsed.events);
  const enqueued = await enqueueLinks(admin, job, workerId, parsed.links);
  const contentHash = await sha256Hex(document.text);
  const metadata = {
    content_type: document.contentType,
    event_candidates: parsed.events.length,
    accepted_events: events.accepted,
    rejected_events: events.rejected,
    created_events: events.created,
    updated_events: events.updated,
    venue_candidates: parsed.venues.length,
    venues_upserted: venueCount,
    places_upserted: placeCount,
    continuations_enqueued: enqueued,
  };
  const { error: completeError } = await admin.rpc("complete_ladecadanse_job_v1", {
    _job_id: job.job_id,
    _worker_id: workerId,
    _http_status: document.status,
    _content_hash: contentHash,
    _metadata: metadata,
  });
  if (completeError) throw new Error(`complete_job:${completeError.message}`);
  return { job_id: job.job_id, kind: job.job_kind, ...metadata };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (!supabaseUrl || !serviceKey) return json({ error: "server_not_configured" }, 500);
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  if (!(await authorize(req, admin))) return json({ error: "unauthorized" }, 401);

  let body: JsonObject;
  try {
    body = record(await req.json());
  } catch {
    body = {};
  }
  const action = String(body.action ?? "run").toLowerCase();
  if (action === "status") {
    const { data, error } = await admin.rpc("ladecadanse_discovery_status_v1");
    return error ? json({ error: error.message }, 500) : json({ ok: true, status: data });
  }
  if (action === "seed") {
    const { data, error } = await admin.rpc("seed_ladecadanse_discovery_v1", {
      _future_days: boundedInteger(body.future_days, 366, 7, 366),
      _force: body.force === true,
    });
    return error ? json({ error: error.message }, 500) : json(data);
  }
  if (action !== "run") return json({ error: "unsupported_action" }, 400);

  const workerId = crypto.randomUUID();
  if (body.seed !== false) {
    const { error } = await admin.rpc("seed_ladecadanse_discovery_v1", {
      _future_days: boundedInteger(body.future_days, 366, 7, 366),
      _force: false,
    });
    if (error) return json({ error: `seed:${error.message}` }, 500);
  }
  const { data: began, error: beginError } = await admin.rpc("begin_ladecadanse_worker_v1", {
    _worker_id: workerId,
    _lease_seconds: 300,
  });
  if (beginError) return json({ error: beginError.message }, 500);
  if (began !== true) return json({ ok: true, skipped: true, reason: "worker_busy" });

  const results: JsonObject[] = [];
  let failed = 0;
  try {
    const context = await sourceContext(admin);
    const robots = await robotsPolicy();
    const { data, error } = await admin.rpc("claim_ladecadanse_jobs_v1", {
      _worker_id: workerId,
      _limit: boundedInteger(body.batch_size, 5, 1, 5),
      _lease_seconds: 300,
    });
    if (error) throw new Error(`claim_jobs:${error.message}`);
    const jobs = (Array.isArray(data) ? data : []) as CrawlJob[];
    for (const job of jobs) {
      try {
        results.push(await processJob(admin, job, workerId, context, robots));
      } catch (error) {
        failed += 1;
        const policy = retryPolicy(error);
        await admin.rpc("fail_ladecadanse_job_v1", {
          _job_id: job.job_id,
          _worker_id: workerId,
          _error_code: policy.code,
          _error_message: policy.message,
          _retry_after_seconds: policy.delay,
          _terminal: policy.terminal,
        });
        results.push({ job_id: job.job_id, ok: false, error: policy.code });
      }
    }
  } catch (error) {
    failed += 1;
    results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await admin.rpc("finish_ladecadanse_worker_v1", {
      _worker_id: workerId,
      _result: { processed: results.length, failed, finished_at: new Date().toISOString() },
    });
  }

  return json({ ok: failed === 0, processed: results.length, failed, results }, failed ? 207 : 200);
});
