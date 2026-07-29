import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyStripeSignature } from "../_shared/stripe-signature.ts";

const AD_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
]);

const BILLING_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  if (!(await verifyStripeSignature(payload, signature, secret)))
    return new Response("Invalid signature", { status: 400 });
  try {
    const event = JSON.parse(payload);
    const object = event.data?.object ?? {};
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const isSubscriptionCheckout =
      event.type === "checkout.session.completed" && object.mode === "subscription";
    const isAdCheckout =
      event.type.startsWith("checkout.session.") && object.mode !== "subscription";

    if (AD_EVENT_TYPES.has(event.type) && (event.type === "charge.refunded" || isAdCheckout)) {
      const { error } = await admin.rpc("process_stripe_ad_event", {
        _event_id: event.id,
        _event_type: event.type,
        _session: object,
      });
      if (error) throw error;
    }

    if (
      BILLING_EVENT_TYPES.has(event.type) &&
      (event.type !== "checkout.session.completed" || isSubscriptionCheckout)
    ) {
      const { error } = await admin.rpc("process_stripe_billing_event", {
        _event_id: event.id,
        _event_type: event.type,
        _object: object,
      });
      if (error) throw error;
    }

    return new Response("ok");
  } catch (error) {
    console.error("Stripe webhook processing failed", error);
    // A non-2xx response asks Stripe to retry instead of silently losing payment state.
    return new Response("Webhook processing failed", { status: 500 });
  }
});
