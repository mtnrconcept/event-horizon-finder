-- Social feed for organizer-authored posts and authenticated interactions.
-- Media files are stored in the public `social-media` Storage bucket; only
-- organizer owners/admins/editors may create posts or manage their media.

-- ---------------------------------------------------------------------------
-- Private authorization helpers
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.can_publish_for_organizer(_organizer_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.organizer_members AS member
        WHERE member.organizer_id = _organizer_id
          AND member.user_id = (SELECT auth.uid())
          AND member.role IN ('owner', 'admin', 'editor')
      )
      OR EXISTS (
        SELECT 1
        FROM public.user_roles AS user_role
        WHERE user_role.user_id = (SELECT auth.uid())
          AND user_role.role = 'admin'::public.app_role
      )
    );
$$;

REVOKE ALL ON FUNCTION private.can_publish_for_organizer(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_publish_for_organizer(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.can_moderate_social_content()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.user_roles AS user_role
      WHERE user_role.user_id = (SELECT auth.uid())
        AND user_role.role IN ('moderator'::public.app_role, 'admin'::public.app_role)
    );
$$;

REVOKE ALL ON FUNCTION private.can_moderate_social_content() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_moderate_social_content() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Transactional organizer creation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_organizer(_name TEXT, _slug TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_organizer_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF char_length(trim(_name)) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'Organizer name must contain between 2 and 120 characters'
      USING ERRCODE = '22023';
  END IF;

  IF char_length(_slug) NOT BETWEEN 2 AND 100
     OR _slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'Invalid organizer slug' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.organizers (name, slug, verification_level)
  VALUES (trim(_name), _slug, 'unverified'::public.verification_level)
  RETURNING id INTO v_organizer_id;

  INSERT INTO public.organizer_members (organizer_id, user_id, role)
  VALUES (v_organizer_id, v_user_id, 'owner');

  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_user_id, 'organizer'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN v_organizer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_organizer(TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.create_organizer(TEXT, TEXT) TO authenticated;

-- Organizer creation must go through the atomic RPC so that an organization
-- can never be left without its initial owner.
DROP POLICY IF EXISTS "organizers_insert_auth" ON public.organizers;
REVOKE INSERT ON public.organizers FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Social data model
-- ---------------------------------------------------------------------------

CREATE TYPE public.social_post_status AS ENUM ('draft', 'published', 'hidden');
CREATE TYPE public.social_media_kind AS ENUM ('image', 'video');
CREATE TYPE public.social_comment_status AS ENUM ('published', 'hidden');

CREATE TABLE public.social_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES public.organizers(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  body TEXT,
  event_id UUID REFERENCES public.events(id) ON DELETE SET NULL,
  status public.social_post_status NOT NULL DEFAULT 'draft',
  comments_enabled BOOLEAN NOT NULL DEFAULT true,
  like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  comment_count INTEGER NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT social_posts_body_length CHECK (
    body IS NULL OR char_length(trim(body)) BETWEEN 1 AND 5000
  )
);

CREATE TABLE public.social_post_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL UNIQUE,
  kind public.social_media_kind NOT NULL,
  mime_type TEXT NOT NULL,
  alt_text TEXT,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  sort_order SMALLINT NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT social_post_media_post_sort_unique UNIQUE (post_id, sort_order),
  CONSTRAINT social_post_media_path_format CHECK (
    storage_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$'
  ),
  CONSTRAINT social_post_media_mime_matches_kind CHECK (
    (kind = 'image'::public.social_media_kind AND mime_type IN (
      'image/jpeg', 'image/png', 'image/webp', 'image/gif'
    ))
    OR
    (kind = 'video'::public.social_media_kind AND mime_type IN (
      'video/mp4', 'video/webm', 'video/quicktime'
    ))
  )
);

CREATE TABLE public.social_post_likes (
  post_id UUID NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE public.social_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 2000),
  status public.social_comment_status NOT NULL DEFAULT 'published',
  author_display_name TEXT NOT NULL DEFAULT 'Utilisateur',
  author_avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX social_posts_feed_idx
  ON public.social_posts (published_at DESC, id DESC)
  WHERE status = 'published'::public.social_post_status;
CREATE INDEX social_posts_organizer_idx
  ON public.social_posts (organizer_id, created_at DESC);
CREATE INDEX social_posts_event_idx ON public.social_posts (event_id);
CREATE INDEX social_posts_created_by_idx ON public.social_posts (created_by);
CREATE INDEX social_post_media_post_idx
  ON public.social_post_media (post_id, sort_order);
CREATE INDEX social_post_likes_user_idx
  ON public.social_post_likes (user_id, post_id);
CREATE INDEX social_comments_post_idx
  ON public.social_comments (post_id, status, created_at);
CREATE INDEX social_comments_user_idx
  ON public.social_comments (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Social validation, visibility and counter helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.social_post_is_published(_post_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.social_posts AS post
    WHERE post.id = _post_id
      AND post.status = 'published'::public.social_post_status
      AND post.published_at IS NOT NULL
      AND post.published_at <= now()
  );
$$;

REVOKE ALL ON FUNCTION private.social_post_is_published(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.social_post_is_published(UUID) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.social_post_accepts_comments(_post_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.social_posts AS post
    WHERE post.id = _post_id
      AND post.status = 'published'::public.social_post_status
      AND post.published_at IS NOT NULL
      AND post.published_at <= now()
      AND post.comments_enabled
  );
$$;

REVOKE ALL ON FUNCTION private.social_post_accepts_comments(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.social_post_accepts_comments(UUID) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.can_manage_social_post(_post_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.social_posts AS post
    WHERE post.id = _post_id
      AND private.can_publish_for_organizer(post.organizer_id)
  );
$$;

REVOKE ALL ON FUNCTION private.can_manage_social_post(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_manage_social_post(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.set_social_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.set_social_updated_at() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.set_social_updated_at() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.validate_social_post()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.created_by IS NULL AND (SELECT auth.uid()) IS NOT NULL THEN
    NEW.created_by := (SELECT auth.uid());
  END IF;

  IF NEW.event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.events AS event
    WHERE event.id = NEW.event_id
      AND event.organizer_id = NEW.organizer_id
  ) THEN
    RAISE EXCEPTION 'The linked event must belong to the post organizer'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'published'::public.social_post_status THEN
    IF NULLIF(trim(NEW.body), '') IS NULL
       AND NEW.event_id IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM public.social_post_media AS media
         WHERE media.post_id = NEW.id
       ) THEN
      RAISE EXCEPTION 'A published post requires text, an event, or media'
        USING ERRCODE = '23514';
    END IF;

    NEW.published_at := COALESCE(NEW.published_at, now());
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.validate_social_post() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.validate_social_post() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.validate_social_post_media()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_organizer_id UUID;
BEGIN
  SELECT post.organizer_id
  INTO v_organizer_id
  FROM public.social_posts AS post
  WHERE post.id = NEW.post_id;

  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'Unknown social post' USING ERRCODE = '23503';
  END IF;

  IF split_part(NEW.storage_path, '/', 1) <> v_organizer_id::TEXT
     OR split_part(NEW.storage_path, '/', 2) <> NEW.post_id::TEXT THEN
    RAISE EXCEPTION 'Media path does not match its organizer and post'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.validate_social_post_media() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.validate_social_post_media() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.set_social_comment_author()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_display_name TEXT;
  v_avatar_url TEXT;
BEGIN
  IF v_user_id IS NOT NULL THEN
    NEW.user_id := v_user_id;
  END IF;

  SELECT
    COALESCE(NULLIF(trim(profile.display_name), ''), 'Utilisateur'),
    profile.avatar_url
  INTO v_display_name, v_avatar_url
  FROM public.profiles AS profile
  WHERE profile.id = NEW.user_id;

  IF NOT FOUND THEN
    NEW.author_display_name := 'Utilisateur';
    NEW.author_avatar_url := NULL;
  ELSE
    NEW.author_display_name := v_display_name;
    NEW.author_avatar_url := v_avatar_url;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.set_social_comment_author() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.set_social_comment_author() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.update_social_like_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.social_posts
    SET like_count = like_count + 1
    WHERE id = NEW.post_id;
    RETURN NEW;
  END IF;

  UPDATE public.social_posts
  SET like_count = GREATEST(0, like_count - 1)
  WHERE id = OLD.post_id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION private.update_social_like_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.update_social_like_count() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.update_social_comment_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'published'::public.social_comment_status THEN
      UPDATE public.social_posts
      SET comment_count = comment_count + 1
      WHERE id = NEW.post_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published'::public.social_comment_status THEN
      UPDATE public.social_posts
      SET comment_count = GREATEST(0, comment_count - 1)
      WHERE id = OLD.post_id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.post_id <> NEW.post_id THEN
    IF OLD.status = 'published'::public.social_comment_status THEN
      UPDATE public.social_posts
      SET comment_count = GREATEST(0, comment_count - 1)
      WHERE id = OLD.post_id;
    END IF;
    IF NEW.status = 'published'::public.social_comment_status THEN
      UPDATE public.social_posts
      SET comment_count = comment_count + 1
      WHERE id = NEW.post_id;
    END IF;
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE public.social_posts
    SET comment_count = GREATEST(
      0,
      comment_count + CASE
        WHEN NEW.status = 'published'::public.social_comment_status THEN 1
        ELSE -1
      END
    )
    WHERE id = NEW.post_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.update_social_comment_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.update_social_comment_count() TO authenticated, service_role;

CREATE TRIGGER trg_social_posts_validate
  BEFORE INSERT OR UPDATE ON public.social_posts
  FOR EACH ROW EXECUTE FUNCTION private.validate_social_post();
CREATE TRIGGER trg_social_posts_updated
  BEFORE UPDATE ON public.social_posts
  FOR EACH ROW EXECUTE FUNCTION private.set_social_updated_at();
CREATE TRIGGER trg_social_post_media_validate
  BEFORE INSERT OR UPDATE ON public.social_post_media
  FOR EACH ROW EXECUTE FUNCTION private.validate_social_post_media();
CREATE TRIGGER trg_social_comments_author
  BEFORE INSERT ON public.social_comments
  FOR EACH ROW EXECUTE FUNCTION private.set_social_comment_author();
CREATE TRIGGER trg_social_comments_updated
  BEFORE UPDATE ON public.social_comments
  FOR EACH ROW EXECUTE FUNCTION private.set_social_updated_at();
CREATE TRIGGER trg_social_post_likes_count
  AFTER INSERT OR DELETE ON public.social_post_likes
  FOR EACH ROW EXECUTE FUNCTION private.update_social_like_count();
CREATE TRIGGER trg_social_comments_count
  AFTER INSERT OR UPDATE OF status, post_id OR DELETE ON public.social_comments
  FOR EACH ROW EXECUTE FUNCTION private.update_social_comment_count();

-- ---------------------------------------------------------------------------
-- Minimal grants and row-level security
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE
  public.social_posts,
  public.social_post_media,
  public.social_post_likes,
  public.social_comments
FROM PUBLIC, anon, authenticated;

GRANT SELECT (
  id, organizer_id, body, event_id, status, comments_enabled,
  like_count, comment_count, published_at, created_at, updated_at
) ON public.social_posts TO anon, authenticated;
GRANT INSERT (id, organizer_id, created_by, body, event_id, status, comments_enabled)
  ON public.social_posts TO authenticated;
GRANT UPDATE (body, event_id, status, comments_enabled)
  ON public.social_posts TO authenticated;
GRANT DELETE ON public.social_posts TO authenticated;

GRANT SELECT ON public.social_post_media TO anon, authenticated;
GRANT INSERT (
  id, post_id, storage_path, kind, mime_type, alt_text,
  width, height, duration_ms, sort_order
) ON public.social_post_media TO authenticated;
GRANT UPDATE (alt_text, sort_order) ON public.social_post_media TO authenticated;
GRANT DELETE ON public.social_post_media TO authenticated;

GRANT SELECT, INSERT, DELETE ON public.social_post_likes TO authenticated;

GRANT SELECT (
  id, post_id, body, status, author_display_name, author_avatar_url,
  created_at, updated_at
) ON public.social_comments TO anon, authenticated;
GRANT INSERT (id, post_id, user_id, body) ON public.social_comments TO authenticated;
GRANT UPDATE (body) ON public.social_comments TO authenticated;
GRANT DELETE ON public.social_comments TO authenticated;

GRANT ALL ON TABLE
  public.social_posts,
  public.social_post_media,
  public.social_post_likes,
  public.social_comments
TO service_role;

ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_post_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_post_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "social_posts_public_read"
ON public.social_posts FOR SELECT TO anon, authenticated
USING (
  status = 'published'::public.social_post_status
  AND published_at IS NOT NULL
  AND published_at <= now()
);

CREATE POLICY "social_posts_publishers_read"
ON public.social_posts FOR SELECT TO authenticated
USING ((SELECT private.can_publish_for_organizer(organizer_id)));

CREATE POLICY "social_posts_moderators_read"
ON public.social_posts FOR SELECT TO authenticated
USING ((SELECT private.can_moderate_social_content()));

CREATE POLICY "social_posts_publishers_insert"
ON public.social_posts FOR INSERT TO authenticated
WITH CHECK (
  created_by = (SELECT auth.uid())
  AND status IN (
    'draft'::public.social_post_status,
    'published'::public.social_post_status
  )
  AND (SELECT private.can_publish_for_organizer(organizer_id))
);

CREATE POLICY "social_posts_publishers_update"
ON public.social_posts FOR UPDATE TO authenticated
USING (
  status <> 'hidden'::public.social_post_status
  AND (SELECT private.can_publish_for_organizer(organizer_id))
)
WITH CHECK (
  status IN (
    'draft'::public.social_post_status,
    'published'::public.social_post_status
  )
  AND (SELECT private.can_publish_for_organizer(organizer_id))
);

CREATE POLICY "social_posts_moderators_update"
ON public.social_posts FOR UPDATE TO authenticated
USING ((SELECT private.can_moderate_social_content()))
WITH CHECK ((SELECT private.can_moderate_social_content()));

CREATE POLICY "social_posts_publishers_delete"
ON public.social_posts FOR DELETE TO authenticated
USING (
  (
    status <> 'hidden'::public.social_post_status
    AND (SELECT private.can_publish_for_organizer(organizer_id))
  )
  OR (SELECT private.can_moderate_social_content())
);

CREATE POLICY "social_media_public_read"
ON public.social_post_media FOR SELECT TO anon, authenticated
USING ((SELECT private.social_post_is_published(post_id)));

CREATE POLICY "social_media_publishers_read"
ON public.social_post_media FOR SELECT TO authenticated
USING ((SELECT private.can_manage_social_post(post_id)));

CREATE POLICY "social_media_publishers_insert"
ON public.social_post_media FOR INSERT TO authenticated
WITH CHECK ((SELECT private.can_manage_social_post(post_id)));

CREATE POLICY "social_media_publishers_update"
ON public.social_post_media FOR UPDATE TO authenticated
USING ((SELECT private.can_manage_social_post(post_id)))
WITH CHECK ((SELECT private.can_manage_social_post(post_id)));

CREATE POLICY "social_media_publishers_delete"
ON public.social_post_media FOR DELETE TO authenticated
USING ((SELECT private.can_manage_social_post(post_id)));

CREATE POLICY "social_likes_read_own"
ON public.social_post_likes FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));

CREATE POLICY "social_likes_insert_own"
ON public.social_post_likes FOR INSERT TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND (SELECT private.social_post_is_published(post_id))
);

CREATE POLICY "social_likes_delete_own"
ON public.social_post_likes FOR DELETE TO authenticated
USING (user_id = (SELECT auth.uid()));

CREATE POLICY "social_comments_public_read"
ON public.social_comments FOR SELECT TO anon, authenticated
USING (
  status = 'published'::public.social_comment_status
  AND (SELECT private.social_post_is_published(post_id))
);

CREATE POLICY "social_comments_owner_read"
ON public.social_comments FOR SELECT TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR (SELECT private.can_manage_social_post(post_id))
  OR (SELECT private.can_moderate_social_content())
);

CREATE POLICY "social_comments_insert_own"
ON public.social_comments FOR INSERT TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND status = 'published'::public.social_comment_status
  AND (SELECT private.social_post_accepts_comments(post_id))
);

