// Scheduled Geneva event scraper using Firecrawl.
// Auth: accepts a configured job secret or an authenticated admin/moderator user.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ALLOWED_ORIGINS") ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-geneva-scraper-secret",
  "Content-Type": "application/json",
};

const GENEVA_SOURCES = [
  "https://www.geneve.ch/agenda",
  "https://billetterie-culture.geneve.ch/list/events?lang=fr",
  "https://ladecadanse.darksite.ch/agenda.php?region=ge",
];

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: ["string", "null"] },
          startDate: { type: ["string", "null"] },
          endDate: { type: ["string", "null"] },
          venueName: { type: ["string", "null"] },
          address: { type: ["string", "null"] },
          latitude: { type: ["number", "null"] },
          longitude: { type: ["number", "null"] },
          category: { type: ["string", "null"] },
          ticketUrl: { type: ["string", "null"] },
          imageUrl: { type: ["string", "null"] },
          isFree: { type: ["boolean", "null"] },
          sourceUrl: { type: ["string", "null"] },
        },
        required: ["title"],
      },
    },
  },
  required: ["events"],
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function isAllowed(req: Request, admin: ReturnType<typeof createClient>): Promise<boolean> {
  const configuredSecret = Deno.env.get("GENEVA_SCRAPER_SECRET");
  const providedSecret = req.headers.get("x-geneva-scraper-secret");
  if (configuredSecret && providedSecret === configuredSecret) return true;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return false;
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: authHeader } },
    },
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST")
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: cors,
    });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  if (!(await isAllowed(req, admin)))
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: cors });

  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!firecrawlKey)
    return new Response(JSON.stringify({ error: "firecrawl_not_configured" }), {
      status: 500,
      headers: cors,
    });

  const { sources = GENEVA_SOURCES } = await req.json().catch(() => ({}));
  const { data: job, error: jobError } = await admin
    .from("ingestion_jobs")
    .insert({ status: "running", started_at: new Date().toISOString(), metadata: { sources } })
    .select("id")
    .single();
  if (jobError)
    return new Response(JSON.stringify({ error: jobError.message }), {
      status: 500,
      headers: cors,
    });

  let created = 0;
  let failed = 0;
  for (const url of sources as string[]) {
    try {
      const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { Authorization: `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          formats: ["markdown", { type: "json", schema: EXTRACTION_SCHEMA }],
        }),
      });
      const responseText = await response.text();
      let body: Record<string, unknown> | null = null;
      try {
        body = responseText ? JSON.parse(responseText) : null;
      } catch {
        body = null;
      }
      if (!response.ok) {
        const message =
          typeof body?.message === "string"
            ? body.message
            : typeof body?.error === "string"
              ? body.error
              : responseText.slice(0, 500);
        throw new Error(`Firecrawl ${response.status}: ${message || "unknown error"}`);
      }
      const events = body?.data?.json?.events ?? [];
      await admin.from("source_records").insert({
        source_url: url,
        ingestion_job_id: job.id,
        raw_markdown: body?.data?.markdown ?? null,
        raw_json: body?.data ?? null,
        extracted_data: { events },
        processing_status: "processed",
      });
      for (const event of events) {
        if (!event?.title || !event?.startDate) continue;
        const slug = `${slugify(event.title)}-${slugify(String(event.startDate).slice(0, 10))}`;
        const { data: upserted } = await admin
          .from("events")
          .upsert(
            {
              slug,
              title: event.title,
              short_description: event.description ?? null,
              description: event.description ?? null,
              status: "pending_review",
              publication_status: "draft",
              is_free: event.isFree ?? false,
              official_url: event.sourceUrl ?? event.ticketUrl ?? url,
              cover_image_url: event.imageUrl ?? null,
              source_confidence: 70,
              language: "fr",
            },
            { onConflict: "slug" },
          )
          .select("id")
          .single();
        if (upserted?.id) {
          await admin.from("event_occurrences").upsert(
            {
              event_id: upserted.id,
              starts_at: event.startDate,
              ends_at: event.endDate ?? null,
              timezone: "Europe/Zurich",
              latitude: event.latitude ?? null,
              longitude: event.longitude ?? null,
            },
            { onConflict: "event_id,starts_at" },
          );
          created += 1;
        }
      }
    } catch (error) {
      failed += 1;
      await admin.from("ingestion_job_items").insert({
        ingestion_job_id: job.id,
        url,
        status: "failed",
        error_message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  await admin
    .from("ingestion_jobs")
    .update({
      status: failed ? "partially_completed" : "completed",
      finished_at: new Date().toISOString(),
      pages_found: sources.length,
      pages_success: sources.length - failed,
      pages_failed: failed,
      events_created: created,
    })
    .eq("id", job.id);
  return new Response(JSON.stringify({ ok: true, jobId: job.id, eventsCreated: created, failed }), {
    headers: cors,
  });
});
