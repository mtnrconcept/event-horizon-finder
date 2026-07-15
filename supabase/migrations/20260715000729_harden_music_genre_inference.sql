CREATE OR REPLACE FUNCTION public.infer_event_genres(
  _title TEXT,
  _short_description TEXT DEFAULT NULL,
  _description TEXT DEFAULT NULL
)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  WITH input AS (
    SELECT lower(concat_ws(' ', _title, _short_description, _description)) AS haystack
  ), matches(priority, genre, pattern) AS (
    VALUES
      (10, 'afro-house', '(afro[ -]?house)'),
      (20, 'techno', '(^|[^a-z])techno([^a-z]|$)'),
      (30, 'house', '(house music|musique house|deep house|tech house|progressive house|house dj|house set|house night)'),
      (40, 'electro', '(electro|electronica|electronic music|musique electronique|musique électronique)'),
      (50, 'trance', '(psytrance|goa trance|(^|[^a-z])trance([^a-z]|$))'),
      (60, 'drum-and-bass', '(drum.?and.?bass|drum.?n.?bass|(^|[^a-z])dnb([^a-z]|$)|jungle music|jungle dnb)'),
      (70, 'hip-hop', '(hip.?hop|(^|[^a-z])rap([^a-z]|$)|(^|[^a-z])trap([^a-z]|$))'),
      (80, 'r-and-b', '(r&b|(^|[^a-z])rnb([^a-z]|$)|rhythm and blues)'),
      (90, 'soul', '(^|[^a-z])soul([^a-z]|$)'),
      (100, 'reggae', '(reggae|(^|[^a-z])dub([^a-z]|$)|(^|[^a-z])ska([^a-z]|$))'),
      (110, 'dancehall', 'dancehall'),
      (120, 'disco', '(^|[^a-z])disco([^a-z]|$)'),
      (130, 'funk', '(^|[^a-z])funk([^a-z]|$)'),
      (140, 'jazz', '(^|[^a-z])jazz([^a-z]|$)'),
      (150, 'blues', '(^|[^a-z])blues([^a-z]|$)'),
      (160, 'rock', '(^|[^a-z])rock([^a-z]|$)'),
      (170, 'metal', '(^|[^a-z])metal([^a-z]|$)'),
      (180, 'punk', '(^|[^a-z])punk([^a-z]|$)'),
      (190, 'indie', '(^|[^a-z])indie([^a-z]|$)'),
      (200, 'pop', '(^|[^a-z])pop([^a-z]|$)'),
      (210, 'classical', '(classique|classical|symphon|philharmon|orchestr|musique de chambre|quatuor|sonate)'),
      (220, 'opera', '(^|[^a-z])(opera|opéra)([^a-z]|$)'),
      (230, 'latin', '(latin|salsa|bachata|cumbia|merengue)'),
      (240, 'reggaeton', 'reggaeton'),
      (250, 'afrobeat', '(afrobeat|afrobeats)'),
      (260, 'world', '(world music|musiques? du monde)'),
      (270, 'experimental', '(experimental music|musique expérimentale|experimental electronic)'),
      (280, 'ambient', '(ambient music|ambient techno|ambient electronic|ambient set)'),
      (290, 'gospel', '(^|[^a-z])gospel([^a-z]|$)')
  )
  SELECT coalesce(array_agg(matches.genre ORDER BY matches.priority), '{}'::TEXT[])
  FROM input
  JOIN matches ON input.haystack ~ matches.pattern;
$$;

CREATE OR REPLACE FUNCTION public.apply_inferred_event_genres()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  category_slug TEXT;
BEGIN
  IF cardinality(coalesce(NEW.genres, '{}'::TEXT[])) = 0 THEN
    SELECT category.slug INTO category_slug
    FROM public.event_categories AS category
    WHERE category.id = NEW.category_id;

    IF category_slug IN ('concerts', 'festivals', 'soirees') THEN
      NEW.genres := public.infer_event_genres(
        NEW.title,
        NEW.short_description,
        NEW.description
      );
    ELSE
      NEW.genres := '{}'::TEXT[];
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