CREATE POLICY "social_comments_update_own"
ON public.social_comments FOR UPDATE TO authenticated
USING (
  user_id = (SELECT auth.uid())
  AND status = 'published'::public.social_comment_status
  AND (SELECT private.social_post_is_published(post_id))
)
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND status = 'published'::public.social_comment_status
  AND (SELECT private.social_post_is_published(post_id))
);

CREATE POLICY "social_comments_delete_allowed"
ON public.social_comments FOR DELETE TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR (SELECT private.can_manage_social_post(post_id))
  OR (SELECT private.can_moderate_social_content())
);

-- ---------------------------------------------------------------------------
-- Public media bucket and organizer-scoped Storage policies
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'social-media',
  'social-media',
  true,
  52428800,
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm',
    'video/quicktime'
  ]::TEXT[]
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION private.can_manage_social_object(_object_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_folders TEXT[];
  v_organizer_id UUID;
  v_post_id UUID;
BEGIN
  IF _object_name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$' THEN
    RETURN false;
  END IF;

  v_folders := storage.foldername(_object_name);
  IF COALESCE(cardinality(v_folders), 0) <> 2 THEN
    RETURN false;
  END IF;

  BEGIN
    v_organizer_id := v_folders[1]::UUID;
    v_post_id := v_folders[2]::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;

  RETURN private.can_publish_for_organizer(v_organizer_id)
    AND EXISTS (
      SELECT 1
      FROM public.social_posts AS post
      WHERE post.id = v_post_id
        AND post.organizer_id = v_organizer_id
    );
END;
$$;

REVOKE ALL ON FUNCTION private.can_manage_social_object(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_manage_social_object(TEXT) TO authenticated, service_role;

DROP POLICY IF EXISTS "social_media_storage_insert" ON storage.objects;
CREATE POLICY "social_media_storage_insert"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'social-media'
  AND (SELECT private.can_manage_social_object(name))
);

DROP POLICY IF EXISTS "social_media_storage_delete" ON storage.objects;
CREATE POLICY "social_media_storage_delete"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'social-media'
  AND (SELECT private.can_manage_social_object(name))
);

