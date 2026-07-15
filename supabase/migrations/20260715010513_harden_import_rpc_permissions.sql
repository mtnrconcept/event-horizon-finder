-- Import jobs are internal maintenance operations, never public RPCs. Their
-- staging functions are optional on clean preview branches.
DO $block$
DECLARE
  signature TEXT;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.import_eventscrap_events_batch(integer)',
    'public.import_eventscrap_occurrences_batch(integer)'
  ]
  LOOP
    IF to_regprocedure(signature) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', signature);
      EXECUTE format(
        'REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated',
        signature
      );
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', signature);
    END IF;
  END LOOP;
END;
$block$;
