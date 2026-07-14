// Batched, allow-listed event ingestion for Geneva and the international source registry.
// Auth: a configured scheduler secret or an authenticated admin/moderator.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ALLOWED_ORIGINS") ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-geneva-scraper-secret",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const MAX_BATCH_SIZE = 4;
const FIRECRAWL_TIMEOUT_MS = 72_000;

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        properties: {
          externalId: { type: ["string", "null"] },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          startDate: {
            type: ["string", "null"],
            description: "ISO 8601 date-time including the UTC offset when a time is known",
          },
          endDate: { type: ["string", "null"] },
          venueName: { type: ["string", "null"] },
          address: { type: ["string", "null"] },
          latitude: { type: ["number", "null"] },
          longitude: { type: ["number", "null"] },
          category: { type: ["string", "null"] },
          genres: {
            type: ["array", "null"],
            maxItems: 8,
            items: { type: "string" },
            description: "Styles musicaux explicitement mentionnés, sans déduction",
          },
          capacity: { type: ["integer", "null"] },
          priceMin: { type: ["number", "null"] },
          priceMax: { type: ["number", "null"] },
          currency: { type: ["string", "null"] },
          ticketUrl: { type: ["string", "null"] },
          imageUrl: { type: ["string", "null"] },
          isFree: { type: ["boolean", "null"] },
          sourceUrl: { type: ["string", "null"] },
        },
        required: ["title", "startDate"],
      },
    },
  },
  required: ["events"],
};

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
  city: { name: string; timezone: string } | null;
};

type SourceTask = {
  source: DataSource;
  page: number;
  url: string;
};

type ExtractedEvent = {
  externalId?: string | null;
  title?: string | null;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  venueName?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  category?: string | null;
  genres?: string[] | null;
  capacity?: number | null;
  priceMin?: number | null;
  priceMax?: number | null;
  currency?: string | null;
  ticketUrl?: string | null;
  imageUrl?: string | null;
  isFree?: boolean | null;
  sourceUrl?: string | null;
};

const ALLOWED_GENRES = new Set([
  "afro-house",
  "techno",
  "house",
  "electro",
  "trance",
  "drum-and-bass",
  "hip-hop",
  "r-and-b",
  "soul",
  "reggae",
  "dancehall",
  "disco",
  "funk",
  "jazz",
  "blues",
  "rock",
  "metal",
  "punk",
  "indie",
  "pop",
  "classical",
  "opera",
  "latin",
  "reggaeton",
  "afrobeat",
  "world",
  "experimental",
  "ambient",
  "gospel",
]);

function normalizedGenres(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) =>
          item
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .trim()
            .replace(/\s+|_/g, "-"),
        )
        .filter((item) => ALLOWED_GENRES.has(item)),
    ),
  ];
}

function optionalPositiveNumber(value: unknown, maximum: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    return null;
  }
  return value;
}

type FirecrawlPayload = {
  data?: {
    markdown?: string;
    json?: { events?: ExtractedEvent[] };
    metadata?: Record<string, unknown>;
  };
  message?: string;
  error?: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: cors });
}

function safeInteger(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), max);
}

function safeHttpUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = new URL(value, fallback);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function safeOptionalHttpUrl(value: unknown, base: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value, base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
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

function isValidDate(value: string | null | undefined): value is string {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return (
    timestamp >= Date.now() - 2 * 24 * 3_600_000 && timestamp <= Date.now() + 730 * 24 * 3_600_000
  );
}

function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
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

async function isAllowed(req: Request, admin: ReturnType<typeof createClient>): Promise<boolean> {
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
  const { data } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .in("role", ["admin", "moderator"]);
  return Boolean(data?.length);
}

async function scrapeWithFirecrawl(apiKey: string, task: SourceTask): Promise<FirecrawlPayload> {
  let lastError = "unknown_error";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);
    try {
      const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          url: task.url,
          onlyMainContent: true,
          maxAge: 3_600_000,
          formats: [
            "markdown",
            {
              type: "json",
              schema: EXTRACTION_SCHEMA,
              prompt:
                `Nous sommes le ${new Date().toISOString().slice(0, 10)}. ` +
                "Extrais tous les événements futurs distincts visibles sur cette page de liste. " +
                "Une ligne par occurrence, jamais de texte de navigation ni d'événement inventé. " +
                `Utilise la date ISO 8601 avec le fuseau ${task.source.city?.timezone ?? "local indiqué par la source"}, ` +
                "le lien de la fiche détaillée comme sourceUrl, " +
                "l'image réelle de l'événement et les coordonnées uniquement lorsqu'elles sont explicites. " +
                "Renseigne genres, prix et capacité uniquement s'ils sont écrits dans la source; ne les devine jamais.",
            },
          ],
        }),
        signal: controller.signal,
      });
      const responseText = await response.text();
      let body: FirecrawlPayload = {};
      try {
        body = responseText ? (JSON.parse(responseText) as FirecrawlPayload) : {};
      } catch {
        body = {};
      }
      if (response.ok) return body;
      lastError = body.message ?? body.error ?? responseText.slice(0, 500) ?? "unknown_error";
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "firecrawl_request_failed";
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Firecrawl: ${lastError}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  if (!(await isAllowed(req, admin))) return json({ error: "unauthorized" }, 401);

  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY")?.trim();
  if (!firecrawlKey) return json({ error: "firecrawl_not_configured" }, 500);

  const body = (await req.json().catch(() => ({}))) as {
    cursor?: number;
    batchSize?: number;
    force?: boolean;
    runStartedAt?: string;
    sourceIds?: string[];
  };
  const cursor = safeInteger(body.cursor, 0, 10_000);
  const batchSize = Math.max(1, safeInteger(body.batchSize, 3, MAX_BATCH_SIZE));
  const force = body.force === true;
  const parsedRunStartedAt = body.runStartedAt ? Date.parse(body.runStartedAt) : Number.NaN;
  const runStartedAt = Number.isFinite(parsedRunStartedAt) ? parsedRunStartedAt : null;
  const sourceIds = Array.isArray(body.sourceIds)
    ? body.sourceIds.filter((value): value is string => typeof value === "string").slice(0, 50)
    : [];

  let sourceQuery = admin
    .from("data_sources")
    .select(
      "id,name,base_url,domain,page_count,priority,sync_frequency,last_sync_at,next_sync_at,updated_at,category_slug,metadata,city:cities(name,timezone)",
    )
    .eq("status", "active")
    .eq("is_authorized", true)
    .eq("is_verified", true)
    .order("priority", { ascending: true })
    .order("name", { ascending: true });
  if (sourceIds.length) sourceQuery = sourceQuery.in("id", sourceIds);
  const { data: sourceRows, error: sourcesError } = await sourceQuery;
  if (sourcesError) return json({ error: sourcesError.message }, 500);

  const sources = (sourceRows ?? []) as DataSource[];
  const tasks = sources
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
        const firecrawl = await scrapeWithFirecrawl(firecrawlKey, task);
        const events = Array.isArray(firecrawl.data?.json?.events)
          ? (firecrawl.data?.json?.events ?? [])
          : [];
        const markdown = firecrawl.data?.markdown ?? null;
        const contentHash = await sha256(markdown ?? JSON.stringify(firecrawl.data?.json ?? {}));

        const { data: record, error: recordError } = await admin
          .from("source_records")
          .insert({
            data_source_id: task.source.id,
            source_url: task.url,
            ingestion_job_id: job.id,
            raw_markdown: markdown,
            raw_json: firecrawl.data ?? null,
            content_hash: contentHash,
            extracted_data: { events },
            processing_status: "processed",
            processed_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (recordError) throw recordError;

        for (const event of events) {
          if (!event.title?.trim() || !isValidDate(event.startDate)) {
            rejected += 1;
            continue;
          }
          const sourceUrl = safeHttpUrl(event.sourceUrl, task.url);
          const ticketUrl = safeOptionalHttpUrl(event.ticketUrl, sourceUrl);
          const imageUrl = safeOptionalHttpUrl(event.imageUrl, sourceUrl);
          const { data: upserted, error: upsertError } = await admin.rpc("upsert_ingested_event", {
            _data_source_id: task.source.id,
            _source_url: sourceUrl,
            _title: event.title,
            _description: event.description ?? null,
            _starts_at: isoDate(event.startDate),
            _ends_at: isoDate(event.endDate),
            _venue_name: event.venueName ?? null,
            _address: event.address ?? null,
            _latitude: typeof event.latitude === "number" ? event.latitude : null,
            _longitude: typeof event.longitude === "number" ? event.longitude : null,
            _category: event.category ?? task.source.category_slug,
            _ticket_url: ticketUrl,
            _image_url: imageUrl,
            _is_free: event.isFree ?? false,
            _external_identifier: event.externalId ?? null,
          });
          if (upsertError) {
            rejected += 1;
            if (upsertErrors.length < 5) upsertErrors.push(upsertError.message.slice(0, 500));
            continue;
          }
          const outcome = Array.isArray(upserted) ? upserted[0] : upserted;
          if (outcome?.event_id) {
            const genres = normalizedGenres(event.genres);
            const capacity = optionalPositiveNumber(event.capacity, 1_000_000);
            const priceMin = optionalPositiveNumber(event.priceMin, 100_000);
            const priceMax = optionalPositiveNumber(event.priceMax, 100_000);
            const currency =
              typeof event.currency === "string" && /^[A-Z]{3}$/.test(event.currency.toUpperCase())
                ? event.currency.toUpperCase()
                : "CHF";

            if (genres.length) {
              const { error: genreError } = await admin
                .from("events")
                .update({ genres })
                .eq("id", outcome.event_id);
              if (genreError && upsertErrors.length < 5) {
                upsertErrors.push(`genres: ${genreError.message.slice(0, 450)}`);
              }
            }

            const occurrenceUpdate = {
              timezone: task.source.city?.timezone ?? "Europe/Zurich",
              ...(capacity != null ? { capacity: Math.round(capacity) } : {}),
            };
            {
              const { error: capacityError } = await admin
                .from("event_occurrences")
                .update(occurrenceUpdate)
                .eq("event_id", outcome.event_id)
                .eq("starts_at", isoDate(event.startDate)!);
              if (capacityError && upsertErrors.length < 5) {
                upsertErrors.push(`capacity: ${capacityError.message.slice(0, 450)}`);
              }
            }

            if (priceMin != null || priceMax != null) {
              const { data: offer } = await admin
                .from("ticket_offers")
                .select("id")
                .eq("event_id", outcome.event_id)
                .order("id", { ascending: true })
                .limit(1)
                .maybeSingle();
              const ticketData = {
                price_min: priceMin ?? priceMax,
                price_max: priceMax ?? priceMin,
                currency,
                is_free: event.isFree === true,
              };
              const ticketResult = offer
                ? await admin.from("ticket_offers").update(ticketData).eq("id", offer.id)
                : await admin.from("ticket_offers").insert({
                    event_id: outcome.event_id,
                    name: "Billet standard",
                    ticket_url: ticketUrl,
                    status: ticketUrl ? "available" : "unknown",
                    ...ticketData,
                  });
              if (ticketResult.error && upsertErrors.length < 5) {
                upsertErrors.push(`price: ${ticketResult.error.message.slice(0, 450)}`);
              }
            }
          }
          if (outcome?.action === "created") created += 1;
          else updated += 1;
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
          extracted: events.length,
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
                    Date.now() + (task.source.sync_frequency === "weekly" ? 24 : 6) * 3_600_000,
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
