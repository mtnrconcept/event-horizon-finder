// Firecrawl webhook - verifies HMAC signature, idempotent via webhook_id.
import { createClient } from "npm:@supabase/supabase-js@2";

async function verifyHmac(secret: string, body: string, sig: string | null): Promise<boolean> {
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // timing-safe compare
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  const bodyText = await req.text();
  const secret = Deno.env.get("FIRECRAWL_WEBHOOK_SECRET");
  if (!secret) return new Response("not_configured", { status: 500 });
  const sig = req.headers.get("X-Firecrawl-Signature");
  const ok = await verifyHmac(secret, bodyText, sig);
  if (!ok) return new Response("invalid_signature", { status: 401 });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return new Response("bad_json", { status: 400 });
  }
  const webhookId = String(payload.id ?? payload.webhookId ?? crypto.randomUUID());

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { error } = await admin.from("source_records").insert({
    source_url: String(payload.url ?? payload.sourceUrl ?? ""),
    raw_json: payload,
    processing_status: "pending",
    webhook_id: webhookId,
  });
  if (error && !String(error.message).includes("duplicate")) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  });
});
