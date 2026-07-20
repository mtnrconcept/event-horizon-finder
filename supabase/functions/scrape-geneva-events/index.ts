// Batched, allow-listed event ingestion for Geneva and the international source registry.
// Auth: a configured scheduler secret or an authenticated admin/moderator.
import { createClient } from "npm:@supabase/supabase-js@2";
import { scrapeDirectEventSource } from "../_shared/direct-event-scraper.ts";
import {
  deduplicateNormalizedEvents,
  normalizeEventCandidate,
  type EventCandidate,
  type EventSourceContext,
  type NormalizedEvent,
} from "../_shared/event-precision.ts";
import { failureRetryDelayMs } from "../_shared/source-retry-policy.ts";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ALLOWED_ORIGINS") ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-geneva-scraper-secret",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const MAX_BATCH_SIZE = 4;
// Supabase Edge requests are terminated after roughly 150 seconds. Keep every
// source comfortably below that ceiling, including the deterministic fallback
// and database writes.
const DIRECT_TIMEOUT_MS = 12_000;
const DIRECT_DETAIL_LIMIT = 3;
const STALE_JOB_AFTER_MS = 3 * 60_000;
const UPSERT_CONCURRENCY = 6;

type DataSource = {
  id: string;
  name: string;
  base_url: string;
  domain: string;
  page_count: number | null;
  priority: number | null;
  sync_frequency: string | null;
  last_sync_at: string | null;
  next_sync_at: string | null;
  updated_at: string | null;
  category_slug: string | null;
  metadata: Record<string, unknown> | null;
  city: {
    name: string;
    timezone: string;
    latitude: number | null;
    longitude: number | null;
    country: { code: string } | null;
  } | null;
};

type SourceTask = {
  source: DataSource;
  page: number;
  url: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: cors });
}

function safeInteger(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), max);
}

function pageUrl(source: DataSource, page: number): string {
  if (page === 0) return source.base_url;
  const pagination = source.metadata?.pagination;
  if (pagination !== "page") return source.base_url;
  const url = new URL(source.base_url);
  url.searchParams.set("page", String(page));
  return url.toString();
}

