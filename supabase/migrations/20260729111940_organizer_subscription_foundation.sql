-- Organizer subscription foundation for Global Party.
-- Additive by design: the existing paid advertising lifecycle remains unchanged.

CREATE TABLE IF NOT EXISTS public.monetization_plans (
  code text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  audience text NOT NULL DEFAULT 'organizer',
  monthly_amount_minor integer NOT NULL DEFAULT 0,
  annual_amount_minor integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'CHF',
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  stripe_product_id text,
  stripe_monthly_price_id text,
  stripe_annual_price_id text,
  is_active boolean NOT NULL DEFAULT true,
  is_contact_sales boolean NOT NULL DEFAULT false,
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monetization_plans_code_check
    CHECK (code ~ '^[a-z][a-z0-9_-]{1,31}$'),
  CONSTRAINT monetization_plans_audience_check
    CHECK (audience IN ('organizer', 'consumer', 'business')),
  CONSTRAINT monetization_plans_amount_check
    CHECK (monthly_amount_minor >= 0 AND annual_amount_minor >= 0),
  CONSTRAINT monetization_plans_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT monetization_plans_features_check
    CHECK (jsonb_typeof(features) = 'array' AND jsonb_array_length(features) <= 24),
  CONSTRAINT monetization_plans_limits_check
    CHECK (jsonb_typeof(limits) = 'object' AND pg_column_size(limits) <= 8192),
  CONSTRAINT monetization_plans_paid_price_check
    CHECK (
      is_contact_sales
      OR code = 'starter'
      OR monthly_amount_minor > 0
      OR annual_amount_minor > 0
    )
);

INSERT INTO public.monetization_plans (
  code, name, description, monthly_amount_minor, annual_amount_minor, currency,
  features, limits, is_active, is_contact_sales, sort_order
) VALUES
  (
    'starter',
    'Starter',
    'Publier des événements et découvrir les outils organisateur.',
    0,
    0,
    'CHF',
    '["1 organisation","10 événements actifs","Statistiques essentielles","Campagnes publicitaires à la carte"]'::jsonb,
    '{"organizations":1,"active_events":10,"team_members":1}'::jsonb,
    true,
    false,
    10
  ),
  (
    'pro',
    'Pro',
    'Accélérer la visibilité et piloter une programmation régulière.',
    2900,
    29000,
    'CHF',
    '["Événements actifs illimités","3 collaborateurs","Statistiques avancées","Traduction et assistance IA","Badge organisateur Pro"]'::jsonb,
    '{"organizations":1,"active_events":-1,"team_members":3}'::jsonb,
    true,
    false,
    20
  ),
  (
    'business',
    'Business',
    'Centraliser plusieurs lieux et exploiter les données de performance.',
    7900,
    79000,
    'CHF',
    '["5 organisations ou lieux","15 collaborateurs","Exports et rapports","Priorité support","Crédits promotionnels mensuels"]'::jsonb,
    '{"organizations":5,"active_events":-1,"team_members":15}'::jsonb,
    true,
    false,
    30
  ),
  (
    'enterprise',
    'Enterprise',
    'API, marque blanche, sponsoring territorial et accompagnement dédié.',
    0,
    0,
    'CHF',
    '["Accès API sous contrat","Widgets en marque blanche","SLA et support dédié","Facturation et conditions personnalisées"]'::jsonb,
    '{"organizations":-1,"active_events":-1,"team_members":-1}'::jsonb,
    true,
    true,
    40
  )
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  monthly_amount_minor = EXCLUDED.monthly_amount_minor,
  annual_amount_minor = EXCLUDED.annual_amount_minor,
  currency = EXCLUDED.currency,
  features = EXCLUDED.features,
  limits = EXCLUDED.limits,
  is_active = EXCLUDED.is_active,
  is_contact_sales = EXCLUDED.is_contact_sales,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

ALTER TABLE public.monetization_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.monetization_plans FROM PUBLIC;
GRANT SELECT ON public.monetization_plans TO anon, authenticated;
GRANT ALL ON public.monetization_plans TO service_role;

DROP POLICY IF EXISTS monetization_plans_public_read ON public.monetization_plans;
CREATE POLICY monetization_plans_public_read
ON public.monetization_plans
FOR SELECT
TO anon, authenticated
USING (is_active);

