import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = "supabase/migrations/20260729111940_organizer_subscription_foundation.sql";

test("organizer plans remain server-authoritative and use minor currency units", async () => {
  const migration = await readFile(migrationPath, "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.monetization_plans/);
  assert.match(migration, /'pro'[\s\S]*?\b2900\b[\s\S]*?\b29000\b[\s\S]*?'CHF'/);
  assert.match(migration, /'business'[\s\S]*?\b7900\b[\s\S]*?\b79000\b[\s\S]*?'CHF'/);
  assert.match(migration, /monthly_amount_minor integer NOT NULL/);
  assert.match(migration, /annual_amount_minor integer NOT NULL/);
});

test("billing state and Stripe replay ledgers are not client-writable", async () => {
  const migration = await readFile(migrationPath, "utf8");
  assert.match(migration, /ALTER TABLE public\.organizer_subscriptions ENABLE ROW LEVEL SECURITY/);
  assert.match(
    migration,
    /REVOKE ALL ON public\.organizer_subscriptions FROM PUBLIC, anon, authenticated/,
  );
  assert.match(migration, /GRANT SELECT ON public\.organizer_subscriptions TO authenticated/);
  assert.match(migration, /membership\.role IN \('owner', 'admin'\)/);
  assert.match(migration, /ALTER TABLE private\.stripe_billing_events ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE private\.stripe_ad_events ENABLE ROW LEVEL SECURITY/);
  assert.match(
    migration,
    /process_stripe_billing_event[\s\S]*?GRANT EXECUTE[\s\S]*?TO service_role/,
  );
});

test("checkout preparation serializes concurrent attempts and rejects active subscriptions", async () => {
  const migration = await readFile(migrationPath, "utf8");
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /status = 'checkout_pending'/);
  assert.match(migration, /A subscription checkout is already pending/);
  assert.match(migration, /An existing subscription must be managed from the billing portal/);
  assert.match(migration, /stripe_checkout_session_id = _object ->> 'id'/);
  assert.match(migration, /checkout_token = checkout_token_value/);
});

test("subscription checkout binds account, amount, currency and organization", async () => {
  const checkout = await readFile(
    "supabase/functions/create-organizer-subscription-checkout/index.ts",
    "utf8",
  );
  assert.match(checkout, /Deno\.env\.get\("STRIPE_ACCOUNT_ID"\)/);
  assert.match(checkout, /api\.stripe\.com\/v1\/account/);
  assert.match(checkout, /account\?\.id !== expectedAccountId/);
  assert.match(checkout, /metadata\[organizer_id\]/);
  assert.match(checkout, /metadata\[checkout_token\]/);
  assert.match(checkout, /Idempotency-Key/);
  assert.match(checkout, /\.in\("role", \["owner", "admin"\]\)/);
  assert.match(checkout, /requestedReturn|safeReturnUrl/);
});

test("the verified webhook separates ad and subscription events", async () => {
  const webhook = await readFile("supabase/functions/stripe-ad-webhook/index.ts", "utf8");
  assert.match(webhook, /AD_EVENT_TYPES/);
  assert.match(webhook, /BILLING_EVENT_TYPES/);
  assert.match(webhook, /object\.mode === "subscription"/);
  assert.match(webhook, /process_stripe_ad_event/);
  assert.match(webhook, /process_stripe_billing_event/);
  assert.match(webhook, /verifyStripeSignature/);
});

test("browser billing code never references Stripe secrets", async () => {
  const browserFiles = await Promise.all([
    readFile("src/lib/monetization.ts", "utf8"),
    readFile("src/routes/organizer/billing.tsx", "utf8"),
  ]);
  for (const source of browserFiles) {
    assert.doesNotMatch(source, /STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|service_role/);
  }
});