function shouldSync(source: DataSource, force: boolean, runStartedAt: number | null): boolean {
  if (force) return true;
  const lastSync = source.last_sync_at ? new Date(source.last_sync_at).getTime() : Number.NaN;
  const updatedAt = source.updated_at ? new Date(source.updated_at).getTime() : Number.NaN;
  // Keep the task list stable for cursor pagination. Both successful and failed
  // sources are updated during the run and must remain in the same snapshot.
  if (
    runStartedAt &&
    ((Number.isFinite(lastSync) && lastSync >= runStartedAt) ||
      (Number.isFinite(updatedAt) && updatedAt >= runStartedAt))
  ) {
    return true;
  }
  const nextSync = source.next_sync_at ? new Date(source.next_sync_at).getTime() : Number.NaN;
  if (Number.isFinite(nextSync) && nextSync > Date.now()) return false;
  if (!source.last_sync_at) return true;
  const elapsed = Date.now() - lastSync;
  if (!Number.isFinite(elapsed)) return true;
  const minimum = source.sync_frequency === "weekly" ? 6 * 24 * 3_600_000 : 18 * 3_600_000;
  return elapsed >= minimum;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function isAllowed(
  req: Request,
  hasElevatedRole: (userId: string) => Promise<boolean>,
): Promise<boolean> {
  const configuredSecret = Deno.env.get("GENEVA_SCRAPER_SECRET")?.trim();
  const providedSecret = req.headers.get("x-geneva-scraper-secret")?.trim();
  if (configuredSecret && providedSecret && timingSafeEqual(providedSecret, configuredSecret)) {
    return true;
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return false;
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return false;
  return hasElevatedRole(user.id);
}

type CollectedCandidates = {
  mode: "direct";
  rawContent: string;
  markdown: string | null;
  rawJson: unknown;
  metadata: Record<string, unknown>;
  aiCandidates: EventCandidate[];
  deterministicCandidates: EventCandidate[];
};

async function collectCandidates(
  task: SourceTask,
  directOnly: boolean,
): Promise<CollectedCandidates> {
  const sourceContext = task.source as EventSourceContext;
  const directTimeoutMs = Math.max(
    5_000,
    safeInteger(task.source.metadata?.direct_timeout_ms, DIRECT_TIMEOUT_MS, 15_000),
  );
  const directDetailLimit = safeInteger(
    task.source.metadata?.direct_detail_limit,
    DIRECT_DETAIL_LIMIT,
    DIRECT_DETAIL_LIMIT,
  );
  const direct = await scrapeDirectEventSource(
    { url: task.url, source: sourceContext },
    { timeoutMs: directTimeoutMs, detailPageLimit: directDetailLimit },
  );
  return {
    mode: "direct",
    rawContent: direct.rootHtml,
    markdown: null,
    rawJson: null,
    metadata: {
      ...direct.metadata,
      transport: "direct",
      directOnly,
      paidProvidersDisabled: true,
    },
    aiCandidates: [],
    deterministicCandidates: direct.candidates,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const allowed = await isAllowed(req, async (userId) => {
    const { data, error } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .in("role", ["admin", "moderator"]);
    return !error && Boolean(data?.length);
  });
  if (!allowed) return json({ error: "unauthorized" }, 401);

  // A platform timeout cannot execute the normal catch/finalizer. Reconcile
  // jobs left running by a previous terminated invocation before starting a
  // new batch; a genuine Edge invocation cannot still be alive after 3 min.
  const staleBefore = new Date(Date.now() - STALE_JOB_AFTER_MS).toISOString();
  const { error: staleJobError } = await admin
    .from("ingestion_jobs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: "edge_runtime_timeout",
    })
    .eq("status", "running")
    .lt("started_at", staleBefore);
  if (staleJobError)
    console.warn("Unable to reconcile stale ingestion jobs", staleJobError.message);

  const body = (await req.json().catch(() => ({}))) as {
    cursor?: number;
    batchSize?: number;
    force?: boolean;
    runStartedAt?: string;
    sourceIds?: string[];
    directOnly?: boolean;
  };
  const cursor = safeInteger(body.cursor, 0, 10_000);
  const batchSize = Math.max(1, safeInteger(body.batchSize, 3, MAX_BATCH_SIZE));
  const force = body.force === true;
  const directOnly = true;
  const parsedRunStartedAt = body.runStartedAt ? Date.parse(body.runStartedAt) : Number.NaN;
  const runStartedAt = Number.isFinite(parsedRunStartedAt) ? parsedRunStartedAt : null;
  const sourceIds = Array.isArray(body.sourceIds)
    ? body.sourceIds.filter((value): value is string => typeof value === "string").slice(0, 50)
    : [];

  let sourceQuery = admin
    .from("data_sources")
    .select(
      "id,name,base_url,domain,page_count,priority,sync_frequency,last_sync_at,next_sync_at,updated_at,category_slug,metadata,city:cities(name,timezone,latitude,longitude,country:countries(code))",
    )
    .eq("status", "active")
    .eq("is_authorized", true)
    .eq("is_verified", true)
    .order("priority", { ascending: true })
    .order("name", { ascending: true });
  if (sourceIds.length) sourceQuery = sourceQuery.in("id", sourceIds);
  const { data: sourceRows, error: sourcesError } = await sourceQuery;
  if (sourcesError) return json({ error: sourcesError.message }, 500);

  const sources = (sourceRows ?? []) as unknown as DataSource[];
  const tasks = sources
    .filter((source) => source.metadata?.derived_city_source !== true)
    .filter((source) => source.metadata?.import_only !== true)
    .filter((source) => shouldSync(source, force, runStartedAt))
    .flatMap((source) =>
      Array.from({ length: Math.max(1, source.page_count ?? 1) }, (_, page) => ({
        source,
        page,
        url: pageUrl(source, page),
      })),
    );
  const batch = tasks.slice(cursor, cursor + batchSize);
  if (!batch.length) {
    return json({
      ok: true,
      cursor,
      nextCursor: cursor,
      hasMore: false,
      totalTasks: tasks.length,
      message: "nothing_to_sync",
    });
  }

  const { data: job, error: jobError } = await admin
    .from("ingestion_jobs")
    .insert({
      status: "running",
      started_at: new Date().toISOString(),
      pages_found: batch.length,
      metadata: {
        cursor,
        batchSize,
        totalTasks: tasks.length,
        directOnly,
        paidProvidersDisabled: true,
        sources: batch.map((task) => ({
          id: task.source.id,
          name: task.source.name,
          page: task.page,
          url: task.url,
        })),
      },
    })
    .select("id")
    .single();
  if (jobError) return json({ error: jobError.message }, 500);

  const results = await Promise.all(
    batch.map(async (task) => {
      let created = 0;
      let updated = 0;
      let rejected = 0;
      const upsertErrors: string[] = [];
      try {
        const collected = await collectCandidates(task, directOnly);
        const sourceContext = task.source as EventSourceContext;
        const aiCandidates = collected.aiCandidates;
        const jsonLdCandidates = collected.deterministicCandidates;
        const candidates = [...jsonLdCandidates, ...aiCandidates];
        const normalization = candidates.map((candidate) =>
          normalizeEventCandidate(candidate, sourceContext, task.url),
        );
        const rejectionReasons = normalization
          .filter((result) => !result.ok)
          .reduce<Record<string, number>>((summary, result) => {
            if (!result.ok) summary[result.reason] = (summary[result.reason] ?? 0) + 1;
            return summary;
          }, {});
        rejected += normalization.filter((result) => !result.ok).length;
        const normalizedEvents = normalization
          .filter((result): result is { ok: true; event: NormalizedEvent } => result.ok)
          .map((result) => result.event);
        const deduplication = deduplicateNormalizedEvents(normalizedEvents);
        const events = deduplication.events;
        const markdown = collected.markdown;
        const contentHash = await sha256(collected.rawContent || JSON.stringify(collected.rawJson));

        const { data: record, error: recordError } = await admin
          .from("source_records")
          .insert({
            data_source_id: task.source.id,
            source_url: task.url,
            ingestion_job_id: job.id,
            raw_markdown: markdown,
            raw_json: {
              json: collected.rawJson,
              metadata: collected.metadata,
            },
            content_hash: contentHash,
            extracted_data: {
              precisionVersion: 2,
              scrapeMode: collected.mode,
              candidateCount: candidates.length,
              deterministicCount: jsonLdCandidates.length,
              aiCount: aiCandidates.length,
              acceptedCount: events.length,
              rejectedCount: rejected,
              rejectionReasons,
              duplicatesMerged: deduplication.duplicates,
              duplicateReview: deduplication.review,
              events,
            },
            processing_status: "processed",
            processed_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (recordError) throw recordError;

        for (let offset = 0; offset < events.length; offset += UPSERT_CONCURRENCY) {
          await Promise.all(
            events.slice(offset, offset + UPSERT_CONCURRENCY).map(async (event) => {
              const { data: upserted, error: upsertError } = await admin.rpc(
                "upsert_ingested_event_v2",
                {
                  _data_source_id: task.source.id,
                  _payload: {
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
                    address: event.address,
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
                    price_min: event.priceMin,
                    price_max: event.priceMax,
                    currency: event.currency,
                    ticket_url: event.ticketUrl,
                    ticket_status: event.isFree
                      ? "free"
                      : event.ticketUrl
                        ? "available"
                        : "unknown",
                    image_url: event.imageUrl,
                    is_free: event.isFree,
                    quality_score: event.qualityScore,
                    warnings: event.warnings,
                    extraction_method: event.extractionMethod,
                  },
                },
              );
              if (upsertError) {
                rejected += 1;
                if (upsertErrors.length < 5) {
                  upsertErrors.push(upsertError.message.slice(0, 500));
                }
                return;
              }
              const outcome = Array.isArray(upserted) ? upserted[0] : upserted;
              if (outcome?.action === "created") created += 1;
              else updated += 1;
            }),
          );
        }

        const sourceCompleted = task.page >= Math.max(1, task.source.page_count ?? 1) - 1;
        await Promise.all([
          admin.from("ingestion_job_items").insert({
            ingestion_job_id: job.id,
            url: task.url,
            status: "completed",
            processed_at: new Date().toISOString(),
          }),
          sourceCompleted
            ? admin
                .from("data_sources")
                .update({
                  last_sync_at: new Date().toISOString(),
                  next_sync_at: new Date(
                    Date.now() +
                      (task.source.sync_frequency === "weekly" ? 7 * 24 : 24) * 3_600_000,
                  ).toISOString(),
                })
                .eq("id", task.source.id)
            : Promise.resolve(),
        ]);

        return {
          ok: true as const,
          source: task.source.name,
          page: task.page,
          url: task.url,
          sourceRecordId: record.id,
          scrapeMode: collected.mode,
          candidates: candidates.length,
          deterministic: jsonLdCandidates.length,
          extracted: events.length,
          duplicatesMerged: deduplication.duplicates,
          duplicateReview: deduplication.review.length,
          rejectionReasons,
          created,
          updated,
          rejected,
          upsertErrors,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_error";
        const sourceCompleted = task.page >= Math.max(1, task.source.page_count ?? 1) - 1;
        await Promise.all([
          admin.from("ingestion_job_items").insert({
            ingestion_job_id: job.id,
            url: task.url,
            status: "failed",
            error_message: message.slice(0, 1_000),
            processed_at: new Date().toISOString(),
          }),
          sourceCompleted
            ? admin
                .from("data_sources")
                .update({
                  next_sync_at: new Date(
                    Date.now() + failureRetryDelayMs(message, task.source.sync_frequency),
                  ).toISOString(),
                })
                .eq("id", task.source.id)
            : Promise.resolve(),
        ]);
        return {
          ok: false as const,
          source: task.source.name,
          page: task.page,
          url: task.url,
          error: message,
          created,
          updated,
          rejected,
          upsertErrors,
        };
      }
    }),
  );

  const successful = results.filter((result) => result.ok).length;
  const failed = results.length - successful;
  const created = results.reduce((total, result) => total + result.created, 0);
  const updated = results.reduce((total, result) => total + result.updated, 0);
  const rejected = results.reduce((total, result) => total + result.rejected, 0);
  const nextCursor = cursor + batch.length;
  const hasMore = nextCursor < tasks.length;

  await admin
    .from("ingestion_jobs")
    .update({
      status: failed === 0 ? "completed" : successful > 0 ? "partially_completed" : "failed",
      finished_at: new Date().toISOString(),
      pages_success: successful,
      pages_failed: failed,
      events_created: created,
      events_updated: updated,
      duplicates_found: updated,
      credits_used: successful,
      error_message: failed === results.length ? "all_sources_failed" : null,
      metadata: {
        cursor,
        nextCursor,
        hasMore,
        totalTasks: tasks.length,
        rejected,
        results,
      },
    })
    .eq("id", job.id);

  return json({
    ok: failed < results.length,
    jobId: job.id,
    cursor,
    nextCursor,
    hasMore,
    totalTasks: tasks.length,
    pagesSuccess: successful,
    pagesFailed: failed,
    eventsCreated: created,
    eventsUpdated: updated,
    eventsRejected: rejected,
    results,
  });
});
