-- Privacy-first preference graph used by the personalized discovery experience.
-- Explicit answers and first-party interactions remain inspectable and deletable.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS event_preferences text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS discovery_mood text NOT NULL DEFAULT 'balanced',
  ADD COLUMN IF NOT EXISTS preferred_price text NOT NULL DEFAULT 'any';

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_event_preferences_size_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_event_preferences_size_check
  CHECK (cardinality(event_preferences) <= 12);
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_discovery_mood_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_discovery_mood_check
  CHECK (discovery_mood IN ('calm', 'balanced', 'social', 'surprise'));
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_preferred_price_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_preferred_price_check
  CHECK (preferred_price IN ('any', 'free', 'budget', 'premium'));

CREATE TABLE IF NOT EXISTS public.event_interest_signals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_type text NOT NULL CHECK (signal_type IN ('search', 'view', 'share')),
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 100),
  weight real NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 5),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_interest_signals_user_recent_idx
  ON public.event_interest_signals (user_id, created_at DESC);
ALTER TABLE public.event_interest_signals ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON public.event_interest_signals TO authenticated;
GRANT ALL ON public.event_interest_signals TO service_role;
DROP POLICY IF EXISTS event_interest_signals_own_read ON public.event_interest_signals;
CREATE POLICY event_interest_signals_own_read ON public.event_interest_signals
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS event_interest_signals_own_insert ON public.event_interest_signals;
CREATE POLICY event_interest_signals_own_insert ON public.event_interest_signals
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS event_interest_signals_own_delete ON public.event_interest_signals;
CREATE POLICY event_interest_signals_own_delete ON public.event_interest_signals
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Hydrate questionnaire answers from signup metadata without replacing the
-- existing account-creation function (and therefore without rewriting history).
CREATE OR REPLACE FUNCTION private.hydrate_discovery_preferences()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
DECLARE metadata jsonb;
BEGIN
  SELECT raw_user_meta_data INTO metadata FROM auth.users WHERE id = NEW.id;
  IF jsonb_typeof(metadata->'event_preferences') = 'array' THEN
    SELECT (coalesce(array_agg(value ORDER BY value), '{}'::text[]))[1:12]
      INTO NEW.event_preferences FROM jsonb_array_elements_text(metadata->'event_preferences') value;
  END IF;
  IF metadata->>'discovery_mood' IN ('calm','balanced','social','surprise') THEN
    NEW.discovery_mood := metadata->>'discovery_mood';
  END IF;
  IF metadata->>'preferred_price' IN ('any','free','budget','premium') THEN
    NEW.preferred_price := metadata->>'preferred_price';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_profiles_hydrate_discovery_preferences ON public.profiles;
CREATE TRIGGER trg_profiles_hydrate_discovery_preferences
  BEFORE INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION private.hydrate_discovery_preferences();
REVOKE ALL ON FUNCTION private.hydrate_discovery_preferences() FROM PUBLIC;

COMMENT ON TABLE public.event_interest_signals IS
  'First-party signals powering explainable event recommendations; users can read and delete their own history.';
