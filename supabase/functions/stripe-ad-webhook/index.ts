import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

Deno.serve(async (request) => {
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  const parts = Object.fromEntries(signature.split(",").map((part) => part.split("=", 2)));
  const timestamp = parts.t;
  const expected = parts.v1;
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  if (!timestamp || !expected || !secret || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
    return new Response("Invalid signature", { status: 400 });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const computed = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (!safeEqual(computed, expected)) return new Response("Invalid signature", { status: 400 });
  const event = JSON.parse(payload);
  if (
    [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
    ].includes(event.type)
  ) {
    const session = event.data.object;
    const paid =
      event.type !== "checkout.session.async_payment_failed" && session.payment_status === "paid";
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    await admin
      .from("ad_campaigns")
      .update(
        paid
          ? {
              payment_status: "paid",
              status: "active",
              paid_at: new Date().toISOString(),
              stripe_payment_intent_id: session.payment_intent,
            }
          : { payment_status: "failed", status: "draft" },
      )
      .eq("stripe_checkout_session_id", session.id)
      .eq("id", session.metadata?.campaign_id);
  }
  return new Response("ok");
});
