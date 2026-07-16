-- Reconcile the production migration that hardened event occurrence timezones.
-- Keep imported values as valid IANA names and derive local calendar dates from
-- the normalized timezone so fresh databases reproduce the production schema.

WITH resolved AS (
  SELECT
    occurrence.id,
    CASE
      WHEN occurrence.timezone IS NOT NULL
        AND btrim(occurrence.timezone) <> ''
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_timezone_names AS zone
          WHERE zone.name = btrim(occurrence.timezone)
        )
      THEN btrim(occurrence.timezone)
      WHEN city.timezone IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_timezone_names AS zone
          WHERE zone.name = city.timezone
        )
      THEN city.timezone
      ELSE 'UTC'
    END AS timezone
  FROM public.event_occurrences AS occurrence
  JOIN public.events AS event ON event.id = occurrence.event_id
  LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
  LEFT JOIN public.cities AS city
    ON city.id = coalesce(venue.city_id, event.city_id)
)
UPDATE public.event_occurrences AS occurrence
SET
  timezone = resolved.timezone,
  local_start_date = (occurrence.starts_at AT TIME ZONE resolved.timezone)::date,
  local_end_date = CASE
    WHEN occurrence.ends_at IS NULL THEN NULL
    ELSE (occurrence.ends_at AT TIME ZONE resolved.timezone)::date
  END
FROM resolved
WHERE occurrence.id = resolved.id;

CREATE OR REPLACE FUNCTION public.normalize_event_occurrence_timezone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  resolved_timezone TEXT;
BEGIN
  IF NEW.timezone IS NOT NULL
     AND btrim(NEW.timezone) <> ''
     AND EXISTS (
       SELECT 1
       FROM pg_catalog.pg_timezone_names AS zone
       WHERE zone.name = btrim(NEW.timezone)
     )
  THEN
    resolved_timezone := btrim(NEW.timezone);
  ELSE
    SELECT city.timezone
    INTO resolved_timezone
    FROM public.events AS event
    LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
    LEFT JOIN public.cities AS city
      ON city.id = coalesce(venue.city_id, event.city_id)
    WHERE event.id = NEW.event_id
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_timezone_names AS zone
        WHERE zone.name = city.timezone
      )
    LIMIT 1;
  END IF;

  NEW.timezone := coalesce(resolved_timezone, 'UTC');
  NEW.local_start_date := (NEW.starts_at AT TIME ZONE NEW.timezone)::date;
  NEW.local_end_date := CASE
    WHEN NEW.ends_at IS NULL THEN NULL
    ELSE (NEW.ends_at AT TIME ZONE NEW.timezone)::date
  END;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.normalize_event_occurrence_timezone()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS normalize_event_occurrence_timezone
  ON public.event_occurrences;
CREATE TRIGGER normalize_event_occurrence_timezone
  BEFORE INSERT OR UPDATE OF timezone, event_id, starts_at, ends_at
  ON public.event_occurrences
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_event_occurrence_timezone();

COMMENT ON FUNCTION public.normalize_event_occurrence_timezone()
  IS 'Ensures event occurrence timezones are valid IANA names and keeps local dates synchronized.';
