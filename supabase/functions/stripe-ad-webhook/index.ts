import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyStripeSignature } from "../_shared/stripe-signature.ts";

Deno.serve(async (request) => {
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  if (!(await verifyStripeSignature(payload, signature, secret)))
    return new Response("Invalid signature", { status: 400 });
  try {
    const event = JSON.parse(payload);
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { error } = await admin.rpc("process_stripe_ad_event", {
      _event_id: event.id,
      _event_type: event.type,
      _session: event.data?.object ?? {},
    });
    if (error) throw error;
    return new Response("ok");
  } catch (error) {
    console.error("Stripe webhook processing failed", error);
    // A non-2xx response asks Stripe to retry instead of silently losing payment state.
    return new Response("Webhook processing failed", { status: 500 });
  }
});
