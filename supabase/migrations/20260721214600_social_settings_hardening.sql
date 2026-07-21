-- Hardening for user-authored social media and lifecycle timestamps.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS faq_items_locale_question_uidx
  ON public.faq_items (locale, question);

CREATE OR REPLACE FUNCTION private.can_manage_social_object(_object_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  folders text[];
  owner_id uuid;
  post_id uuid;
BEGIN
  IF _object_name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$' THEN
    RETURN false;
  END IF;

  folders := storage.foldername(_object_name);
  IF COALESCE(cardinality(folders), 0) <> 2 THEN RETURN false; END IF;

  BEGIN
    owner_id := folders[1]::uuid;
    post_id := folders[2]::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;

  RETURN private.can_manage_social_post(post_id)
    AND EXISTS (
      SELECT 1
      FROM public.social_posts post
      WHERE post.id = post_id
        AND (
          post.organizer_id = owner_id
          OR post.author_user_id = owner_id
          OR post.created_by = owner_id
        )
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  target_table text;
  target_trigger text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'user_settings', 'social_user_follows', 'cookie_consents',
    'legal_documents', 'help_articles', 'faq_items', 'support_tickets'
  ] LOOP
    target_trigger := 'trg_' || target_table || '_updated';
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', target_trigger, target_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      target_trigger,
      target_table
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.update_social_share_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target_id uuid := COALESCE(NEW.entity_id, OLD.entity_id);
BEGIN
  IF COALESCE(NEW.entity_type, OLD.entity_type) = 'post' THEN
    UPDATE public.social_posts
    SET share_count = GREATEST(share_count + CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END, 0)
    WHERE id = target_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Function used by the client after a successful native share/copy. The unique
-- request id makes retries and double clicks idempotent.
CREATE TABLE IF NOT EXISTS public.social_share_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  anonymous_id text,
  entity_type text NOT NULL CHECK (entity_type IN ('post','event')),
  entity_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('native','copy','whatsapp','facebook','x','other')),
  client_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL),
  UNIQUE (user_id, client_request_id),
  UNIQUE (anonymous_id, client_request_id)
);
ALTER TABLE public.social_share_events ENABLE ROW LEVEL SECURITY;
GRANT INSERT, SELECT ON public.social_share_events TO authenticated;
GRANT ALL ON public.social_share_events TO service_role;
DROP POLICY IF EXISTS social_share_events_own_insert ON public.social_share_events;
CREATE POLICY social_share_events_own_insert ON public.social_share_events FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS social_share_events_own_read ON public.social_share_events;
CREATE POLICY social_share_events_own_read ON public.social_share_events FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP TRIGGER IF EXISTS trg_social_share_events_count ON public.social_share_events;
CREATE TRIGGER trg_social_share_events_count
AFTER INSERT OR DELETE ON public.social_share_events
FOR EACH ROW EXECUTE FUNCTION private.update_social_share_count();

COMMIT;
