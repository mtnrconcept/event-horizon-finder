-- Make Stripe the sole authority for payment state and process webhook retries atomically.
ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS checkout_attempt integer NOT NULL DEFAULT 0
  CHECK (checkout_attempt >= 0);

CREATE TABLE IF NOT EXISTS private.stripe_ad_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  campaign_id uuid REFERENCES public.ad_campaigns(id) ON DELETE SET NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION private.protect_ad_payment_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
BEGIN
  IF jwt_role <> 'service_role' AND TG_OP = 'INSERT' AND (
    NEW.payment_status <> 'unpaid' OR
    NEW.stripe_checkout_session_id IS NOT NULL OR
    NEW.stripe_payment_intent_id IS NOT NULL OR
    NEW.paid_at IS NOT NULL OR
    NEW.checkout_attempt <> 0
  ) THEN
    RAISE EXCEPTION 'Payment fields can only be changed by the payment service'
      USING ERRCODE = '42501';
  ELSIF jwt_role <> 'service_role' AND TG_OP = 'UPDATE' AND (
    NEW.payment_status IS DISTINCT FROM OLD.payment_status OR
    NEW.stripe_checkout_session_id IS DISTINCT FROM OLD.stripe_checkout_session_id OR
    NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id OR
    NEW.paid_at IS DISTINCT FROM OLD.paid_at OR
    NEW.checkout_attempt IS DISTINCT FROM OLD.checkout_attempt
  ) THEN
    RAISE EXCEPTION 'Payment fields can only be changed by the payment service'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ad_campaign_payment_fields ON public.ad_campaigns;
CREATE TRIGGER trg_ad_campaign_payment_fields
BEFORE INSERT OR UPDATE ON public.ad_campaigns FOR EACH ROW
EXECUTE FUNCTION private.protect_ad_payment_fields();

CREATE OR REPLACE FUNCTION public.process_stripe_ad_event(
  _event_id text,
  _event_type text,
  _session jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  campaign_uuid uuid;
  session_id text := _session ->> 'id';
  payment_intent text := _session ->> 'payment_intent';
BEGIN
  IF coalesce((SELECT auth.jwt() ->> 'role'), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF nullif(_event_id, '') IS NULL OR nullif(_event_type, '') IS NULL THEN
    RAISE EXCEPTION 'Invalid Stripe event' USING ERRCODE = '22023';
  END IF;

  INSERT INTO private.stripe_ad_events(event_id, event_type)
  VALUES (_event_id, _event_type)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;

  IF _event_type IN (
    'checkout.session.completed', 'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed', 'checkout.session.expired'
  ) THEN
    BEGIN
      campaign_uuid := nullif(_session -> 'metadata' ->> 'campaign_id', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Invalid campaign metadata' USING ERRCODE = '22023';
    END;

    IF campaign_uuid IS NULL OR session_id IS NULL THEN
      RAISE EXCEPTION 'Missing campaign metadata' USING ERRCODE = '22023';
    END IF;

    IF _event_type IN ('checkout.session.async_payment_succeeded', 'checkout.session.completed')
       AND _session ->> 'payment_status' = 'paid' THEN
      UPDATE public.ad_campaigns SET
        payment_status = 'paid', status = 'active', paid_at = coalesce(paid_at, now()),
        stripe_payment_intent_id = coalesce(payment_intent, stripe_payment_intent_id)
      WHERE id = campaign_uuid AND stripe_checkout_session_id = session_id;
    ELSIF _event_type = 'checkout.session.completed' THEN
      -- Delayed payment methods complete Checkout before their payment settles.
      UPDATE public.ad_campaigns SET payment_status = 'pending', status = 'pending_payment'
      WHERE id = campaign_uuid AND stripe_checkout_session_id = session_id
        AND payment_status <> 'paid';
    ELSE
      UPDATE public.ad_campaigns SET payment_status = 'failed', status = 'draft'
      WHERE id = campaign_uuid AND stripe_checkout_session_id = session_id
        AND payment_status <> 'paid';
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'Stripe campaign/session mismatch'; END IF;
  ELSIF _event_type = 'charge.refunded' THEN
    UPDATE public.ad_campaigns SET payment_status = 'refunded', status = 'paused'
    WHERE stripe_payment_intent_id = (_session ->> 'payment_intent')
      AND payment_status = 'paid';
    campaign_uuid := (SELECT id FROM public.ad_campaigns
      WHERE stripe_payment_intent_id = (_session ->> 'payment_intent') LIMIT 1);
  END IF;

  UPDATE private.stripe_ad_events SET campaign_id = campaign_uuid WHERE event_id = _event_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.process_stripe_ad_event(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_stripe_ad_event(text, text, jsonb) TO service_role;
