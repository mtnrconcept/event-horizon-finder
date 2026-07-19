// Firecrawl callbacks are no longer accepted because paid extraction providers
// are disabled across the supported scraper path.
Deno.serve((req: Request) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  return new Response(JSON.stringify({ ok: false, error: "paid_provider_disabled" }), {
    status: 410,
    headers: { "Content-Type": "application/json" },
  });
});
