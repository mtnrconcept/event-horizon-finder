// Paid extraction providers are intentionally disabled.
// Worldwide discovery and supported ingestion use direct, robots-gated fetches only.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  return new Response(
    JSON.stringify({
      ok: false,
      error: "paid_provider_disabled",
      replacement: "global-event-discovery",
    }),
    { status: 410, headers: cors },
  );
});
