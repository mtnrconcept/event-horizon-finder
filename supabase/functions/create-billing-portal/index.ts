import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function responseHeaders(request: Request) {
  const configuredOrigin = new URL(Deno.env.get("SITE_URL") || new URL(request.url).origin).origin;
  return {
    "Access-Control-Allow-Origin": configuredOrigin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    Vary: "Origin",
  };
}

function safeReturnUrl(request: Request, value: unknown) {
  const configuredOrigin = new URL(Deno.env.get("SITE_URL") || new URL(request.url).origin).origin;
  const candidate = new URL(typeof value === "string" && value ? value : configuredOrigin);
  if (candidate.origin !== configuredOrigin) throw new Error("Invalid return URL");
  return candidate;
}

Deno.serve(async (request) => {
  const headers = responseHeaders(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
    if (!supabaseUrl || !anonKey || !serviceKey || !stripeKey) {
      throw new Error("Billing portal is not configured");
    }

    const auth = request.headers.get("Authorization") ?? "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: auth } },
    });
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();
    if (userError || !user) throw new Error("Authentication required");

    const input = await request.json();
    const organizerId = typeof input?.organizerId === "string" ? input.organizerId : "";
    const returnUrl = safeReturnUrl(request, input?.returnUrl);

    const { data: membership, error: membershipError } = await userClient
      .from("organizer_members")
      .select("role")
      .eq("organizer_id", organizerId)
      .eq("user_id", user.id)
      .in("role", ["owner", "admin"])
      .maybeSingle();
    if (membershipError || !membership) throw new Error("Billing access required");

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: subscription, error: subscriptionError } = await admin
      .from("organizer_subscriptions")
      .select("stripe_customer_id")
      .eq("organizer_id", organizerId)
      .single();
    if (subscriptionError || !subscription?.stripe_customer_id) {
      throw new Error("No Stripe customer is attached to this organization");
    }

    const response = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        customer: subscription.stripe_customer_id,
        return_url: returnUrl.toString(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.message ?? "Stripe billing portal failed");
    }

    return Response.json({ url: payload.url }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Billing portal failed";
    const status = /Authentication|required|access/i.test(message) ? 401 : 400;
    return Response.json({ error: message }, { status, headers });
  }
});