CREATE TABLE IF NOT EXISTS public.organizer_subscriptions (
  organizer_id uuid PRIMARY KEY REFERENCES public.organizers(id) ON DELETE CASCADE,
  plan_code text NOT NULL DEFAULT 'starter'
    REFERENCES public.monetization_plans(code) ON UPDATE CASCADE,
  status text NOT NULL DEFAULT 'free',
  billing_period text NOT NULL DEFAULT 'monthly',
  stripe_account_id text,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_checkout_session_id text,
  checkout_token uuid,
  checkout_attempt integer NOT NULL DEFAULT 0,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizer_subscriptions_status_check CHECK (
    status IN (
      'free', 'checkout_pending', 'trialing', 'active', 'past_due',
      'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled'
    )
  ),
  CONSTRAINT organizer_subscriptions_period_check
    CHECK (billing_period IN ('monthly', 'annual')),
  CONSTRAINT organizer_subscriptions_checkout_attempt_check
    CHECK (checkout_attempt >= 0),
  CONSTRAINT organizer_subscriptions_stripe_shape_check CHECK (
    (status = 'free' AND stripe_subscription_id IS NULL)
    OR status <> 'free'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS organizer_subscriptions_customer_uidx
  ON public.organizer_subscriptions (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS organizer_subscriptions_subscription_uidx
  ON public.organizer_subscriptions (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS organizer_subscriptions_checkout_uidx
  ON public.organizer_subscriptions (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS organizer_subscriptions_status_period_idx
  ON public.organizer_subscriptions (status, current_period_end);

ALTER TABLE public.organizer_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organizer_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.organizer_subscriptions TO authenticated;
GRANT ALL ON public.organizer_subscriptions TO service_role;

DROP POLICY IF EXISTS organizer_subscriptions_member_read ON public.organizer_subscriptions;
CREATE POLICY organizer_subscriptions_member_read
ON public.organizer_subscriptions
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.organizer_members AS membership
    WHERE membership.organizer_id = organizer_subscriptions.organizer_id
      AND membership.user_id = (SELECT auth.uid())
      AND membership.role IN ('owner', 'admin')
  )
);

CREATE TABLE IF NOT EXISTS private.stripe_billing_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  organizer_id uuid REFERENCES public.organizers(id) ON DELETE SET NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.stripe_billing_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.stripe_billing_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.stripe_billing_events TO service_role;

-- Defense in depth for the existing webhook replay ledger.
ALTER TABLE private.stripe_ad_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.stripe_ad_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON private.stripe_ad_events TO service_role;

CREATE OR REPLACE FUNCTION private.require_service_role()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF coalesce((SELECT auth.jwt() ->> 'role'), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.require_service_role() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.require_service_role() TO service_role;

CREATE OR REPLACE FUNCTION public.prepare_organizer_subscription_checkout(
  _organizer_id uuid,
  _plan_code text,
  _billing_period text
)
RETURNS TABLE (
  checkout_token uuid,
  checkout_attempt integer,
  stripe_customer_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  selected_plan public.monetization_plans%ROWTYPE;
  current_subscription public.organizer_subscriptions%ROWTYPE;
  next_token uuid := gen_random_uuid();
BEGIN
  PERFORM private.require_service_role();
  PERFORM pg_advisory_xact_lock(hashtextextended(_organizer_id::text, 0));

  SELECT *
  INTO selected_plan
  FROM public.monetization_plans
  WHERE code = _plan_code
    AND audience = 'organizer'
    AND is_active
    AND NOT is_contact_sales;

  IF NOT FOUND
     OR _plan_code = 'starter'
     OR _billing_period NOT IN ('monthly', 'annual')
     OR (
       _billing_period = 'monthly' AND selected_plan.monthly_amount_minor < 100
     )
     OR (
       _billing_period = 'annual' AND selected_plan.annual_amount_minor < 100
     ) THEN
    RAISE EXCEPTION 'Invalid paid subscription plan' USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO current_subscription
  FROM public.organizer_subscriptions
  WHERE organizer_id = _organizer_id
  FOR UPDATE;

  IF FOUND AND current_subscription.status IN (
    'trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused'
  ) THEN
    RAISE EXCEPTION 'An existing subscription must be managed from the billing portal'
      USING ERRCODE = '23505';
  END IF;

  IF FOUND
     AND current_subscription.status = 'checkout_pending'
     AND current_subscription.updated_at > now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'A subscription checkout is already pending'
      USING ERRCODE = '55P03';
  END IF;

  INSERT INTO public.organizer_subscriptions (
    organizer_id,
    plan_code,
    status,
    billing_period,
    checkout_token,
    checkout_attempt,
    stripe_customer_id,
    updated_at
  ) VALUES (
    _organizer_id,
    _plan_code,
    'checkout_pending',
    _billing_period,
    next_token,
    1,
    current_subscription.stripe_customer_id,
    now()
  )
  ON CONFLICT (organizer_id) DO UPDATE SET
    plan_code = EXCLUDED.plan_code,
    status = EXCLUDED.status,
    billing_period = EXCLUDED.billing_period,
    checkout_token = EXCLUDED.checkout_token,
    checkout_attempt = public.organizer_subscriptions.checkout_attempt + 1,
    stripe_checkout_session_id = NULL,
    stripe_subscription_id = NULL,
    current_period_end = NULL,
    cancel_at_period_end = false,
    updated_at = now()
  RETURNING
    public.organizer_subscriptions.checkout_token,
    public.organizer_subscriptions.checkout_attempt,
    public.organizer_subscriptions.stripe_customer_id
  INTO checkout_token, checkout_attempt, stripe_customer_id;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_organizer_subscription_checkout(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_organizer_subscription_checkout(uuid, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fail_organizer_subscription_checkout(
  _organizer_id uuid,
  _checkout_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  changed_count integer;
BEGIN
  PERFORM private.require_service_role();

  UPDATE public.organizer_subscriptions
  SET
    plan_code = 'starter',
    status = 'free',
    billing_period = 'monthly',
    stripe_checkout_session_id = NULL,
    checkout_token = NULL,
    updated_at = now()
  WHERE organizer_id = _organizer_id
    AND checkout_token = _checkout_token
    AND status = 'checkout_pending';

  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_organizer_subscription_checkout(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_organizer_subscription_checkout(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.process_stripe_billing_event(
  _event_id text,
  _event_type text,
  _object jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  organizer_uuid uuid;
  plan_value text;
  billing_period_value text;
  checkout_token_value uuid;
  subscription_id_value text;
  customer_id_value text;
  stripe_status_value text;
  period_end_value timestamptz;
  expected_amount integer;
  expected_currency text;
BEGIN
  PERFORM private.require_service_role();

  IF nullif(_event_id, '') IS NULL OR nullif(_event_type, '') IS NULL THEN
    RAISE EXCEPTION 'Invalid Stripe event' USING ERRCODE = '22023';
  END IF;

  INSERT INTO private.stripe_billing_events(event_id, event_type)
  VALUES (_event_id, _event_type)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF _event_type = 'checkout.session.completed'
     AND _object ->> 'mode' = 'subscription' THEN
    BEGIN
      organizer_uuid := nullif(_object -> 'metadata' ->> 'organizer_id', '')::uuid;
      checkout_token_value := nullif(_object -> 'metadata' ->> 'checkout_token', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Invalid subscription checkout metadata' USING ERRCODE = '22023';
    END;

    plan_value := nullif(_object -> 'metadata' ->> 'plan_code', '');
    billing_period_value := nullif(_object -> 'metadata' ->> 'billing_period', '');
    subscription_id_value := nullif(_object ->> 'subscription', '');
    customer_id_value := nullif(_object ->> 'customer', '');

    SELECT
      CASE
        WHEN billing_period_value = 'annual' THEN annual_amount_minor
        ELSE monthly_amount_minor
      END,
      lower(currency)
    INTO expected_amount, expected_currency
    FROM public.monetization_plans
    WHERE code = plan_value
      AND is_active
      AND NOT is_contact_sales;

    IF organizer_uuid IS NULL
       OR checkout_token_value IS NULL
       OR subscription_id_value IS NULL
       OR customer_id_value IS NULL
       OR expected_amount IS NULL
       OR coalesce((_object ->> 'amount_total')::integer, -1) <> expected_amount
       OR lower(coalesce(_object ->> 'currency', '')) <> expected_currency
       OR _object ->> 'payment_status' NOT IN ('paid', 'no_payment_required') THEN
      RAISE EXCEPTION 'Stripe subscription checkout mismatch' USING ERRCODE = '22023';
    END IF;

    UPDATE public.organizer_subscriptions
    SET
      plan_code = plan_value,
      status = 'active',
      billing_period = billing_period_value,
      stripe_account_id = nullif(_object -> 'metadata' ->> 'stripe_account_id', ''),
      stripe_customer_id = customer_id_value,
      stripe_subscription_id = subscription_id_value,
      current_period_end = NULL,
      cancel_at_period_end = false,
      checkout_token = NULL,
      updated_at = now()
    WHERE organizer_id = organizer_uuid
      AND checkout_token = checkout_token_value
      AND stripe_checkout_session_id = _object ->> 'id'
      AND status IN ('checkout_pending', 'trialing', 'active');

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Subscription checkout state mismatch';
    END IF;
  ELSIF _event_type IN (
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted'
  ) THEN
    BEGIN
      organizer_uuid := nullif(_object -> 'metadata' ->> 'organizer_id', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      organizer_uuid := NULL;
    END;
    plan_value := nullif(_object -> 'metadata' ->> 'plan_code', '');
    subscription_id_value := nullif(_object ->> 'id', '');
    customer_id_value := nullif(_object ->> 'customer', '');
    stripe_status_value := CASE
      WHEN _event_type = 'customer.subscription.deleted' THEN 'canceled'
      WHEN _object ->> 'status' IN (
        'trialing', 'active', 'past_due', 'unpaid', 'incomplete',
        'incomplete_expired', 'paused', 'canceled'
      ) THEN _object ->> 'status'
      ELSE 'incomplete'
    END;

    IF coalesce(_object ->> 'current_period_end', '') ~ '^[0-9]+$' THEN
      period_end_value := to_timestamp((_object ->> 'current_period_end')::double precision);
    END IF;

    UPDATE public.organizer_subscriptions
    SET
      plan_code = coalesce(plan_value, plan_code),
      status = stripe_status_value,
      stripe_customer_id = coalesce(customer_id_value, stripe_customer_id),
      stripe_subscription_id = coalesce(subscription_id_value, stripe_subscription_id),
      current_period_end = period_end_value,
      cancel_at_period_end = coalesce((_object ->> 'cancel_at_period_end')::boolean, false),
      updated_at = now()
    WHERE stripe_subscription_id = subscription_id_value
       OR (
         organizer_uuid IS NOT NULL
         AND organizer_id = organizer_uuid
         AND stripe_subscription_id IS NULL
       );

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown Stripe subscription';
    END IF;
  ELSIF _event_type IN ('invoice.paid', 'invoice.payment_failed') THEN
    subscription_id_value := coalesce(
      nullif(_object ->> 'subscription', ''),
      nullif(_object #>> '{parent,subscription_details,subscription}', '')
    );

    UPDATE public.organizer_subscriptions
    SET
      status = CASE
        WHEN _event_type = 'invoice.payment_failed' THEN 'past_due'
        WHEN status IN ('past_due', 'unpaid', 'incomplete') THEN 'active'
        ELSE status
      END,
      updated_at = now()
    WHERE stripe_subscription_id = subscription_id_value;

    IF subscription_id_value IS NOT NULL AND NOT FOUND THEN
      RAISE EXCEPTION 'Unknown invoice subscription';
    END IF;
  END IF;

  UPDATE private.stripe_billing_events
  SET organizer_id = organizer_uuid
  WHERE event_id = _event_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.process_stripe_billing_event(text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_stripe_billing_event(text, text, jsonb)
  TO service_role;

COMMENT ON TABLE public.monetization_plans IS
  'Server-authoritative monetization catalog. Amounts use the currency minor unit.';
COMMENT ON TABLE public.organizer_subscriptions IS
  'Organizer billing projection synchronized from verified Stripe webhooks.';
COMMENT ON TABLE private.stripe_billing_events IS
  'Private idempotency ledger for Stripe subscription lifecycle events.';
