import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = request.headers.get("Authorization") ?? "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const client = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const {
      data: { user },
    } = await client.auth.getUser();
    if (!user) throw new Error("Authentication required");
    const { campaignId, returnUrl } = await request.json();
    const configuredOrigin = new URL(Deno.env.get("SITE_URL") || new URL(request.url).origin)
      .origin;
    const requestedReturn = new URL(returnUrl || configuredOrigin);
    if (requestedReturn.origin !== configuredOrigin) throw new Error("Invalid return URL");
    const successUrl = new URL(requestedReturn);
    successUrl.searchParams.set("payment", "success");
    const cancelUrl = new URL(requestedReturn);
    cancelUrl.searchParams.set("payment", "cancelled");
    const { data: campaign, error } = await client
      .from("ad_campaigns")
      .select("id,name,total_budget,currency,organizer_id,payment_status,checkout_attempt")
      .eq("id", campaignId)
      .single();
    if (error || !campaign) throw new Error("Campaign not found or forbidden");
    if (campaign.payment_status === "paid") throw new Error("Campaign already paid");
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("Stripe is not configured");
    const amount = Math.round(Number(campaign.total_budget) * 100);
    if (!Number.isSafeInteger(amount) || amount < 100) throw new Error("Invalid campaign budget");
    const body = new URLSearchParams({
      mode: "payment",
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": String(campaign.currency).toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(amount),
      "line_items[0][price_data][product_data][name]": `Campagne publicitaire — ${campaign.name}`,
      "metadata[campaign_id]": campaign.id,
      "metadata[user_id]": user.id,
      "payment_intent_data[metadata][campaign_id]": campaign.id,
    });
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `ad-checkout-${campaign.id}-${Number(campaign.checkout_attempt || 0) + 1}`,
      },
      body,
    });
    const session = await response.json();
    if (!response.ok) throw new Error(session?.error?.message ?? "Stripe checkout failed");
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error: updateError } = await admin
      .from("ad_campaigns")
      .update({
        status: "pending_payment",
        payment_status: "pending",
        stripe_checkout_session_id: session.id,
        checkout_attempt: Number(campaign.checkout_attempt || 0) + 1,
      })
      .eq("id", campaign.id);
    if (updateError) throw updateError;
    return Response.json({ url: session.url }, { headers: cors });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Checkout failed" },
      { status: 400, headers: cors },
    );
  }
});
