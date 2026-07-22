import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fallbackDraft, normalizeAdDraft, type EventInsight } from "../_shared/ad-draft.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = request.headers.get("Authorization") ?? "";
    const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const {
      data: { user },
    } = await client.auth.getUser();
    if (!user) throw new Error("Authentication required");
    const { organizerId } = await request.json();
    const { data: insights, error } = await client.rpc("get_organizer_event_ad_insights", {
      _organizer_id: organizerId,
    });
    if (error) throw error;
    if (!insights?.length)
      throw new Error("Publie au moins un événement pour générer une campagne.");
    const eligibleInsights = insights.slice(0, 8) as EventInsight[];
    const fallback = fallbackDraft(eligibleInsights[0]);
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey)
      return Response.json(
        { draft: fallback, source: "fallback", warning: "OpenAI non configuré" },
        { headers: cors },
      );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: Deno.env.get("OPENAI_AD_MODEL") || "gpt-5-mini",
          instructions:
            "Tu es un expert publicitaire événementiel. Réponds uniquement avec un JSON valide respectant exactement le schéma. N'invente aucun événement ni chiffre.",
          input: `Prépare un brouillon en français à partir de ces statistiques agrégées: ${JSON.stringify(eligibleInsights)}`,
          text: {
            format: {
              type: "json_schema",
              name: "ad_draft",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                required: [
                  "name",
                  "objective",
                  "promotedEventId",
                  "headline",
                  "body",
                  "imageUrl",
                  "ctaUrl",
                  "genres",
                  "cityIds",
                  "rationale",
                ],
                properties: {
                  name: { type: "string" },
                  objective: {
                    type: "string",
                    enum: ["awareness", "engagement", "event_visits", "ticket_sales"],
                  },
                  promotedEventId: { type: "string" },
                  headline: { type: "string" },
                  body: { type: "string" },
                  imageUrl: { type: "string" },
                  ctaUrl: { type: "string" },
                  genres: { type: "array", items: { type: "string" } },
                  cityIds: { type: "array", items: { type: "string" } },
                  rationale: { type: "string" },
                },
              },
            },
          },
        }),
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const requestId = response.headers.get("x-request-id");
      console.error("OpenAI generation failed", response.status, requestId, await response.text());
      throw new Error(
        `OpenAI indisponible (${response.status}${requestId ? `, requête ${requestId}` : ""})`,
      );
    }
    const result = (await response.json()) as {
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const text = result.output
      ?.flatMap((item) => item.content ?? [])
      .find((item) => item.type === "output_text")?.text;
    if (!text) throw new Error("OpenAI n’a retourné aucun brouillon");
    return Response.json(
      { draft: normalizeAdDraft(JSON.parse(text), eligibleInsights), source: "openai" },
      { headers: cors },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Generation failed" },
      { status: 400, headers: cors },
    );
  }
});
