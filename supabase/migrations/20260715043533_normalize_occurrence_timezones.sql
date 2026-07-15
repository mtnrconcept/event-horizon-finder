-- Imported catalogues can use human-readable notes where an IANA
-- timezone is required. Normalize existing rows from their resolved city and
-- keep future writes valid at the database boundary.
WITH resolved AS (
  SELECT
    occurrence.id,
    coalesce(valid_city.name, 'UTC') AS timezone
  FROM public.event_occurrences AS occurrence
  JOIN public.events AS event ON event.id = occurrence.event_id
  LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
  LEFT JOIN public.cities AS city
    ON city.id = coalesce(venue.city_id, event.city_id)
  LEFT JOIN pg_catalog.pg_timezone_names AS valid_occurrence
    ON valid_occurrence.name = occurrence.timezone
  LEFT JOIN pg_catalog.pg_timezone_names AS valid_city
    ON valid_city.name = city.timezone
  WHERE valid_occurrence.name IS NULL
)
UPDATE public.event_occurrences AS occurrence
SET timezone = resolved.timezone
FROM resolved
WHERE occurrence.id = resolved.id;

CREATE OR REPLACE FUNCTION public.normalize_event_occurrence_timezone()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  resolved_timezone TEXT;
BEGIN
  IF NEW.timezone IS NOT NULL AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_timezone_names AS valid
    WHERE valid.name = NEW.timezone
  ) THEN
    RETURN NEW;
  END IF;

  SELECT valid.name
  INTO resolved_timezone
  FROM public.events AS event
  LEFT JOIN public.venues AS venue ON venue.id = event.venue_id
  LEFT JOIN public.cities AS city
    ON city.id = coalesce(venue.city_id, event.city_id)
  JOIN pg_catalog.pg_timezone_names AS valid ON valid.name = city.timezone
  WHERE event.id = NEW.event_id
  LIMIT 1;

  NEW.timezone := coalesce(resolved_timezone, 'UTC');
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.normalize_event_occurrence_timezone() FROM PUBLIC;

DROP TRIGGER IF EXISTS normalize_event_occurrence_timezone
  ON public.event_occurrences;
CREATE TRIGGER normalize_event_occurrence_timezone
  BEFORE INSERT OR UPDATE OF timezone, event_id
  ON public.event_occurrences
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_event_occurrence_timezone();

COMMENT ON FUNCTION public.normalize_event_occurrence_timezone()
  IS 'Ensures event occurrence timezones are valid IANA names, falling back to the event city or UTC.';