-- ---------------------------------------------------------------------------
-- Initial organizer posts for a non-empty feed
-- ---------------------------------------------------------------------------

WITH demo_events AS (
  SELECT
    event.id AS event_id,
    event.organizer_id,
    event.title,
    row_number() OVER (ORDER BY event.created_at, event.id) AS position
  FROM public.events AS event
  JOIN public.organizers AS organizer ON organizer.id = event.organizer_id
  WHERE event.is_demo
    AND organizer.is_demo
    AND event.organizer_id IS NOT NULL
    AND event.status = 'published'::public.event_status
  ORDER BY event.created_at, event.id
  LIMIT 3
)
INSERT INTO public.social_posts (
  organizer_id,
  created_by,
  body,
  event_id,
  status,
  published_at
)
SELECT
  demo.organizer_id,
  NULL,
  CASE demo.position
    WHEN 1 THEN 'À ne pas manquer : ' || demo.title || '. Retrouve toutes les informations sur EVENTA.'
    WHEN 2 THEN 'Notre prochaine recommandation à Genève : ' || demo.title || '. Qui sera de la partie ?'
    ELSE 'À découvrir bientôt : ' || demo.title || '. Ajoute cet événement à tes favoris.'
  END,
  demo.event_id,
  'published'::public.social_post_status,
  now() - ((4 - demo.position) * INTERVAL '1 hour')
FROM demo_events AS demo;
