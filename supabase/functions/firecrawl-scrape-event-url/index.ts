// Firecrawl scrape - extract a single event page.
// Auth: only authenticated users; validates domain via source_domains.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    eventTitle: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    startDate: { type: ["string", "null"] },
    endDate: { type: ["string", "null"] },
    doorsOpen: { type: ["string", "null"] },
    timezone: { type: ["string", "null"] },
    venue: { type: "object" },
    organizer: { type: "object" },
    performers: { type: "array" },
    category: { type: ["string", "null"] },
    genres: { type: "array" },
    price: { type: "object" },
    ticketUrl: { type: ["string", "null"] },
    imageUrls: { type: "array" },
    ageRestriction: { type: ["string", "null"] },
    accessibility: { type: "array" },
    language: { type: ["string", "null"] },
    status: {
      type: "string",
      enum: ["scheduled", "cancelled", "postponed", "sold_out", "unknown"],
    },
    sourceUrl: { type: "string" },
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader)
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...cors, "content-type": "application/json" },
      });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user)
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...cors, "content-type": "application/json" },
      });

    const { url } = await req.json();
    if (typeof url !== "string")
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { ...cors, "content-type": "application/json" },
      });

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return new Response(JSON.stringify({ error: "invalid_url" }), { status: 400, headers: cors });
    }
    if (parsed.protocol !== "https:")
      return new Response(JSON.stringify({ error: "https_required" }), {
        status: 400,
        headers: cors,
      });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: domain } = await admin
      .from("source_domains")
      .select("is_authorized")
      .eq("domain", parsed.hostname)
      .maybeSingle();
    if (!domain?.is_authorized)
      return new Response(JSON.stringify({ error: "domain_not_authorized" }), {
        status: 403,
        headers: cors,
      });

    const key = Deno.env.get("FIRECRAWL_API_KEY");
    if (!key)
      return new Response(JSON.stringify({ error: "firecrawl_not_configured" }), {
        status: 500,
        headers: cors,
      });

    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        formats: ["markdown", { type: "json", schema: EXTRACTION_SCHEMA }],
      }),
    });
    const responseText = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = responseText ? JSON.parse(responseText) : null;
    } catch {
      body = null;
    }
    if (res.status === 429) {
      return new Response(
        JSON.stringify({ error: "rate_limited", retryAfter: res.headers.get("Retry-After") }),
        { status: 429, headers: cors },
      );
    }
    if (!res.ok) {
      const message =
        typeof body?.message === "string"
          ? body.message
          : typeof body?.error === "string"
            ? body.error
            : responseText.slice(0, 500);
      return new Response(
        JSON.stringify({ error: "firecrawl_error", status: res.status, message }),
        { status: res.status, headers: { ...cors, "content-type": "application/json" } },
      );
    }

    await admin.from("source_records").insert({
      source_url: url,
      raw_markdown: body?.data?.markdown ?? null,
      raw_json: body?.data ?? null,
      extracted_data: body?.data?.json ?? null,
      content_hash: null,
      processing_status: "pending",
    });

    return new Response(JSON.stringify({ ok: true, data: body?.data ?? null }), {
      headers: { ...cors, "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "unknown" }), {
      status: 500,
      headers: { ...cors, "content-type": "application/json" },
    });
  }
});
