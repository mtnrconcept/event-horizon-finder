import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type BillingPeriod = "monthly" | "annual";

type PlanRow = {
  code: string;
  name: string;
  monthly_amount_minor: number;
  annual_amount_minor: number;
  currency: string;
  stripe_monthly_price_id: string | null;
  stripe_annual_price_id: string | null;
  is_contact_sales: boolean;
};

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

async function stripeRequest(
  path: string,
  body: URLSearchParams,
  stripeKey: string,
  idempotencyKey: string,
) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? "Stripe Checkout failed");
  return payload;
}

async function verifyStripeAccount(stripeKey: string, expectedAccountId: string) {
  const response = await fetch("https://api.stripe.com/v1/account", {
    headers: { Authorization: `Bearer ${stripeKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  const account = await response.json();
  if (!response.ok || account?.id !== expectedAccountId) {
    throw new Error("Stripe account configuration mismatch");
  }
}

Deno.serve(async (request) => {
  const headers = responseHeaders(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const stripeAccountId = Deno.env.get("STRIPE_ACCOUNT_ID") ?? "";

  if (!supabaseUrl || !anonKey || !serviceKey || !stripeKey || !stripeAccountId) {
    return Response.json(
      { error: "Subscription billing is not configured" },
      { status: 503, headers },
    );
  }

  let organizerId = "";
  let checkoutToken = "";
  const admin = createClient(supabaseUrl, serviceKey);

  try {
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
    organizerId = typeof input?.organizerId === "string" ? input.organizerId : "";
    const planCode = typeof input?.planCode === "string" ? input.planCode : "";
    const billingPeriod: BillingPeriod = input?.billingPeriod === "annual" ? "annual" : "monthly";
    const returnUrl = safeReturnUrl(request, input?.returnUrl);

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        organizerId,
      ) ||
      !/^[a-z][a-z0-9_-]{1,31}$/.test(planCode)
    ) {
      throw new Error("Invalid subscription request");
    }

    const { data: membership, error: membershipError } = await userClient
      .from("organizer_members")
      .select("role")
      .eq("organizer_id", organizerId)
      .eq("user_id", user.id)
      .in("role", ["owner", "admin"])
      .maybeSingle();
    if (membershipError || !membership) throw new Error("Billing access required");

    const { data: planData, error: planError } = await admin
      .from("monetization_plans")
      .select(
        "code,name,monthly_amount_minor,annual_amount_minor,currency,stripe_monthly_price_id,stripe_annual_price_id,is_contact_sales",
      )
      .eq("code", planCode)
      .eq("audience", "organizer")
      .eq("is_active", true)
      .single();
    if (planError || !planData) throw new Error("Subscription plan unavailable");
    const plan = planData as PlanRow;
    if (plan.is_contact_sales || plan.code === "starter") {
      throw new Error("This plan does not use self-service checkout");
    }

    const amount =
      billingPeriod === "annual"
        ? Number(plan.annual_amount_minor)
        : Number(plan.monthly_amount_minor);
    const priceId =
      billingPeriod === "annual" ? plan.stripe_annual_price_id : plan.stripe_monthly_price_id;
    if (!Number.isSafeInteger(amount) || amount < 100) {
      throw new Error("Invalid subscription amount");
    }

    await verifyStripeAccount(stripeKey, stripeAccountId);

    const { data: preparedRows, error: prepareError } = await admin.rpc(
      "prepare_organizer_subscription_checkout",
      {
        _organizer_id: organizerId,
        _plan_code: plan.code,
        _billing_period: billingPeriod,
      },
    );
    const prepared = Array.isArray(preparedRows) ? preparedRows[0] : preparedRows;
    if (prepareError || !prepared?.checkout_token) {
      throw new Error(prepareError?.message ?? "Unable to prepare subscription checkout");
    }
    checkoutToken = String(prepared.checkout_token);

    const successUrl = new URL(returnUrl);
    successUrl.searchParams.set("subscription", "success");
    const cancelUrl = new URL(returnUrl);
    cancelUrl.searchParams.set("subscription", "cancelled");

    const body = new URLSearchParams({
      mode: "subscription",
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
      client_reference_id: organizerId,
      "line_items[0][quantity]": "1",
      "metadata[organizer_id]": organizerId,
      "metadata[plan_code]": plan.code,
      "metadata[billing_period]": billingPeriod,
      "metadata[checkout_token]": checkoutToken,
      "metadata[stripe_account_id]": stripeAccountId,
      "subscription_data[metadata][organizer_id]": organizerId,
      "subscription_data[metadata][plan_code]": plan.code,
      "subscription_data[metadata][billing_period]": billingPeriod,
      "subscription_data[metadata][stripe_account_id]": stripeAccountId,
    });

    if (prepared.stripe_customer_id) {
      body.set("customer", String(prepared.stripe_customer_id));
    } else if (user.email) {
      body.set("customer_email", user.email);
    }

    if (priceId) {
      body.set("line_items[0][price]", priceId);
    } else {
      body.set("line_items[0][price_data][currency]", plan.currency.toLowerCase());
      body.set("line_items[0][price_data][unit_amount]", String(amount));
      body.set(
        "line_items[0][price_data][recurring][interval]",
        billingPeriod === "annual" ? "year" : "month",
      );
      body.set("line_items[0][price_data][product_data][name]", `Global Party ${plan.name}`);
    }

    const session = await stripeRequest(
      "checkout/sessions",
      body,
      stripeKey,
      `organizer-subscription-${organizerId}-${checkoutToken}`,
    );

    const { data: updatedSubscription, error: updateError } = await admin
      .from("organizer_subscriptions")
      .update({
        stripe_account_id: stripeAccountId,
        stripe_checkout_session_id: session.id,
        updated_at: new Date().toISOString(),
      })
      .eq("organizer_id", organizerId)
      .eq("checkout_token", checkoutToken)
      .eq("status", "checkout_pending")
      .select("organizer_id")
      .single();
    if (updateError || !updatedSubscription) {
      throw updateError ?? new Error("Subscription checkout state changed");
    }

    return Response.json({ url: session.url }, { headers });
  } catch (error) {
    if (organizerId && checkoutToken) {
      await admin.rpc("fail_organizer_subscription_checkout", {
        _organizer_id: organizerId,
        _checkout_token: checkoutToken,
      });
    }
    const message = error instanceof Error ? error.message : "Subscription checkout failed";
    const status = /Authentication|required|access/i.test(message) ? 401 : 400;
    return Response.json({ error: message }, { status, headers });
  }
});
