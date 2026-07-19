-- Global, free-search event discovery pipeline.
--
-- The public schema only exposes the visitor-facing event source links and
-- service-role RPCs. Queue state, search snippets, leases, robots decisions and
-- alternative deduplication identities stay in the non-exposed private schema.
-- No scheduler or secret is installed by this migration.

CREATE SCHEMA IF NOT EXISTS private;

-- ---------------------------------------------------------------------------
-- Geography metadata imported from the GeoNames downloadable datasets.
-- ---------------------------------------------------------------------------

ALTER TABLE public.countries
  ADD COLUMN IF NOT EXISTS iso3 TEXT,
  ADD COLUMN IF NOT EXISTS geonames_id BIGINT,
  ADD COLUMN IF NOT EXISTS population BIGINT,
  ADD COLUMN IF NOT EXISTS area_sq_km NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS languages TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE public.countries
  DROP CONSTRAINT IF EXISTS countries_iso3_format_check,
  ADD CONSTRAINT countries_iso3_format_check
    CHECK (iso3 IS NULL OR iso3 ~ '^[A-Z]{3}$') NOT VALID,
  DROP CONSTRAINT IF EXISTS countries_geonames_id_check,
  ADD CONSTRAINT countries_geonames_id_check
    CHECK (geonames_id IS NULL OR geonames_id > 0) NOT VALID,
  DROP CONSTRAINT IF EXISTS countries_population_check,
  ADD CONSTRAINT countries_population_check
    CHECK (population IS NULL OR population >= 0) NOT VALID,
  DROP CONSTRAINT IF EXISTS countries_area_sq_km_check,
  ADD CONSTRAINT countries_area_sq_km_check
    CHECK (area_sq_km IS NULL OR area_sq_km >= 0) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS countries_iso3_uidx
  ON public.countries (iso3)
  WHERE iso3 IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS countries_geonames_id_uidx
  ON public.countries (geonames_id)
  WHERE geonames_id IS NOT NULL;

ALTER TABLE public.cities
  ADD COLUMN IF NOT EXISTS geonames_id BIGINT,
  ADD COLUMN IF NOT EXISTS ascii_name TEXT,
  ADD COLUMN IF NOT EXISTS population BIGINT,
  ADD COLUMN IF NOT EXISTS is_capital BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS country_population_rank SMALLINT,
  ADD COLUMN IF NOT EXISTS alternate_names TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS search_names TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS search_languages TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS feature_code TEXT;

ALTER TABLE public.cities
  DROP CONSTRAINT IF EXISTS cities_geonames_id_check,
  ADD CONSTRAINT cities_geonames_id_check
    CHECK (geonames_id IS NULL OR geonames_id > 0) NOT VALID,
  DROP CONSTRAINT IF EXISTS cities_population_check,
  ADD CONSTRAINT cities_population_check
    CHECK (population IS NULL OR population >= 0) NOT VALID,
  DROP CONSTRAINT IF EXISTS cities_country_population_rank_check,
  ADD CONSTRAINT cities_country_population_rank_check
    CHECK (
      country_population_rank IS NULL
      OR country_population_rank BETWEEN 1 AND 32767
    ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS cities_geonames_id_uidx
  ON public.cities (geonames_id)
  WHERE geonames_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cities_country_population_rank_idx
  ON public.cities (country_id, country_population_rank, population DESC)
  WHERE country_population_rank IS NOT NULL;

CREATE INDEX IF NOT EXISTS cities_country_population_idx
  ON public.cities (country_id, population DESC NULLS LAST);

-- Keep source_records compatible with old rows without running a catalogue-wide
-- backfill under a DDL lock. New values are enforced immediately; the NOT VALID
-- foreign key merely postpones validation of legacy rows.
ALTER TABLE public.source_records
  ADD COLUMN IF NOT EXISTS event_id UUID,
  ADD COLUMN IF NOT EXISTS canonical_url TEXT;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.source_records'::REGCLASS
      AND conname = 'source_records_event_id_fkey'
  ) THEN
    ALTER TABLE public.source_records
      ADD CONSTRAINT source_records_event_id_fkey
      FOREIGN KEY (event_id)
      REFERENCES public.events(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END;
$migration$;

ALTER TABLE public.source_records
  DROP CONSTRAINT IF EXISTS source_records_canonical_url_check,
  ADD CONSTRAINT source_records_canonical_url_check
    CHECK (
      canonical_url IS NULL
      OR canonical_url ~* '^https?://[^[:space:]]+$'
    ) NOT VALID;

CREATE INDEX IF NOT EXISTS source_records_event_fk_idx
  ON public.source_records (event_id, fetched_at DESC)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_records_canonical_url_idx
  ON public.source_records (canonical_url)
  WHERE canonical_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_records_source_url_idx
  ON public.source_records (source_url);

-- Repair the known legacy Turkey placeholder without touching unrelated XX
-- rows. If a canonical TR row already exists, move all known geography
-- dependencies to it. An unknown future foreign key may prevent deletion; in
-- that case the remapping is kept and the harmless legacy row is left in place.
DO $repair_turkey_country$
DECLARE
  legacy_country_id UUID;
  canonical_country_id UUID;
BEGIN
  SELECT country.id
  INTO legacy_country_id
  FROM public.countries AS country
  WHERE country.code = 'XX'
    AND public.unaccent(lower(btrim(country.name))) IN ('turkey', 'turkiye', 'turquie')
  LIMIT 1;

  IF legacy_country_id IS NULL THEN
    RETURN;
  END IF;

  SELECT country.id
  INTO canonical_country_id
  FROM public.countries AS country
  WHERE country.code = 'TR'
  LIMIT 1;

  IF canonical_country_id IS NULL THEN
    UPDATE public.countries
    SET code = 'TR'
    WHERE id = legacy_country_id;
    RETURN;
  END IF;

  UPDATE public.regions
  SET country_id = canonical_country_id
  WHERE country_id = legacy_country_id;

  UPDATE public.cities
  SET country_id = canonical_country_id
  WHERE country_id = legacy_country_id;

  UPDATE public.venues
  SET country_id = canonical_country_id
  WHERE country_id = legacy_country_id;

  BEGIN
    DELETE FROM public.countries
    WHERE id = legacy_country_id;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE NOTICE 'Turkey XX row retained because another foreign key still references it';
  END;
END;
$repair_turkey_country$;

-- ---------------------------------------------------------------------------
-- Private orchestration tables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS private.global_scrape_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_key TEXT NOT NULL UNIQUE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  provider TEXT NOT NULL DEFAULT 'searxng',
  status TEXT NOT NULL DEFAULT 'queued',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_scrape_campaigns_key_check
    CHECK (campaign_key = btrim(campaign_key) AND length(campaign_key) BETWEEN 1 AND 200),
  CONSTRAINT global_scrape_campaigns_dates_check
    CHECK (period_end >= period_start AND period_end <= period_start + 366),
  CONSTRAINT global_scrape_campaigns_provider_check
    CHECK (provider ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT global_scrape_campaigns_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT global_scrape_campaigns_metadata_check
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 262144)
);

CREATE INDEX IF NOT EXISTS global_scrape_campaigns_status_idx
  ON private.global_scrape_campaigns (status, created_at DESC)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS private.global_city_targets (
  city_id UUID PRIMARY KEY REFERENCES public.cities(id) ON DELETE CASCADE,
  country_id UUID NOT NULL REFERENCES public.countries(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority SMALLINT NOT NULL DEFAULT 0,
  population_rank SMALLINT,
  query_budget SMALLINT NOT NULL DEFAULT 16,
  cadence_hours INTEGER NOT NULL DEFAULT 168,
  search_names TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  search_languages TEXT[] NOT NULL DEFAULT ARRAY['en']::TEXT[],
  query_profile JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_scheduled_at TIMESTAMPTZ,
  next_due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_city_targets_priority_check
    CHECK (priority BETWEEN -1000 AND 1000),
  CONSTRAINT global_city_targets_rank_check
    CHECK (population_rank IS NULL OR population_rank BETWEEN 1 AND 32767),
  CONSTRAINT global_city_targets_budget_check
    CHECK (query_budget BETWEEN 1 AND 32),
  CONSTRAINT global_city_targets_cadence_check
    CHECK (cadence_hours BETWEEN 1 AND 8760),
  CONSTRAINT global_city_targets_names_check
    CHECK (cardinality(search_names) <= 32),
  CONSTRAINT global_city_targets_languages_check
    CHECK (cardinality(search_languages) BETWEEN 1 AND 16),
  CONSTRAINT global_city_targets_profile_check
    CHECK (jsonb_typeof(query_profile) = 'object' AND pg_column_size(query_profile) <= 65536)
);

CREATE INDEX IF NOT EXISTS global_city_targets_due_idx
  ON private.global_city_targets (
    next_due_at ASC NULLS FIRST,
    priority DESC,
    population_rank ASC NULLS LAST
  )
  WHERE enabled;

CREATE INDEX IF NOT EXISTS global_city_targets_country_rank_idx
  ON private.global_city_targets (country_id, population_rank)
  WHERE enabled;

CREATE TABLE IF NOT EXISTS private.global_search_cache (
  cache_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  query_text TEXT NOT NULL,
  query_locale TEXT,
  results JSONB NOT NULL DEFAULT '[]'::JSONB,
  result_count SMALLINT NOT NULL DEFAULT 0,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_search_cache_key_check
    CHECK (length(cache_key) BETWEEN 16 AND 256),
  CONSTRAINT global_search_cache_results_check
    CHECK (
      jsonb_typeof(results) = 'array'
      AND jsonb_array_length(results) <= 10
      AND pg_column_size(results) <= 262144
    ),
  CONSTRAINT global_search_cache_count_check
    CHECK (result_count BETWEEN 0 AND 10),
  CONSTRAINT global_search_cache_expiry_check
    CHECK (expires_at >= fetched_at)
);

CREATE INDEX IF NOT EXISTS global_search_cache_expiry_idx
  ON private.global_search_cache (expires_at);

CREATE TABLE IF NOT EXISTS private.global_search_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL
    REFERENCES private.global_scrape_campaigns(id) ON DELETE CASCADE,
  city_id UUID NOT NULL REFERENCES public.cities(id) ON DELETE CASCADE,
  query_kind TEXT NOT NULL,
  query_text TEXT NOT NULL,
  query_locale TEXT,
  provider TEXT NOT NULL DEFAULT 'searxng',
  cache_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority SMALLINT NOT NULL DEFAULT 0,
  attempt_count SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 5,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  result_count SMALLINT NOT NULL DEFAULT 0,
  cache_hit BOOLEAN NOT NULL DEFAULT false,
  http_status SMALLINT,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_search_jobs_identity_unique
    UNIQUE (campaign_id, city_id, query_kind, query_text, provider),
  CONSTRAINT global_search_jobs_kind_check
    CHECK (query_kind ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT global_search_jobs_query_check
    CHECK (length(query_text) BETWEEN 3 AND 1000),
  CONSTRAINT global_search_jobs_provider_check
    CHECK (provider ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT global_search_jobs_cache_key_check
    CHECK (length(cache_key) BETWEEN 16 AND 256),
  CONSTRAINT global_search_jobs_status_check
    CHECK (status IN ('queued', 'leased', 'completed', 'failed', 'cancelled')),
  CONSTRAINT global_search_jobs_attempts_check
    CHECK (attempt_count BETWEEN 0 AND 100 AND max_attempts BETWEEN 1 AND 100),
  CONSTRAINT global_search_jobs_result_count_check
    CHECK (result_count BETWEEN 0 AND 10),
  CONSTRAINT global_search_jobs_lease_check
    CHECK (
      (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR status <> 'leased'
    )
);

CREATE INDEX IF NOT EXISTS global_search_jobs_claim_idx
  ON private.global_search_jobs (priority DESC, available_at, created_at)
  WHERE status IN ('queued', 'leased');

CREATE INDEX IF NOT EXISTS global_search_jobs_campaign_status_idx
  ON private.global_search_jobs (campaign_id, status);

CREATE INDEX IF NOT EXISTS global_search_jobs_expired_lease_idx
  ON private.global_search_jobs (lease_expires_at)
  WHERE status = 'leased';

CREATE TABLE IF NOT EXISTS private.global_search_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_job_id UUID NOT NULL
    REFERENCES private.global_search_jobs(id) ON DELETE CASCADE,
  rank SMALLINT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT,
  snippet TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_search_results_url_unique UNIQUE (search_job_id, canonical_url),
  CONSTRAINT global_search_results_rank_check CHECK (rank BETWEEN 1 AND 10),
  CONSTRAINT global_search_results_url_check
    CHECK (
      url ~* '^https?://[^[:space:]]+$'
      AND canonical_url ~* '^https?://[^[:space:]]+$'
    ),
  CONSTRAINT global_search_results_domain_check
    CHECK (
      domain = lower(domain)
      AND domain !~ '[/@:]'
      AND length(domain) BETWEEN 1 AND 253
    ),
  CONSTRAINT global_search_results_metadata_check
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 65536)
);

CREATE INDEX IF NOT EXISTS global_search_results_domain_idx
  ON private.global_search_results (domain, discovered_at DESC);

-- Rank belongs to a point-in-time SearXNG snapshot. Several historical URLs
-- may therefore have occupied the same rank; canonical URL remains unique.
CREATE INDEX IF NOT EXISTS global_search_results_job_rank_idx
  ON private.global_search_results (search_job_id, rank, discovered_at DESC);

CREATE TABLE IF NOT EXISTS private.global_crawl_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL
    REFERENCES private.global_scrape_campaigns(id) ON DELETE CASCADE,
  search_job_id UUID NOT NULL
    REFERENCES private.global_search_jobs(id) ON DELETE CASCADE,
  search_result_id UUID
    REFERENCES private.global_search_results(id) ON DELETE CASCADE,
  parent_job_id UUID
    REFERENCES private.global_crawl_jobs(id) ON DELETE CASCADE,
  city_id UUID NOT NULL REFERENCES public.cities(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  domain TEXT NOT NULL,
  crawl_kind TEXT NOT NULL DEFAULT 'search_result',
  crawl_depth SMALLINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  priority SMALLINT NOT NULL DEFAULT 0,
  attempt_count SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 4,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  http_status SMALLINT,
  content_hash TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  response_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A generic/dynamic agenda URL may legitimately be returned for several
  -- city searches. City is therefore part of the durable crawl context; URL
  -- alone must never make the first city silently win.
  CONSTRAINT global_crawl_jobs_campaign_city_url_unique
    UNIQUE (campaign_id, city_id, canonical_url),
  CONSTRAINT global_crawl_jobs_url_check
    CHECK (
      url ~* '^https?://[^[:space:]]+$'
      AND canonical_url ~* '^https?://[^[:space:]]+$'
    ),
  CONSTRAINT global_crawl_jobs_domain_check
    CHECK (
      domain = lower(domain)
      AND domain !~ '[/@:]'
      AND length(domain) BETWEEN 1 AND 253
    ),
  CONSTRAINT global_crawl_jobs_kind_check
    CHECK (crawl_kind IN ('search_result', 'event', 'pagination')),
  CONSTRAINT global_crawl_jobs_depth_check
    CHECK (crawl_depth BETWEEN 0 AND 64),
  CONSTRAINT global_crawl_jobs_origin_check
    CHECK (
      (
        crawl_kind = 'search_result'
        AND crawl_depth = 0
        AND search_result_id IS NOT NULL
        AND parent_job_id IS NULL
      )
      OR (
        crawl_kind IN ('event', 'pagination')
        AND crawl_depth BETWEEN 1 AND 64
        AND parent_job_id IS NOT NULL
      )
    ),
  CONSTRAINT global_crawl_jobs_status_check
    CHECK (status IN ('queued', 'leased', 'completed', 'failed', 'skipped', 'cancelled')),
  CONSTRAINT global_crawl_jobs_attempts_check
    CHECK (attempt_count BETWEEN 0 AND 100 AND max_attempts BETWEEN 1 AND 100),
  CONSTRAINT global_crawl_jobs_event_count_check CHECK (event_count >= 0),
  CONSTRAINT global_crawl_jobs_metadata_check
    CHECK (
      jsonb_typeof(response_metadata) = 'object'
      AND pg_column_size(response_metadata) <= 262144
    ),
  CONSTRAINT global_crawl_jobs_lease_check
    CHECK (
      (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR status <> 'leased'
    )
);

CREATE INDEX IF NOT EXISTS global_crawl_jobs_claim_idx
  ON private.global_crawl_jobs (priority DESC, available_at, created_at)
  WHERE status IN ('queued', 'leased');

CREATE INDEX IF NOT EXISTS global_crawl_jobs_campaign_status_idx
  ON private.global_crawl_jobs (campaign_id, status);

CREATE INDEX IF NOT EXISTS global_crawl_jobs_domain_status_idx
  ON private.global_crawl_jobs (domain, status, available_at)
  WHERE status IN ('queued', 'leased');

CREATE INDEX IF NOT EXISTS global_crawl_jobs_expired_lease_idx
  ON private.global_crawl_jobs (lease_expires_at)
  WHERE status = 'leased';

-- Every terminal or retryable crawl outcome is retained. In particular, a
-- page that persisted seven events and failed on the eighth must not lose the
-- failed-event evidence when the URL is retried.
CREATE TABLE IF NOT EXISTS private.global_crawl_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_job_id UUID NOT NULL
    REFERENCES private.global_crawl_jobs(id) ON DELETE CASCADE,
  attempt_number SMALLINT NOT NULL,
  outcome TEXT NOT NULL,
  http_status SMALLINT,
  event_count INTEGER NOT NULL DEFAULT 0,
  event_error_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  response_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_crawl_attempts_attempt_check
    CHECK (attempt_number BETWEEN 1 AND 100),
  CONSTRAINT global_crawl_attempts_outcome_check
    CHECK (outcome IN ('completed', 'partial_retry', 'partial_failed', 'retry', 'failed', 'skipped')),
  CONSTRAINT global_crawl_attempts_counts_check
    CHECK (event_count >= 0 AND event_error_count >= 0),
  CONSTRAINT global_crawl_attempts_metadata_check
    CHECK (
      jsonb_typeof(response_metadata) = 'object'
      AND pg_column_size(response_metadata) <= 262144
    )
);

CREATE INDEX IF NOT EXISTS global_crawl_attempts_job_created_idx
  ON private.global_crawl_attempts (crawl_job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS private.global_domain_crawl_state (
  domain TEXT PRIMARY KEY,
  robots_status TEXT NOT NULL DEFAULT 'unknown',
  robots_rules JSONB NOT NULL DEFAULT '{}'::JSONB,
  robots_fetched_at TIMESTAMPTZ,
  robots_expires_at TIMESTAMPTZ,
  crawl_delay_ms INTEGER NOT NULL DEFAULT 1500,
  next_allowed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  active_crawl_job_id UUID
    REFERENCES private.global_crawl_jobs(id) ON DELETE RESTRICT,
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  last_http_status SMALLINT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_domain_crawl_state_domain_check
    CHECK (
      domain = lower(domain)
      AND domain !~ '[/@:]'
      AND length(domain) BETWEEN 1 AND 253
    ),
  CONSTRAINT global_domain_crawl_state_robots_check
    CHECK (robots_status IN ('unknown', 'allowed', 'disallowed', 'unavailable', 'error')),
  CONSTRAINT global_domain_crawl_state_rules_check
    CHECK (jsonb_typeof(robots_rules) = 'object' AND pg_column_size(robots_rules) <= 262144),
  CONSTRAINT global_domain_crawl_state_delay_check
    CHECK (crawl_delay_ms BETWEEN 250 AND 86400000),
  CONSTRAINT global_domain_crawl_state_failures_check CHECK (consecutive_failures >= 0),
  CONSTRAINT global_domain_crawl_state_lease_check
    CHECK (
      (active_crawl_job_id IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (active_crawl_job_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS global_domain_crawl_state_ready_idx
  ON private.global_domain_crawl_state (next_allowed_at, lease_expires_at);

CREATE INDEX IF NOT EXISTS global_domain_crawl_state_robots_expiry_idx
  ON private.global_domain_crawl_state (robots_expires_at)
  WHERE robots_status <> 'unknown';

CREATE TABLE IF NOT EXISTS private.global_event_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  identity_type TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  source_domain TEXT NOT NULL DEFAULT '',
  confidence NUMERIC(4, 3) NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_event_identities_unique
    UNIQUE (identity_type, source_domain, normalized_value),
  CONSTRAINT global_event_identities_type_check
    CHECK (identity_type ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT global_event_identities_values_check
    CHECK (
      length(identity_value) BETWEEN 1 AND 2000
      AND length(normalized_value) BETWEEN 1 AND 2000
    ),
  CONSTRAINT global_event_identities_domain_check
    CHECK (source_domain = lower(source_domain) AND source_domain !~ '[/@:]'),
  CONSTRAINT global_event_identities_scope_check
    CHECK (
      (identity_type <> 'global_fingerprint' OR source_domain = '')
      AND (identity_type <> 'canonical_occurrence' OR source_domain = '')
      AND (identity_type <> 'external_id' OR source_domain <> '')
    ),
  CONSTRAINT global_event_identities_confidence_check
    CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT global_event_identities_metadata_check
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 65536)
);

CREATE INDEX IF NOT EXISTS global_event_identities_event_idx
  ON private.global_event_identities (event_id, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- Public visitor-facing source links. Writes are only possible through the
-- service-role registration function defined below.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.event_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  domain TEXT NOT NULL,
  source_name TEXT,
  source_title TEXT,
  source_type TEXT NOT NULL DEFAULT 'discovery',
  search_rank SMALLINT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  attribution TEXT,
  image_url TEXT,
  booking_url TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ,
  CONSTRAINT event_sources_event_url_unique UNIQUE (event_id, canonical_url),
  CONSTRAINT event_sources_source_url_check
    CHECK (
      source_url ~* '^https?://[^[:space:]]+$'
      AND canonical_url ~* '^https?://[^[:space:]]+$'
    ),
  CONSTRAINT event_sources_domain_check
    CHECK (
      domain = lower(domain)
      AND domain !~ '[/@:]'
      AND length(domain) BETWEEN 1 AND 253
    ),
  CONSTRAINT event_sources_type_check
    CHECK (source_type ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT event_sources_search_rank_check
    CHECK (search_rank IS NULL OR search_rank BETWEEN 1 AND 10),
  CONSTRAINT event_sources_image_url_check
    CHECK (image_url IS NULL OR image_url ~* '^https?://[^[:space:]]+$'),
  CONSTRAINT event_sources_booking_url_check
    CHECK (booking_url IS NULL OR booking_url ~* '^https?://[^[:space:]]+$')
);

COMMENT ON TABLE public.event_sources IS
  'All public pages that corroborate a canonical event; internal crawl metadata is intentionally excluded.';

CREATE INDEX IF NOT EXISTS event_sources_event_primary_idx
  ON public.event_sources (event_id, is_primary DESC, search_rank ASC NULLS LAST, first_seen_at);

CREATE INDEX IF NOT EXISTS event_sources_domain_idx
  ON public.event_sources (domain, last_seen_at DESC);

REVOKE ALL ON TABLE public.event_sources FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.event_sources TO anon, authenticated;
GRANT ALL ON TABLE public.event_sources TO service_role;

ALTER TABLE public.event_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_sources_public_read ON public.event_sources;
CREATE POLICY event_sources_public_read
ON public.event_sources
FOR SELECT
TO anon, authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.events AS event
    WHERE event.id = event_sources.event_id
      AND NOT event.is_demo
      AND event.status IN ('published', 'cancelled', 'postponed', 'sold_out')
  )
);

-- The historical catalogue core predates worldwide discovery and may insert
-- EUR when neither the page nor the country mapping supplied a currency.
-- Removing the table default protects direct inserts. The narrowly scoped
-- trigger also neutralizes the legacy core's explicit fallback, but only while
-- this wrapper marks a currency as genuinely unknown. Existing, explicitly
-- sourced EUR offers are therefore never erased during a later dedupe update.
ALTER TABLE public.ticket_offers
  ALTER COLUMN currency DROP DEFAULT;

CREATE OR REPLACE FUNCTION private.global_ticket_currency_value_v1(
  _currency TEXT,
  _currency_unknown BOOLEAN
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN _currency_unknown IS TRUE THEN NULL::TEXT
    ELSE _currency
  END;
$$;

CREATE OR REPLACE FUNCTION private.guard_global_ticket_currency_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.currency := private.global_ticket_currency_value_v1(
    NEW.currency,
    coalesce(
      pg_catalog.current_setting(
        'partyfinder.global_currency_unknown',
        true
      ),
      ''
    ) = 'true'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_global_ticket_currency_v1
  ON public.ticket_offers;
CREATE TRIGGER guard_global_ticket_currency_v1
BEFORE INSERT ON public.ticket_offers
FOR EACH ROW
EXECUTE FUNCTION private.guard_global_ticket_currency_v1();

COMMENT ON COLUMN public.ticket_offers.currency IS
  'ISO 4217 code explicitly extracted from a source or deterministically mapped from a known country; NULL when no supported evidence exists.';

-- Executable migration invariant: an unknown currency is null, while an
-- explicit EUR value survives outside the guarded legacy-core call.
DO $global_ticket_currency_invariant$
BEGIN
  IF private.global_ticket_currency_value_v1('EUR', true) IS NOT NULL THEN
    RAISE EXCEPTION 'unknown_ticket_currency_must_remain_null';
  END IF;
  IF private.global_ticket_currency_value_v1('EUR', false) IS DISTINCT FROM 'EUR' THEN
    RAISE EXCEPTION 'explicit_ticket_currency_must_be_preserved';
  END IF;
END;
$global_ticket_currency_invariant$;

-- Private tables are inaccessible to browser roles even if the private schema
-- is exposed accidentally in a future API configuration.
ALTER TABLE private.global_scrape_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.global_city_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.global_search_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.global_search_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.global_search_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.global_crawl_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.global_crawl_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.global_domain_crawl_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.global_event_identities ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  private.global_scrape_campaigns,
  private.global_city_targets,
  private.global_search_cache,
  private.global_search_jobs,
  private.global_search_results,
  private.global_crawl_jobs,
  private.global_crawl_attempts,
  private.global_domain_crawl_state,
  private.global_event_identities
FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA private TO service_role;
GRANT ALL ON TABLE
  private.global_scrape_campaigns,
  private.global_city_targets,
  private.global_search_cache,
  private.global_search_jobs,
  private.global_search_results,
  private.global_crawl_jobs,
  private.global_crawl_attempts,
  private.global_domain_crawl_state,
  private.global_event_identities
TO service_role;

-- ---------------------------------------------------------------------------
-- Geography import and campaign coordination RPCs.
-- ---------------------------------------------------------------------------

-- The legacy upsert builds its identity key with [a-z0-9]. Japanese, Arabic,
-- Cyrillic and other titles can therefore collapse to the same empty/short
-- title key. Re-key only new inserts whose ASCII title key has fewer than three
-- characters. UPDATE is deliberately excluded so existing identities remain
-- stable. The Unicode title also repairs the legacy all-ASCII slug collision.
CREATE OR REPLACE FUNCTION private.unicode_event_fingerprint_v1(
  _fingerprint TEXT,
  _title TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN _fingerprint IS NULL OR _title IS NULL THEN _fingerprint
    WHEN length(regexp_replace(
      public.unaccent(lower(_title)),
      '[^a-z0-9]+',
      '',
      'g'
    )) >= 3 THEN _fingerprint
    ELSE encode(
      extensions.digest(
        _fingerprint || '|' || lower(
          regexp_replace(
            normalize(btrim(_title), NFC),
            '[[:space:]]+',
            ' ',
            'g'
          )
        ),
        'sha256'
      ),
      'hex'
    )
  END;
$$;

CREATE OR REPLACE FUNCTION private.protect_unicode_event_fingerprint_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  protected_fingerprint TEXT;
BEGIN
  protected_fingerprint := private.unicode_event_fingerprint_v1(
    NEW.canonical_fingerprint,
    NEW.title
  );

  IF protected_fingerprint IS DISTINCT FROM NEW.canonical_fingerprint THEN
    NEW.canonical_fingerprint := protected_fingerprint;
    NEW.slug := 'event-' || left(protected_fingerprint, 32);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_events_unicode_fingerprint_fallback_v1
  ON public.events;
CREATE TRIGGER trg_events_unicode_fingerprint_fallback_v1
BEFORE INSERT ON public.events
FOR EACH ROW
EXECUTE FUNCTION private.protect_unicode_event_fingerprint_v1();

COMMENT ON FUNCTION private.unicode_event_fingerprint_v1(TEXT, TEXT) IS
  'Insert-only fallback: salts legacy ASCII-only fingerprints with an NFC-normalized Unicode title when the ASCII title key has fewer than three characters.';

-- Migration invariant test: distinct non-Latin titles must not share an
-- identity, while normal Latin titles keep the legacy fingerprint unchanged.
DO $unicode_fingerprint_test$
DECLARE
  original_fingerprint CONSTANT TEXT := repeat('a', 64);
  tokyo_fingerprint TEXT;
  osaka_fingerprint TEXT;
BEGIN
  tokyo_fingerprint := private.unicode_event_fingerprint_v1(
    original_fingerprint,
    '東京祭'
  );
  osaka_fingerprint := private.unicode_event_fingerprint_v1(
    original_fingerprint,
    '大阪祭'
  );

  IF tokyo_fingerprint = osaka_fingerprint
    OR tokyo_fingerprint = original_fingerprint
    OR private.unicode_event_fingerprint_v1(
      original_fingerprint,
      'Summer festival'
    ) <> original_fingerprint
  THEN
    RAISE EXCEPTION 'unicode_event_fingerprint_invariant_failed';
  END IF;
END;
$unicode_fingerprint_test$;

-- Keep the crawl-eligibility workaround inside every ingestion transaction.
-- Automated data_sources must be marked is_verified=true for the legacy writer
-- to accept them, but that flag is not editorial verification. Provenance is
-- derived from durable source_records: an event first created by automation is
-- demoted after every automated refresh unless a real verified/editorial source
-- has also ingested that exact canonical event.
CREATE OR REPLACE FUNCTION private.populate_source_record_links_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  extracted_event_id UUID;
BEGIN
  IF NEW.event_id IS NULL
    AND coalesce(NEW.extracted_data->>'event_id', '') ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  THEN
    extracted_event_id := (NEW.extracted_data->>'event_id')::UUID;
    IF EXISTS (SELECT 1 FROM public.events AS event WHERE event.id = extracted_event_id) THEN
      NEW.event_id := extracted_event_id;
    END IF;
  END IF;

  IF NEW.canonical_url IS NULL
    AND NEW.source_url ~* '^https?://[^[:space:]]+$'
  THEN
    NEW.canonical_url := left(NEW.source_url, 2000);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_source_records_populate_links_v1
  ON public.source_records;
CREATE TRIGGER trg_source_records_populate_links_v1
BEFORE INSERT OR UPDATE OF extracted_data, source_url, event_id
ON public.source_records
FOR EACH ROW
EXECUTE FUNCTION private.populate_source_record_links_v1();

CREATE OR REPLACE FUNCTION private.event_is_automated_only_v1(_event_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.source_records AS record
      JOIN public.data_sources AS source ON source.id = record.data_source_id
      WHERE coalesce(
        record.event_id,
        CASE
          WHEN coalesce(record.extracted_data->>'event_id', '') ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            THEN (record.extracted_data->>'event_id')::UUID
          ELSE NULL
        END
      ) = _event_id
        AND record.extracted_data->>'action' = 'created'
        AND coalesce(source.metadata->>'automated_discovery', 'false') = 'true'
        AND source.metadata->>'verification_scope' = 'crawl_eligibility_only'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.source_records AS record
      JOIN public.data_sources AS source ON source.id = record.data_source_id
      WHERE coalesce(
        record.event_id,
        CASE
          WHEN coalesce(record.extracted_data->>'event_id', '') ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            THEN (record.extracted_data->>'event_id')::UUID
          ELSE NULL
        END
      ) = _event_id
        AND source.is_verified
        AND coalesce(source.metadata->>'automated_discovery', 'false') <> 'true'
        AND coalesce(source.metadata->>'verification_scope', '') <> 'crawl_eligibility_only'
    );
$$;

CREATE OR REPLACE FUNCTION private.demote_automated_discovery_verification_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  event_id_value UUID;
BEGIN
  event_id_value := coalesce(
    NEW.event_id,
    CASE
      WHEN coalesce(NEW.extracted_data->>'event_id', '') ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN (NEW.extracted_data->>'event_id')::UUID
      ELSE NULL
    END
  );

  IF event_id_value IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.data_sources AS source
      WHERE source.id = NEW.data_source_id
        AND coalesce(source.metadata->>'automated_discovery', 'false') = 'true'
        AND source.metadata->>'verification_scope' = 'crawl_eligibility_only'
    )
  THEN
    RETURN NEW;
  END IF;

  IF NOT private.event_is_automated_only_v1(event_id_value) THEN
    RETURN NEW;
  END IF;

  UPDATE public.events
  SET
    is_verified = false,
    verification_level = 'unverified'::public.verification_level
  WHERE id = event_id_value;

  UPDATE public.organizers AS organizer
  SET
    is_verified = false,
    verification_level = 'unverified'::public.verification_level
  WHERE organizer.id = (
    SELECT event.organizer_id
    FROM public.events AS event
    WHERE event.id = event_id_value
  )
    AND NOT EXISTS (
      SELECT 1
      FROM public.events AS other_event
      WHERE other_event.organizer_id = organizer.id
        AND other_event.id <> event_id_value
        AND other_event.is_verified
    );

  UPDATE public.venues AS venue
  SET is_verified = false
  WHERE venue.id = (
    SELECT event.venue_id
    FROM public.events AS event
    WHERE event.id = event_id_value
  )
    AND NOT EXISTS (
      SELECT 1
      FROM public.events AS other_event
      WHERE other_event.venue_id = venue.id
        AND other_event.id <> event_id_value
        AND other_event.is_verified
    );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_source_records_demote_automated_discovery_v1
  ON public.source_records;
CREATE TRIGGER trg_source_records_demote_automated_discovery_v1
AFTER INSERT OR UPDATE OF extracted_data, event_id, data_source_id
ON public.source_records
FOR EACH ROW
EXECUTE FUNCTION private.demote_automated_discovery_verification_v1();

COMMENT ON FUNCTION private.demote_automated_discovery_verification_v1() IS
  'After every automated source-record write, keeps automation-created events unverified unless durable provenance contains a genuine verified non-automated source.';

CREATE OR REPLACE FUNCTION private.global_discovery_domain(_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT nullif(
    regexp_replace(
      regexp_replace(
        lower(btrim(coalesce(_value, ''))),
        '[.]$',
        ''
      ),
      '^www[0-9]*[.]',
      ''
    ),
    ''
  );
$$;

-- Security-sensitive crawl state is origin-host scoped. Unlike
-- global_discovery_domain(), this helper deliberately preserves a leading
-- www/wwwN label so a robots decision or lease can never cross hostnames.
CREATE OR REPLACE FUNCTION private.global_discovery_hostname(_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT nullif(
    regexp_replace(
      lower(btrim(coalesce(_value, ''))),
      '[.]$',
      ''
    ),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION private.global_event_fingerprint_v1(
  _payload JSONB,
  _source_city_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  title_key TEXT;
  starts_at_value TIMESTAMPTZ;
  place_key TEXT;
BEGIN
  IF jsonb_typeof(_payload) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;

  title_key := lower(regexp_replace(
    normalize(public.unaccent(btrim(coalesce(_payload->>'title', ''))), NFC),
    '[^[:alnum:]]+',
    '',
    'g'
  ));

  BEGIN
    starts_at_value := nullif(btrim(_payload->>'starts_at'), '')::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  -- Prefer the location published by the event page. The search city is only
  -- a fallback: a regional agenda can be discovered from two neighbouring
  -- city queries and must still converge on one domain-independent identity.
  place_key := coalesce(
    nullif(lower(regexp_replace(
      normalize(public.unaccent(concat_ws(
        '|',
        btrim(_payload->>'country_code'),
        btrim(_payload->>'city')
      )), NFC),
      '[^[:alnum:]|]+',
      '',
      'g'
    )), ''),
    _source_city_id::TEXT,
    'world'
  );

  IF title_key = '' OR starts_at_value IS NULL THEN
    RETURN NULL;
  END IF;

  -- Deliberately independent from source domain, URL and provider IDs. The
  -- minute and stable city context distinguish separate performances while
  -- allowing two unrelated sites to converge on one canonical event.
  RETURN encode(
    extensions.digest(
      title_key || '|' ||
      to_char(starts_at_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') || '|' ||
      place_key,
      'sha256'
    ),
    'hex'
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.global_event_canonical_occurrence_v1(_payload JSONB)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  source_url_value TEXT;
  starts_at_value TIMESTAMPTZ;
  title_key TEXT;
BEGIN
  IF jsonb_typeof(_payload) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;

  source_url_value := regexp_replace(
    btrim(coalesce(_payload->>'source_url', '')),
    '#.*$',
    ''
  );
  IF source_url_value !~* '^https?://[^[:space:]]+$' THEN
    RETURN NULL;
  END IF;

  BEGIN
    starts_at_value := nullif(btrim(_payload->>'starts_at'), '')::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  title_key := lower(regexp_replace(
    normalize(public.unaccent(btrim(coalesce(_payload->>'title', ''))), NFC),
    '[^[:alnum:]]+',
    '',
    'g'
  ));
  IF title_key = '' OR starts_at_value IS NULL THEN
    RETURN NULL;
  END IF;

  -- A detail URL can be rediscovered from neighbouring city queries. Include
  -- occurrence minute and title so a dynamic agenda page containing several
  -- events never becomes an identity by URL alone.
  RETURN encode(
    extensions.digest(
      source_url_value || '|' ||
      to_char(starts_at_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') || '|' ||
      title_key,
      'sha256'
    ),
    'hex'
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.merge_fresh_global_event_v1(
  _canonical_event_id UUID,
  _duplicate_event_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF _canonical_event_id IS NULL
    OR _duplicate_event_id IS NULL
    OR _canonical_event_id = _duplicate_event_id
  THEN
    RETURN;
  END IF;

  -- This path is only for a row created by the catalog core in the current
  -- transaction after a cross-site canonical identity was already resolved.
  IF NOT EXISTS (
    SELECT 1
    FROM public.events AS duplicate
    WHERE duplicate.id = _duplicate_event_id
      AND duplicate.created_at >= transaction_timestamp()
  ) OR NOT EXISTS (
    SELECT 1 FROM public.events AS canonical
    WHERE canonical.id = _canonical_event_id
  ) THEN
    RAISE EXCEPTION 'global_dedupe_merge_not_fresh' USING ERRCODE = '55000';
  END IF;

  UPDATE public.events AS canonical
  SET
    short_description = CASE
      WHEN length(coalesce(duplicate.short_description, '')) >
        length(coalesce(canonical.short_description, ''))
        THEN duplicate.short_description
      ELSE canonical.short_description
    END,
    description = CASE
      WHEN length(coalesce(duplicate.description, '')) >
        length(coalesce(canonical.description, ''))
        THEN duplicate.description
      ELSE canonical.description
    END,
    category_id = coalesce(canonical.category_id, duplicate.category_id),
    organizer_id = coalesce(canonical.organizer_id, duplicate.organizer_id),
    venue_id = coalesce(canonical.venue_id, duplicate.venue_id),
    city_id = coalesce(canonical.city_id, duplicate.city_id),
    is_free = canonical.is_free OR duplicate.is_free,
    official_url = coalesce(canonical.official_url, duplicate.official_url),
    cover_image_url = coalesce(canonical.cover_image_url, duplicate.cover_image_url),
    genres = ARRAY(
      SELECT DISTINCT genre
      FROM unnest(coalesce(canonical.genres, ARRAY[]::TEXT[]) ||
        coalesce(duplicate.genres, ARRAY[]::TEXT[])) AS genre
    ),
    quality_score = greatest(canonical.quality_score, duplicate.quality_score),
    last_seen_at = greatest(canonical.last_seen_at, duplicate.last_seen_at)
  FROM public.events AS duplicate
  WHERE canonical.id = _canonical_event_id
    AND duplicate.id = _duplicate_event_id;

  INSERT INTO public.event_occurrences (
    event_id,
    starts_at,
    ends_at,
    doors_open_at,
    timezone,
    local_start_date,
    local_end_date,
    status,
    ticket_status,
    capacity,
    latitude,
    longitude,
    time_precision,
    all_day
  )
  SELECT
    _canonical_event_id,
    occurrence.starts_at,
    occurrence.ends_at,
    occurrence.doors_open_at,
    occurrence.timezone,
    occurrence.local_start_date,
    occurrence.local_end_date,
    occurrence.status,
    occurrence.ticket_status,
    occurrence.capacity,
    occurrence.latitude,
    occurrence.longitude,
    occurrence.time_precision,
    occurrence.all_day
  FROM public.event_occurrences AS occurrence
  WHERE occurrence.event_id = _duplicate_event_id
  ON CONFLICT (event_id, starts_at) DO UPDATE SET
    ends_at = coalesce(EXCLUDED.ends_at, public.event_occurrences.ends_at),
    doors_open_at = coalesce(EXCLUDED.doors_open_at, public.event_occurrences.doors_open_at),
    local_end_date = coalesce(EXCLUDED.local_end_date, public.event_occurrences.local_end_date),
    capacity = coalesce(EXCLUDED.capacity, public.event_occurrences.capacity),
    latitude = coalesce(EXCLUDED.latitude, public.event_occurrences.latitude),
    longitude = coalesce(EXCLUDED.longitude, public.event_occurrences.longitude);

  INSERT INTO public.event_performers (event_id, performer_id, is_headliner)
  SELECT _canonical_event_id, performer_id, is_headliner
  FROM public.event_performers
  WHERE event_id = _duplicate_event_id
  ON CONFLICT (event_id, performer_id) DO UPDATE SET
    is_headliner = public.event_performers.is_headliner OR EXCLUDED.is_headliner;

  UPDATE public.event_media
  SET event_id = _canonical_event_id
  WHERE event_id = _duplicate_event_id;

  UPDATE public.ticket_offers
  SET event_id = _canonical_event_id
  WHERE event_id = _duplicate_event_id;

  INSERT INTO public.event_accessibility (
    event_id, wheelchair, hearing_loop, sign_language, quiet_space, notes
  )
  SELECT
    _canonical_event_id, wheelchair, hearing_loop, sign_language, quiet_space, notes
  FROM public.event_accessibility
  WHERE event_id = _duplicate_event_id
  ON CONFLICT (event_id) DO UPDATE SET
    wheelchair = public.event_accessibility.wheelchair OR EXCLUDED.wheelchair,
    hearing_loop = public.event_accessibility.hearing_loop OR EXCLUDED.hearing_loop,
    sign_language = public.event_accessibility.sign_language OR EXCLUDED.sign_language,
    quiet_space = public.event_accessibility.quiet_space OR EXCLUDED.quiet_space,
    notes = coalesce(public.event_accessibility.notes, EXCLUDED.notes);

  UPDATE public.event_status_history
  SET event_id = _canonical_event_id
  WHERE event_id = _duplicate_event_id;

  UPDATE public.source_records
  SET
    event_id = _canonical_event_id,
    extracted_data = jsonb_set(
      coalesce(extracted_data, '{}'::JSONB),
      '{event_id}',
      to_jsonb(_canonical_event_id),
      true
    )
  WHERE event_id = _duplicate_event_id
    OR extracted_data->>'event_id' = _duplicate_event_id::TEXT;

  INSERT INTO public.event_scraped_details (event_id, details, updated_at)
  SELECT _canonical_event_id, details, now()
  FROM public.event_scraped_details
  WHERE event_id = _duplicate_event_id
  ON CONFLICT (event_id) DO UPDATE SET
    details = public.event_scraped_details.details || EXCLUDED.details,
    updated_at = now();

  DELETE FROM private.global_event_identities AS duplicate_identity
  WHERE duplicate_identity.event_id = _duplicate_event_id
    AND EXISTS (
      SELECT 1
      FROM private.global_event_identities AS canonical_identity
      WHERE canonical_identity.event_id = _canonical_event_id
        AND canonical_identity.identity_type = duplicate_identity.identity_type
        AND canonical_identity.source_domain = duplicate_identity.source_domain
        AND canonical_identity.normalized_value = duplicate_identity.normalized_value
    );

  UPDATE private.global_event_identities
  SET event_id = _canonical_event_id
  WHERE event_id = _duplicate_event_id;

  DELETE FROM public.event_sources AS duplicate_source
  WHERE duplicate_source.event_id = _duplicate_event_id
    AND EXISTS (
      SELECT 1
      FROM public.event_sources AS canonical_source
      WHERE canonical_source.event_id = _canonical_event_id
        AND canonical_source.canonical_url = duplicate_source.canonical_url
    );

  UPDATE public.event_sources
  SET event_id = _canonical_event_id
  WHERE event_id = _duplicate_event_id;

  DELETE FROM public.events
  WHERE id = _duplicate_event_id;
END;
$$;

-- Existing Edge callers keep using this signature. This wrapper resolves the
-- cross-site identity before the catalog core runs, serializes every contender
-- on one domain-independent SHA-256 fingerprint, and returns the canonical id.
CREATE OR REPLACE FUNCTION public.upsert_ingested_event_v2(
  _data_source_id UUID,
  _payload JSONB
)
RETURNS TABLE(event_id UUID, action TEXT, score INT, published BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payload JSONB := _payload;
  v_source public.data_sources%ROWTYPE;
  v_result RECORD;
  v_country_code TEXT := upper(nullif(btrim(_payload->>'country_code'), ''));
  v_input_currency TEXT := upper(nullif(btrim(_payload->>'currency'), ''));
  v_currency TEXT;
  v_currency_unknown BOOLEAN := false;
  v_previous_currency_guard TEXT;
  v_source_latitude DOUBLE PRECISION;
  v_source_longitude DOUBLE PRECISION;
  v_latitude DOUBLE PRECISION;
  v_longitude DOUBLE PRECISION;
  v_starts_at TIMESTAMPTZ;
  v_domain TEXT;
  v_source_url TEXT;
  v_global_fingerprint TEXT;
  v_canonical_occurrence TEXT;
  v_provider_external_id TEXT := nullif(left(btrim(_payload->>'external_identifier'), 500), '');
  v_external_identity TEXT;
  v_synthetic_external_id TEXT;
  v_canonical_event_id UUID;
  v_is_automated_discovery BOOLEAN := false;
BEGIN
  IF jsonb_typeof(_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
  END IF;

  SELECT source.*
  INTO v_source
  FROM public.data_sources AS source
  WHERE source.id = _data_source_id
    AND source.status = 'active'
    AND source.is_authorized
    AND source.is_verified;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_not_authorized' USING ERRCODE = '42501';
  END IF;

  v_domain := private.global_discovery_domain(v_source.domain);
  v_is_automated_discovery :=
    coalesce(v_source.metadata->>'automated_discovery', 'false') = 'true'
    AND v_source.metadata->>'verification_scope' = 'crawl_eligibility_only';
  v_source_url := CASE
    WHEN coalesce(_payload->>'source_url', '') ~* '^https?://[^[:space:]]+$'
      THEN left(btrim(_payload->>'source_url'), 2000)
    ELSE left(coalesce(v_source.base_url, 'https://' || v_domain || '/'), 2000)
  END;

  IF v_country_code IS NULL OR v_country_code !~ '^[A-Z]{2}$' THEN
    SELECT upper(country.code)
    INTO v_country_code
    FROM public.cities AS city
    LEFT JOIN public.countries AS country ON country.id = city.country_id
    WHERE city.id = v_source.city_id;
  END IF;

  IF coalesce(upper(btrim(_payload->>'currency')), '') !~ '^[A-Z]{3}$'
    AND v_country_code ~ '^[A-Z]{2}$'
  THEN
    v_currency := CASE v_country_code
      WHEN 'AD' THEN 'EUR' WHEN 'AT' THEN 'EUR' WHEN 'BE' THEN 'EUR'
      WHEN 'CH' THEN 'CHF' WHEN 'GB' THEN 'GBP' WHEN 'US' THEN 'USD'
      WHEN 'CY' THEN 'EUR' WHEN 'DE' THEN 'EUR' WHEN 'EE' THEN 'EUR'
      WHEN 'ES' THEN 'EUR' WHEN 'FI' THEN 'EUR' WHEN 'FR' THEN 'EUR'
      WHEN 'GR' THEN 'EUR' WHEN 'HR' THEN 'EUR' WHEN 'IE' THEN 'EUR'
      WHEN 'IT' THEN 'EUR' WHEN 'LT' THEN 'EUR' WHEN 'LU' THEN 'EUR'
      WHEN 'LV' THEN 'EUR' WHEN 'MC' THEN 'EUR' WHEN 'ME' THEN 'EUR'
      WHEN 'MT' THEN 'EUR' WHEN 'NL' THEN 'EUR' WHEN 'PT' THEN 'EUR'
      WHEN 'SI' THEN 'EUR' WHEN 'SK' THEN 'EUR' WHEN 'SM' THEN 'EUR'
      WHEN 'VA' THEN 'EUR' WHEN 'XK' THEN 'EUR'
      WHEN 'CA' THEN 'CAD' WHEN 'AU' THEN 'AUD' WHEN 'NZ' THEN 'NZD'
      WHEN 'JP' THEN 'JPY' WHEN 'PL' THEN 'PLN' WHEN 'CZ' THEN 'CZK'
      WHEN 'HU' THEN 'HUF' WHEN 'SE' THEN 'SEK' WHEN 'NO' THEN 'NOK'
      WHEN 'DK' THEN 'DKK' WHEN 'MX' THEN 'MXN' WHEN 'KR' THEN 'KRW'
      WHEN 'SG' THEN 'SGD' WHEN 'AE' THEN 'AED' WHEN 'ZA' THEN 'ZAR'
      WHEN 'MA' THEN 'MAD' ELSE NULL
    END;
    IF v_currency IS NOT NULL THEN
      v_payload := jsonb_set(v_payload, '{currency}', to_jsonb(v_currency), true);
    END IF;
  END IF;

  v_currency_unknown :=
    coalesce(v_input_currency, '') !~ '^[A-Z]{3}$'
    AND v_currency IS NULL;

  BEGIN
    v_source_latitude := (_payload->>'latitude')::DOUBLE PRECISION;
  EXCEPTION WHEN OTHERS THEN
    v_source_latitude := NULL;
  END;
  BEGIN
    v_source_longitude := (_payload->>'longitude')::DOUBLE PRECISION;
  EXCEPTION WHEN OTHERS THEN
    v_source_longitude := NULL;
  END;

  SELECT normalized.latitude, normalized.longitude
  INTO v_latitude, v_longitude
  FROM private.normalize_coordinate_pair(
    v_country_code,
    v_source_latitude,
    v_source_longitude
  ) AS normalized;

  v_payload := jsonb_set(
    jsonb_set(
      v_payload,
      '{latitude}',
      coalesce(to_jsonb(v_latitude), 'null'::JSONB),
      true
    ),
    '{longitude}',
    coalesce(to_jsonb(v_longitude), 'null'::JSONB),
    true
  );

  -- Official/editorial collectors keep their established ingestion semantics;
  -- the cross-domain convergence contract is specific to automated discovery.
  IF NOT v_is_automated_discovery THEN
    v_previous_currency_guard := pg_catalog.current_setting(
      'partyfinder.global_currency_unknown',
      true
    );
    PERFORM pg_catalog.set_config(
      'partyfinder.global_currency_unknown',
      CASE WHEN v_currency_unknown THEN 'true' ELSE 'false' END,
      true
    );
    RETURN QUERY
    SELECT result.event_id, result.action, result.score, result.published
    FROM public.upsert_ingested_event_v2_catalog_core(
      _data_source_id,
      v_payload
    ) AS result;
    PERFORM pg_catalog.set_config(
      'partyfinder.global_currency_unknown',
      coalesce(v_previous_currency_guard, ''),
      true
    );
    RETURN;
  END IF;

  v_global_fingerprint := private.global_event_fingerprint_v1(
    v_payload,
    v_source.city_id
  );
  IF v_global_fingerprint IS NULL THEN
    RAISE EXCEPTION 'global_event_identity_required' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_starts_at := (v_payload->>'starts_at')::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid_start_date' USING ERRCODE = '22023';
  END;

  v_canonical_occurrence := private.global_event_canonical_occurrence_v1(v_payload);

  v_synthetic_external_id := 'global:' || v_global_fingerprint;
  v_external_identity := CASE
    WHEN v_provider_external_id IS NULL OR v_domain IS NULL THEN NULL
    ELSE lower(v_provider_external_id) || '|' ||
      to_char(v_starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI')
  END;

  PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'global-event-fingerprint|' || v_global_fingerprint,
    0
  ));

  IF v_canonical_occurrence IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'global-event-canonical-occurrence|' || v_canonical_occurrence,
      0
    ));

    SELECT identity.event_id
    INTO v_canonical_event_id
    FROM private.global_event_identities AS identity
    JOIN public.events AS event ON event.id = identity.event_id
    WHERE identity.identity_type = 'canonical_occurrence'
      AND identity.source_domain = ''
      AND identity.normalized_value = v_canonical_occurrence
    ORDER BY identity.first_seen_at, identity.event_id
    LIMIT 1;
  END IF;

  IF v_canonical_event_id IS NULL THEN
    SELECT identity.event_id
    INTO v_canonical_event_id
    FROM private.global_event_identities AS identity
    JOIN public.events AS event ON event.id = identity.event_id
    WHERE identity.identity_type = 'global_fingerprint'
      AND identity.source_domain = ''
      AND identity.normalized_value = v_global_fingerprint
    ORDER BY identity.first_seen_at, identity.event_id
    LIMIT 1;
  END IF;

  IF v_canonical_event_id IS NULL AND v_external_identity IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'global-event-external|' || v_domain || '|' || v_external_identity,
      0
    ));

    SELECT identity.event_id
    INTO v_canonical_event_id
    FROM private.global_event_identities AS identity
    JOIN public.events AS event ON event.id = identity.event_id
    WHERE identity.identity_type = 'external_id'
      AND identity.source_domain = v_domain
      AND identity.normalized_value = v_external_identity
    ORDER BY identity.first_seen_at, identity.event_id
    LIMIT 1;
  END IF;

  IF v_canonical_event_id IS NOT NULL THEN
    -- The legacy core already knows how to update a source-scoped external id.
    -- Seed that lookup with the canonical id so venue spelling differences do
    -- not make it create a second event after global identity resolution.
    INSERT INTO public.source_records (
      data_source_id,
      source_url,
      external_identifier,
      extracted_data,
      content_hash,
      processing_status,
      processed_at,
      event_id,
      canonical_url
    )
    SELECT
      candidate_source.id,
      v_source_url,
      v_synthetic_external_id,
      jsonb_build_object(
        'event_id', v_canonical_event_id,
        'action', 'dedupe_seed',
        'global_fingerprint', v_global_fingerprint
      ),
      v_global_fingerprint,
      'processed',
      now(),
      v_canonical_event_id,
      v_source_url
    FROM public.data_sources AS candidate_source
    WHERE (
      candidate_source.id = v_source.id
      OR candidate_source.metadata->>'parent_source_id' = v_source.id::TEXT
    )
      AND NOT EXISTS (
        SELECT 1
        FROM public.source_records AS existing
        WHERE existing.data_source_id = candidate_source.id
          AND existing.external_identifier = v_synthetic_external_id
          AND existing.event_id = v_canonical_event_id
      );
  END IF;

  v_payload := jsonb_set(
    jsonb_set(
      v_payload,
      '{external_identifier}',
      to_jsonb(v_synthetic_external_id),
      true
    ),
    '{global_fingerprint}',
    to_jsonb(v_global_fingerprint),
    true
  );
  IF v_provider_external_id IS NOT NULL THEN
    v_payload := jsonb_set(
      v_payload,
      '{provider_external_identifier}',
      to_jsonb(v_provider_external_id),
      true
    );
  END IF;

  v_previous_currency_guard := pg_catalog.current_setting(
    'partyfinder.global_currency_unknown',
    true
  );
  PERFORM pg_catalog.set_config(
    'partyfinder.global_currency_unknown',
    CASE WHEN v_currency_unknown THEN 'true' ELSE 'false' END,
    true
  );

  SELECT result.*
  INTO v_result
  FROM public.upsert_ingested_event_v2_catalog_core(
    _data_source_id,
    v_payload
  ) AS result;

  PERFORM pg_catalog.set_config(
    'partyfinder.global_currency_unknown',
    coalesce(v_previous_currency_guard, ''),
    true
  );

  IF v_canonical_event_id IS NOT NULL
    AND v_result.event_id IS DISTINCT FROM v_canonical_event_id
  THEN
    IF v_result.action <> 'created' THEN
      RAISE EXCEPTION 'global_dedupe_resolved_nonfresh_duplicate'
        USING ERRCODE = '55000';
    END IF;
    PERFORM private.merge_fresh_global_event_v1(
      v_canonical_event_id,
      v_result.event_id
    );
    v_result.event_id := v_canonical_event_id;
    v_result.action := 'updated';
  ELSE
    v_canonical_event_id := v_result.event_id;
  END IF;

  INSERT INTO private.global_event_identities (
    event_id,
    identity_type,
    identity_value,
    normalized_value,
    source_domain,
    confidence,
    metadata,
    last_seen_at
  )
  VALUES (
    v_canonical_event_id,
    'global_fingerprint',
    v_global_fingerprint,
    v_global_fingerprint,
    '',
    1,
    jsonb_build_object(
      'algorithm', 'global_event_fingerprint_v1',
      'domain_independent', true
    ),
    now()
  )
  ON CONFLICT (identity_type, source_domain, normalized_value) DO UPDATE SET
    event_id = EXCLUDED.event_id,
    confidence = 1,
    metadata = private.global_event_identities.metadata || EXCLUDED.metadata,
    last_seen_at = now();

  IF v_canonical_occurrence IS NOT NULL THEN
    INSERT INTO private.global_event_identities (
      event_id,
      identity_type,
      identity_value,
      normalized_value,
      source_domain,
      confidence,
      metadata,
      last_seen_at
    )
    VALUES (
      v_canonical_event_id,
      'canonical_occurrence',
      v_source_url,
      v_canonical_occurrence,
      '',
      1,
      jsonb_build_object(
        'algorithm', 'canonical_url_start_title_v1',
        'starts_at', v_starts_at
      ),
      now()
    )
    ON CONFLICT (identity_type, source_domain, normalized_value) DO UPDATE SET
      event_id = EXCLUDED.event_id,
      confidence = 1,
      metadata = private.global_event_identities.metadata || EXCLUDED.metadata,
      last_seen_at = now();
  END IF;

  IF v_external_identity IS NOT NULL THEN
    INSERT INTO private.global_event_identities (
      event_id,
      identity_type,
      identity_value,
      normalized_value,
      source_domain,
      confidence,
      metadata,
      last_seen_at
    )
    VALUES (
      v_canonical_event_id,
      'external_id',
      v_provider_external_id,
      v_external_identity,
      v_domain,
      1,
      jsonb_build_object('starts_at', v_starts_at),
      now()
    )
    ON CONFLICT (identity_type, source_domain, normalized_value) DO UPDATE SET
      event_id = EXCLUDED.event_id,
      confidence = 1,
      metadata = private.global_event_identities.metadata || EXCLUDED.metadata,
      last_seen_at = now();
  END IF;

  RETURN QUERY
  SELECT
    v_result.event_id,
    v_result.action,
    v_result.score,
    v_result.published;
END;
$$;

COMMENT ON FUNCTION private.global_event_fingerprint_v1(JSONB, UUID) IS
  'SHA-256 identity over normalized title, UTC start minute and the published event city (search city only as fallback); intentionally excludes source domain, URL and provider id.';

COMMENT ON FUNCTION private.global_event_canonical_occurrence_v1(JSONB) IS
  'SHA-256 identity over canonical source URL, UTC start minute and normalized title so one detail page rediscovered from neighbouring city searches converges without treating a dynamic agenda URL alone as an event.';

COMMENT ON FUNCTION public.upsert_ingested_event_v2(UUID, JSONB) IS
  'SERVICE-ROLE RPC CONTRACT: for automated_discovery sources, atomically resolves a domain-independent global_fingerprint under an advisory transaction lock, scopes provider external_id to source domain plus occurrence minute, calls the rich catalog core, merges only a fresh in-transaction duplicate, and always returns the canonical event_id; official/editorial sources retain legacy v2 semantics. Signature: public.upsert_ingested_event_v2(_data_source_id uuid, _payload jsonb) returns table(event_id uuid, action text, score int, published boolean). Every corroborating URL must then be passed to register_global_event_source with this returned event_id.';

CREATE OR REPLACE FUNCTION public.import_global_city_targets(_rows JSONB)
RETURNS TABLE (
  countries_upserted INTEGER,
  cities_upserted INTEGER,
  targets_upserted INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  item JSONB;
  country_code_value TEXT;
  country_iso3_value TEXT;
  country_name_value TEXT;
  country_id_value UUID;
  city_id_value UUID;
  city_name_value TEXT;
  city_slug_value TEXT;
  city_slug_base TEXT;
  city_geonames_value BIGINT;
  latitude_value DOUBLE PRECISION;
  longitude_value DOUBLE PRECISION;
  postgis_schema_value TEXT;
  city_location_value public.cities.location%TYPE;
  population_rank_value SMALLINT;
  country_languages_value TEXT[];
  city_search_names_value TEXT[];
  city_search_languages_value TEXT[];
BEGIN
  IF jsonb_typeof(_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'rows_must_be_an_array' USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(_rows) > 2000 THEN
    RAISE EXCEPTION 'batch_too_large' USING ERRCODE = '22023';
  END IF;

  SELECT namespace.nspname
  INTO postgis_schema_value
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'postgis';

  IF postgis_schema_value IS NULL THEN
    RAISE EXCEPTION 'postgis_extension_required' USING ERRCODE = '55000';
  END IF;

  countries_upserted := 0;
  cities_upserted := 0;
  targets_upserted := 0;

  FOR item IN
    SELECT value
    FROM jsonb_array_elements(_rows)
  LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'row_must_be_an_object' USING ERRCODE = '22023';
    END IF;

    country_code_value := upper(btrim(coalesce(item->>'country_code', '')));
    country_iso3_value := upper(nullif(btrim(item->>'country_iso3'), ''));
    country_name_value := left(btrim(coalesce(item->>'country_name', '')), 180);
    city_name_value := left(btrim(coalesce(item->>'city_name', '')), 180);
    city_geonames_value := nullif(item->>'city_geonames_id', '')::BIGINT;
    latitude_value := nullif(item->>'latitude', '')::DOUBLE PRECISION;
    longitude_value := nullif(item->>'longitude', '')::DOUBLE PRECISION;
    population_rank_value := nullif(item->>'country_population_rank', '')::SMALLINT;

    IF country_code_value !~ '^[A-Z]{2}$'
      OR (country_iso3_value IS NOT NULL AND country_iso3_value !~ '^[A-Z]{3}$')
      OR country_name_value = ''
      OR city_name_value = ''
      OR city_geonames_value IS NULL
      OR city_geonames_value <= 0
      OR latitude_value NOT BETWEEN -90 AND 90
      OR longitude_value NOT BETWEEN -180 AND 180
    THEN
      RAISE EXCEPTION 'invalid_geography_row: %', item USING ERRCODE = '22023';
    END IF;

    EXECUTE pg_catalog.format(
      'SELECT %I.st_setsrid(%I.st_makepoint($1, $2), 4326)::%I.geography',
      postgis_schema_value,
      postgis_schema_value,
      postgis_schema_value
    )
    INTO city_location_value
    USING longitude_value, latitude_value;

    country_languages_value := ARRAY(
      SELECT DISTINCT left(lower(btrim(language.value)), 35)
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(item->'country_languages') = 'array'
            THEN item->'country_languages'
          ELSE '[]'::JSONB
        END
      ) AS language(value)
      WHERE btrim(language.value) <> ''
      LIMIT 16
    );

    PERFORM pg_advisory_xact_lock(
      pg_catalog.hashtextextended('global-country|' || country_code_value, 0)
    );

    INSERT INTO public.countries (
      code,
      iso3,
      name,
      geonames_id,
      population,
      area_sq_km,
      languages
    )
    VALUES (
      country_code_value,
      country_iso3_value,
      country_name_value,
      nullif(item->>'country_geonames_id', '')::BIGINT,
      nullif(item->>'country_population', '')::BIGINT,
      nullif(item->>'country_area_sq_km', '')::NUMERIC,
      country_languages_value
    )
    ON CONFLICT (code) DO UPDATE SET
      iso3 = coalesce(EXCLUDED.iso3, public.countries.iso3),
      name = CASE
        WHEN public.countries.name = public.countries.code THEN EXCLUDED.name
        ELSE public.countries.name
      END,
      geonames_id = coalesce(EXCLUDED.geonames_id, public.countries.geonames_id),
      population = coalesce(EXCLUDED.population, public.countries.population),
      area_sq_km = coalesce(EXCLUDED.area_sq_km, public.countries.area_sq_km),
      languages = CASE
        WHEN cardinality(EXCLUDED.languages) > 0 THEN EXCLUDED.languages
        ELSE public.countries.languages
      END
    RETURNING id INTO country_id_value;

    countries_upserted := countries_upserted + 1;

    city_search_names_value := ARRAY(
      SELECT DISTINCT left(btrim(candidate.value), 180)
      FROM (
        SELECT value
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(item->'search_names') = 'array'
              THEN item->'search_names'
            ELSE '[]'::JSONB
          END
        )
        UNION ALL SELECT city_name_value
        UNION ALL SELECT nullif(left(btrim(item->>'city_ascii_name'), 180), '')
      ) AS candidate(value)
      WHERE nullif(btrim(candidate.value), '') IS NOT NULL
      LIMIT 32
    );

    city_search_languages_value := ARRAY(
      SELECT DISTINCT left(lower(btrim(candidate.value)), 35)
      FROM (
        SELECT value
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(item->'search_languages') = 'array'
              THEN item->'search_languages'
            ELSE '[]'::JSONB
          END
        )
        UNION ALL
        SELECT unnest(country_languages_value)
        UNION ALL SELECT 'en'
      ) AS candidate(value)
      WHERE nullif(btrim(candidate.value), '') IS NOT NULL
      LIMIT 16
    );

    PERFORM pg_advisory_xact_lock(
      pg_catalog.hashtextextended('global-city|' || city_geonames_value::TEXT, 0)
    );

    SELECT city.id
    INTO city_id_value
    FROM public.cities AS city
    WHERE city.geonames_id = city_geonames_value
    LIMIT 1;

    IF city_id_value IS NULL THEN
      SELECT city.id
      INTO city_id_value
      FROM public.cities AS city
      WHERE city.country_id = country_id_value
        AND public.unaccent(lower(city.name)) = public.unaccent(lower(city_name_value))
        AND (
          (
            city.location IS NOT NULL
            AND extensions.st_dwithin(
              city.location,
              city_location_value,
              50000
            )
          )
          OR (
            city.location IS NULL
            AND city.latitude IS NOT NULL
            AND city.longitude IS NOT NULL
            AND 6371 * 2 * asin(sqrt(least(
              1.0::DOUBLE PRECISION,
              power(sin(radians((city.latitude - latitude_value) / 2)), 2)
              + cos(radians(latitude_value)) * cos(radians(city.latitude))
              * power(sin(radians((city.longitude - longitude_value) / 2)), 2)
            ))) <= 50
          )
        )
      ORDER BY
        CASE
          WHEN city.location IS NOT NULL THEN
            extensions.st_distance(city.location, city_location_value) / 1000
          ELSE
            6371 * 2 * asin(sqrt(least(
              1.0::DOUBLE PRECISION,
              power(sin(radians((city.latitude - latitude_value) / 2)), 2)
              + cos(radians(latitude_value)) * cos(radians(city.latitude))
              * power(sin(radians((city.longitude - longitude_value) / 2)), 2)
            )))
        END,
        city.created_at
      LIMIT 1;
    END IF;

    IF city_id_value IS NULL THEN
      city_slug_base := left(
        trim(both '-' from regexp_replace(
          public.unaccent(lower(
            coalesce(nullif(btrim(item->>'city_slug'), ''), city_name_value || '-' || country_code_value)
          )),
          '[^a-z0-9]+',
          '-',
          'g'
        )),
        100
      );
      city_slug_base := coalesce(nullif(city_slug_base, ''), 'city');
      city_slug_value := city_slug_base;

      IF EXISTS (SELECT 1 FROM public.cities WHERE slug = city_slug_value) THEN
        city_slug_value := left(city_slug_base, 100) || '-' || city_geonames_value::TEXT;
      END IF;

      INSERT INTO public.cities (
        country_id,
        slug,
        name,
        timezone,
        latitude,
        longitude,
        location,
        geonames_id,
        ascii_name,
        population,
        is_capital,
        country_population_rank,
        alternate_names,
        search_names,
        search_languages,
        feature_code
      )
      VALUES (
        country_id_value,
        city_slug_value,
        city_name_value,
        coalesce(nullif(btrim(item->>'timezone'), ''), 'UTC'),
        latitude_value,
        longitude_value,
        city_location_value,
        city_geonames_value,
        nullif(left(btrim(item->>'city_ascii_name'), 180), ''),
        nullif(item->>'city_population', '')::BIGINT,
        coalesce((item->>'is_capital')::BOOLEAN, false),
        population_rank_value,
        ARRAY(
          SELECT DISTINCT left(btrim(name.value), 180)
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(item->'alternate_names') = 'array'
                THEN item->'alternate_names'
              ELSE '[]'::JSONB
            END
          ) AS name(value)
          WHERE btrim(name.value) <> ''
          LIMIT 64
        ),
        city_search_names_value,
        city_search_languages_value,
        nullif(left(upper(btrim(item->>'feature_code')), 16), '')
      )
      RETURNING id INTO city_id_value;
    ELSE
      UPDATE public.cities
      SET
        geonames_id = coalesce(public.cities.geonames_id, city_geonames_value),
        ascii_name = coalesce(
          nullif(left(btrim(item->>'city_ascii_name'), 180), ''),
          public.cities.ascii_name
        ),
        timezone = coalesce(nullif(btrim(item->>'timezone'), ''), public.cities.timezone),
        latitude = latitude_value,
        longitude = longitude_value,
        location = city_location_value,
        population = coalesce(
          nullif(item->>'city_population', '')::BIGINT,
          public.cities.population
        ),
        is_capital = public.cities.is_capital OR coalesce((item->>'is_capital')::BOOLEAN, false),
        country_population_rank = coalesce(population_rank_value, public.cities.country_population_rank),
        alternate_names = CASE
          WHEN jsonb_typeof(item->'alternate_names') = 'array' THEN ARRAY(
            SELECT DISTINCT left(btrim(name.value), 180)
            FROM jsonb_array_elements_text(item->'alternate_names') AS name(value)
            WHERE btrim(name.value) <> ''
            LIMIT 64
          )
          ELSE public.cities.alternate_names
        END,
        search_names = city_search_names_value,
        search_languages = city_search_languages_value,
        feature_code = coalesce(
          nullif(left(upper(btrim(item->>'feature_code')), 16), ''),
          public.cities.feature_code
        )
      WHERE public.cities.id = city_id_value;
    END IF;

    cities_upserted := cities_upserted + 1;

    INSERT INTO private.global_city_targets (
      city_id,
      country_id,
      enabled,
      priority,
      population_rank,
      query_budget,
      cadence_hours,
      search_names,
      search_languages,
      query_profile,
      next_due_at,
      updated_at
    )
    VALUES (
      city_id_value,
      country_id_value,
      coalesce((item->>'enabled')::BOOLEAN, true),
      coalesce(nullif(item->>'priority', '')::SMALLINT, 0),
      population_rank_value,
      coalesce(nullif(item->>'query_budget', '')::SMALLINT, 16),
      coalesce(nullif(item->>'cadence_hours', '')::INTEGER, 168),
      city_search_names_value,
      city_search_languages_value,
      CASE
        WHEN jsonb_typeof(item->'query_profile') = 'object' THEN item->'query_profile'
        ELSE '{}'::JSONB
      END,
      coalesce(nullif(item->>'next_due_at', '')::TIMESTAMPTZ, now()),
      now()
    )
    ON CONFLICT (city_id) DO UPDATE SET
      country_id = EXCLUDED.country_id,
      enabled = EXCLUDED.enabled,
      priority = EXCLUDED.priority,
      population_rank = EXCLUDED.population_rank,
      query_budget = EXCLUDED.query_budget,
      cadence_hours = EXCLUDED.cadence_hours,
      search_names = EXCLUDED.search_names,
      search_languages = EXCLUDED.search_languages,
      query_profile = EXCLUDED.query_profile,
      next_due_at = CASE
        WHEN private.global_city_targets.next_due_at IS NULL THEN EXCLUDED.next_due_at
        ELSE private.global_city_targets.next_due_at
      END,
      updated_at = now();

    targets_upserted := targets_upserted + 1;
  END LOOP;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_global_city_targets(
  _country_codes TEXT[],
  _selected_geonames_ids BIGINT[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  country_codes_value TEXT[];
  selected_ids_value BIGINT[] := coalesce(_selected_geonames_ids, ARRAY[]::BIGINT[]);
  disabled_count INTEGER := 0;
BEGIN
  SELECT array_agg(DISTINCT upper(btrim(code)))
  INTO country_codes_value
  FROM unnest(coalesce(_country_codes, ARRAY[]::TEXT[])) AS code
  WHERE btrim(code) <> '';

  IF coalesce(cardinality(country_codes_value), 0) = 0
    OR cardinality(country_codes_value) > 300
    OR cardinality(selected_ids_value) > 20000
    OR EXISTS (
      SELECT 1 FROM unnest(country_codes_value) AS code
      WHERE code !~ '^[A-Z]{2}$'
    )
  THEN
    RAISE EXCEPTION 'invalid_city_target_reconciliation' USING ERRCODE = '22023';
  END IF;

  UPDATE private.global_city_targets AS target
  SET
    enabled = false,
    updated_at = now(),
    query_profile = target.query_profile || jsonb_build_object(
      'disabled_reason', 'not_in_latest_geonames_selection',
      'disabled_at', now()
    )
  FROM public.cities AS city
  JOIN public.countries AS country ON country.id = city.country_id
  WHERE target.city_id = city.id
    AND country.code = ANY(country_codes_value)
    AND coalesce(target.query_profile->>'source', '') LIKE 'GeoNames %'
    AND NOT coalesce(city.geonames_id = ANY(selected_ids_value), false)
    AND target.enabled;

  GET DIAGNOSTICS disabled_count = ROW_COUNT;
  RETURN disabled_count;
END;
$$;

COMMENT ON FUNCTION public.reconcile_global_city_targets(TEXT[], BIGINT[]) IS
  'Service-role full-sync step: disables prior GeoNames targets in the supplied countries when their GeoNames id is absent from the latest adaptive top-N selection.';

CREATE OR REPLACE FUNCTION public.ensure_global_scrape_campaign(
  _campaign_key TEXT,
  _period_start DATE,
  _period_end DATE,
  _provider TEXT DEFAULT 'searxng',
  _metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  campaign_id_value UUID;
  normalized_key TEXT := left(btrim(coalesce(_campaign_key, '')), 200);
  normalized_provider TEXT := lower(btrim(coalesce(_provider, 'searxng')));
BEGIN
  IF normalized_key = ''
    OR normalized_provider !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    OR _period_start IS NULL
    OR _period_end IS NULL
    OR _period_end < _period_start
    OR _period_end > _period_start + 366
    OR jsonb_typeof(_metadata) IS DISTINCT FROM 'object'
    OR pg_column_size(_metadata) > 262144
  THEN
    RAISE EXCEPTION 'invalid_campaign' USING ERRCODE = '22023';
  END IF;

  INSERT INTO private.global_scrape_campaigns (
    campaign_key,
    period_start,
    period_end,
    provider,
    metadata
  )
  VALUES (
    normalized_key,
    _period_start,
    _period_end,
    normalized_provider,
    _metadata
  )
  ON CONFLICT (campaign_key) DO UPDATE SET
    metadata = private.global_scrape_campaigns.metadata || EXCLUDED.metadata,
    updated_at = now()
  WHERE private.global_scrape_campaigns.period_start = EXCLUDED.period_start
    AND private.global_scrape_campaigns.period_end = EXCLUDED.period_end
    AND private.global_scrape_campaigns.provider = EXCLUDED.provider
  RETURNING id INTO campaign_id_value;

  IF campaign_id_value IS NULL THEN
    RAISE EXCEPTION 'campaign_key_conflict' USING ERRCODE = '23505';
  END IF;

  RETURN campaign_id_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_due_global_city_targets(
  _limit INTEGER DEFAULT 250,
  _as_of TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
  city_id UUID,
  city_name TEXT,
  country_code TEXT,
  country_name TEXT,
  timezone TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  population BIGINT,
  country_population_rank INTEGER,
  search_names TEXT[],
  search_languages TEXT[],
  query_profile JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    city.id,
    city.name,
    country.code,
    country.name,
    city.timezone,
    city.latitude,
    city.longitude,
    city.population,
    target.population_rank::INTEGER,
    target.search_names,
    target.search_languages,
    target.query_profile
  FROM private.global_city_targets AS target
  JOIN public.cities AS city ON city.id = target.city_id
  JOIN public.countries AS country ON country.id = target.country_id
  WHERE target.enabled
    AND (target.next_due_at IS NULL OR target.next_due_at <= coalesce(_as_of, now()))
  ORDER BY
    target.priority DESC,
    target.next_due_at ASC NULLS FIRST,
    target.population_rank ASC NULLS LAST,
    city.population DESC NULLS LAST,
    city.id
  LIMIT greatest(1, least(coalesce(_limit, 250), 2000));
$$;

CREATE OR REPLACE FUNCTION public.enqueue_global_search_jobs(
  _campaign_id UUID,
  _jobs JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  item JSONB;
  city_id_value UUID;
  query_kind_value TEXT;
  query_text_value TEXT;
  query_locale_value TEXT;
  provider_value TEXT;
  cache_key_value TEXT;
  accepted_count INTEGER := 0;
  scheduled_city_ids UUID[] := ARRAY[]::UUID[];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM private.global_scrape_campaigns AS campaign
    WHERE campaign.id = _campaign_id
      AND campaign.status IN ('queued', 'running', 'completed')
  ) THEN
    RAISE EXCEPTION 'campaign_not_runnable' USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(_jobs) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'jobs_must_be_an_array' USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(_jobs) > 5000 THEN
    RAISE EXCEPTION 'batch_too_large' USING ERRCODE = '22023';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(_jobs)
  LOOP
    city_id_value := nullif(item->>'city_id', '')::UUID;
    query_kind_value := lower(btrim(coalesce(item->>'query_kind', '')));
    query_text_value := left(btrim(coalesce(item->>'query_text', '')), 1000);
    query_locale_value := nullif(left(lower(btrim(item->>'query_locale')), 35), '');
    provider_value := lower(btrim(coalesce(item->>'provider', 'searxng')));
    cache_key_value := left(btrim(coalesce(item->>'cache_key', '')), 256);

    IF city_id_value IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM private.global_city_targets AS target
        WHERE target.city_id = city_id_value AND target.enabled
      )
      OR query_kind_value !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
      OR length(query_text_value) < 3
      OR provider_value !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
      OR length(cache_key_value) < 16
    THEN
      RAISE EXCEPTION 'invalid_search_job: %', item USING ERRCODE = '22023';
    END IF;

    INSERT INTO private.global_search_jobs (
      campaign_id,
      city_id,
      query_kind,
      query_text,
      query_locale,
      provider,
      cache_key,
      priority,
      available_at
    )
    VALUES (
      _campaign_id,
      city_id_value,
      query_kind_value,
      query_text_value,
      query_locale_value,
      provider_value,
      cache_key_value,
      greatest(-1000, least(1000, coalesce(nullif(item->>'priority', '')::INTEGER, 0)))::SMALLINT,
      coalesce(nullif(item->>'available_at', '')::TIMESTAMPTZ, now())
    )
    ON CONFLICT (campaign_id, city_id, query_kind, query_text, provider)
    DO UPDATE SET
      cache_key = EXCLUDED.cache_key,
      priority = greatest(private.global_search_jobs.priority, EXCLUDED.priority),
      available_at = least(private.global_search_jobs.available_at, EXCLUDED.available_at),
      status = CASE
        WHEN private.global_search_jobs.status IN ('completed', 'failed')
          AND coalesce(
            private.global_search_jobs.finished_at,
            private.global_search_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN 'queued'
        ELSE private.global_search_jobs.status
      END,
      attempt_count = CASE
        WHEN private.global_search_jobs.status IN ('completed', 'failed')
          AND coalesce(
            private.global_search_jobs.finished_at,
            private.global_search_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN 0
        ELSE private.global_search_jobs.attempt_count
      END,
      lease_owner = CASE
        WHEN private.global_search_jobs.status IN ('completed', 'failed')
          AND coalesce(
            private.global_search_jobs.finished_at,
            private.global_search_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN NULL
        ELSE private.global_search_jobs.lease_owner
      END,
      lease_expires_at = CASE
        WHEN private.global_search_jobs.status IN ('completed', 'failed')
          AND coalesce(
            private.global_search_jobs.finished_at,
            private.global_search_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN NULL
        ELSE private.global_search_jobs.lease_expires_at
      END,
      finished_at = CASE
        WHEN private.global_search_jobs.status IN ('completed', 'failed')
          AND coalesce(
            private.global_search_jobs.finished_at,
            private.global_search_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN NULL
        ELSE private.global_search_jobs.finished_at
      END,
      updated_at = now();

    accepted_count := accepted_count + 1;
    scheduled_city_ids := array_append(scheduled_city_ids, city_id_value);
  END LOOP;

  UPDATE private.global_city_targets AS target
  SET
    last_scheduled_at = now(),
    next_due_at = now() + make_interval(hours => target.cadence_hours),
    updated_at = now()
  WHERE target.city_id = ANY(scheduled_city_ids);

  UPDATE private.global_scrape_campaigns
  SET
    status = 'running',
    started_at = coalesce(started_at, now()),
    finished_at = NULL,
    updated_at = now()
  WHERE id = _campaign_id;

  -- If every proposed job was already completed, immediately close the
  -- reopened campaign again. New query text leaves at least one queued job and
  -- therefore keeps it running.
  PERFORM private.refresh_global_scrape_campaign_v1(_campaign_id);

  RETURN accepted_count;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_global_scrape_campaign_v1(
  _campaign_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  has_pending BOOLEAN;
  has_jobs BOOLEAN;
BEGIN
  SELECT
    EXISTS (
      SELECT 1
      FROM private.global_search_jobs AS job
      WHERE job.campaign_id = _campaign_id
        AND job.status IN ('queued', 'leased')
      UNION ALL
      SELECT 1
      FROM private.global_crawl_jobs AS job
      WHERE job.campaign_id = _campaign_id
        AND job.status IN ('queued', 'leased')
    ),
    EXISTS (
      SELECT 1 FROM private.global_search_jobs AS job
      WHERE job.campaign_id = _campaign_id
    )
  INTO has_pending, has_jobs;

  UPDATE private.global_scrape_campaigns
  SET
    status = CASE
      WHEN status IN ('failed', 'cancelled') THEN status
      WHEN has_pending THEN 'running'
      WHEN has_jobs THEN 'completed'
      ELSE status
    END,
    started_at = CASE
      WHEN has_jobs THEN coalesce(started_at, now())
      ELSE started_at
    END,
    finished_at = CASE
      WHEN status NOT IN ('failed', 'cancelled') AND has_jobs AND NOT has_pending
        THEN coalesce(finished_at, now())
      ELSE finished_at
    END,
    updated_at = now()
  WHERE id = _campaign_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_global_search_jobs(
  _worker_id UUID,
  _limit INTEGER DEFAULT 5,
  _lease_seconds INTEGER DEFAULT 120
)
RETURNS TABLE (
  job_id UUID,
  campaign_id UUID,
  city_id UUID,
  query_kind TEXT,
  query_text TEXT,
  query_locale TEXT,
  provider TEXT,
  cache_key TEXT,
  attempt_count INTEGER,
  max_attempts INTEGER,
  cached_results JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  exhausted_campaign RECORD;
BEGIN
  IF _worker_id IS NULL THEN
    RAISE EXCEPTION 'worker_id_required' USING ERRCODE = '22023';
  END IF;

  FOR exhausted_campaign IN
    UPDATE private.global_search_jobs AS job
    SET
      status = 'failed',
      lease_owner = NULL,
      lease_expires_at = NULL,
      error_code = coalesce(job.error_code, 'lease_expired'),
      error_message = coalesce(job.error_message, 'Worker lease expired after the final attempt.'),
      finished_at = now(),
      updated_at = now()
    WHERE job.status = 'leased'
      AND job.lease_expires_at <= now()
      AND job.attempt_count >= job.max_attempts
    RETURNING job.campaign_id
  LOOP
    PERFORM private.refresh_global_scrape_campaign_v1(
      exhausted_campaign.campaign_id
    );
  END LOOP;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT job.id
    FROM private.global_search_jobs AS job
    JOIN private.global_scrape_campaigns AS campaign
      ON campaign.id = job.campaign_id
    WHERE campaign.status IN ('queued', 'running')
      AND job.available_at <= now()
      AND job.attempt_count < job.max_attempts
      AND (
        job.status = 'queued'
        OR (job.status = 'leased' AND job.lease_expires_at <= now())
      )
    ORDER BY job.priority DESC, job.available_at, job.created_at, job.id
    LIMIT greatest(1, least(coalesce(_limit, 5), 50))
    FOR UPDATE OF job SKIP LOCKED
  ),
  claimed AS (
    UPDATE private.global_search_jobs AS job
    SET
      status = 'leased',
      attempt_count = job.attempt_count + 1,
      lease_owner = _worker_id,
      lease_expires_at = now() + make_interval(
        secs => greatest(30, least(coalesce(_lease_seconds, 120), 900))
      ),
      started_at = coalesce(job.started_at, now()),
      error_code = NULL,
      error_message = NULL,
      updated_at = now()
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.*
  )
  SELECT
    claimed.id,
    claimed.campaign_id,
    claimed.city_id,
    claimed.query_kind,
    claimed.query_text,
    claimed.query_locale,
    claimed.provider,
    claimed.cache_key,
    claimed.attempt_count::INTEGER,
    claimed.max_attempts::INTEGER,
    cache.results
  FROM claimed
  LEFT JOIN private.global_search_cache AS cache
    ON cache.cache_key = claimed.cache_key
    AND cache.provider = claimed.provider
    AND cache.expires_at > now()
  ORDER BY claimed.priority DESC, claimed.created_at, claimed.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_global_search_job(
  _job_id UUID,
  _worker_id UUID,
  _results JSONB,
  _cache_ttl_seconds INTEGER DEFAULT 86400,
  _cache_hit BOOLEAN DEFAULT false
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  search_job private.global_search_jobs%ROWTYPE;
  result_item JSONB;
  result_ordinal BIGINT;
  url_value TEXT;
  canonical_url_value TEXT;
  domain_value TEXT;
  result_id_value UUID;
  accepted_count INTEGER := 0;
  normalized_results JSONB := '[]'::JSONB;
BEGIN
  IF jsonb_typeof(_results) IS DISTINCT FROM 'array'
    OR jsonb_array_length(_results) > 10
    OR pg_column_size(_results) > 262144
  THEN
    RAISE EXCEPTION 'invalid_search_results' USING ERRCODE = '22023';
  END IF;

  SELECT job.*
  INTO search_job
  FROM private.global_search_jobs AS job
  WHERE job.id = _job_id
    AND job.status = 'leased'
    AND job.lease_owner = _worker_id
    AND job.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'search_job_lease_not_owned' USING ERRCODE = '55000';
  END IF;

  FOR result_item, result_ordinal IN
    SELECT value, ordinality
    FROM jsonb_array_elements(_results) WITH ORDINALITY
  LOOP
    url_value := left(btrim(coalesce(result_item->>'url', '')), 2000);
    canonical_url_value := left(
      btrim(coalesce(nullif(result_item->>'canonical_url', ''), url_value)),
      2000
    );
    -- Crawl/robots state is origin-host scoped. Keep www (and every other
    -- subdomain) distinct even though the search-result diversity layer may
    -- group www.example.test with example.test as one site.
    domain_value := nullif(lower(rtrim(
      substring(canonical_url_value FROM '^https?://([^/?#:]+)'),
      '.'
    )), '');

    IF url_value !~* '^https?://[^[:space:]]+$'
      OR canonical_url_value !~* '^https?://[^[:space:]]+$'
      OR domain_value IS NULL
      OR domain_value ~ '[/@:]'
      OR length(domain_value) > 253
    THEN
      CONTINUE;
    END IF;

    INSERT INTO private.global_search_results (
      search_job_id,
      rank,
      url,
      canonical_url,
      domain,
      title,
      snippet,
      metadata
    )
    VALUES (
      search_job.id,
      result_ordinal::SMALLINT,
      url_value,
      canonical_url_value,
      domain_value,
      nullif(left(btrim(result_item->>'title'), 1000), ''),
      nullif(left(btrim(result_item->>'snippet'), 4000), ''),
      CASE
        WHEN jsonb_typeof(result_item->'metadata') = 'object'
          AND pg_column_size(result_item->'metadata') <= 65536
          THEN result_item->'metadata'
        ELSE '{}'::JSONB
      END
    )
    ON CONFLICT (search_job_id, canonical_url) DO UPDATE SET
      rank = EXCLUDED.rank,
      url = EXCLUDED.url,
      domain = EXCLUDED.domain,
      title = coalesce(EXCLUDED.title, private.global_search_results.title),
      snippet = coalesce(EXCLUDED.snippet, private.global_search_results.snippet),
      metadata = private.global_search_results.metadata || EXCLUDED.metadata,
      discovered_at = now()
    RETURNING id INTO result_id_value;

    INSERT INTO private.global_domain_crawl_state (domain)
    VALUES (domain_value)
    ON CONFLICT (domain) DO NOTHING;

    INSERT INTO private.global_crawl_jobs (
      campaign_id,
      search_job_id,
      search_result_id,
      city_id,
      url,
      canonical_url,
      domain,
      priority
    )
    VALUES (
      search_job.campaign_id,
      search_job.id,
      result_id_value,
      search_job.city_id,
      url_value,
      canonical_url_value,
      domain_value,
      search_job.priority
    )
    ON CONFLICT (campaign_id, city_id, canonical_url) DO UPDATE SET
      search_job_id = EXCLUDED.search_job_id,
      search_result_id = EXCLUDED.search_result_id,
      url = EXCLUDED.url,
      domain = EXCLUDED.domain,
      priority = greatest(private.global_crawl_jobs.priority, EXCLUDED.priority),
      status = CASE
        WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
          AND coalesce(
            private.global_crawl_jobs.finished_at,
            private.global_crawl_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN 'queued'
        ELSE private.global_crawl_jobs.status
      END,
      attempt_count = CASE
        WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
          AND coalesce(
            private.global_crawl_jobs.finished_at,
            private.global_crawl_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN 0
        ELSE private.global_crawl_jobs.attempt_count
      END,
      available_at = CASE
        WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
          AND coalesce(
            private.global_crawl_jobs.finished_at,
            private.global_crawl_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN now()
        ELSE private.global_crawl_jobs.available_at
      END,
      lease_owner = CASE
        WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
          AND coalesce(
            private.global_crawl_jobs.finished_at,
            private.global_crawl_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN NULL
        ELSE private.global_crawl_jobs.lease_owner
      END,
      lease_expires_at = CASE
        WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
          AND coalesce(
            private.global_crawl_jobs.finished_at,
            private.global_crawl_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN NULL
        ELSE private.global_crawl_jobs.lease_expires_at
      END,
      finished_at = CASE
        WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
          AND coalesce(
            private.global_crawl_jobs.finished_at,
            private.global_crawl_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN NULL
        ELSE private.global_crawl_jobs.finished_at
      END,
      updated_at = now();

    normalized_results := normalized_results || jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'rank', result_ordinal,
        'url', url_value,
        'canonical_url', canonical_url_value,
        'domain', domain_value,
        'title', nullif(left(btrim(result_item->>'title'), 1000), ''),
        'snippet', nullif(left(btrim(result_item->>'snippet'), 4000), '')
      ))
    );
    accepted_count := accepted_count + 1;
  END LOOP;

  IF NOT coalesce(_cache_hit, false) THEN
    INSERT INTO private.global_search_cache (
      cache_key,
      provider,
      query_text,
      query_locale,
      results,
      result_count,
      fetched_at,
      expires_at,
      updated_at
    )
    VALUES (
      search_job.cache_key,
      search_job.provider,
      search_job.query_text,
      search_job.query_locale,
      normalized_results,
      accepted_count,
      now(),
      now() + make_interval(
        secs => greatest(300, least(coalesce(_cache_ttl_seconds, 86400), 2592000))
      ),
      now()
    )
    ON CONFLICT (cache_key) DO UPDATE SET
      provider = EXCLUDED.provider,
      query_text = EXCLUDED.query_text,
      query_locale = EXCLUDED.query_locale,
      results = EXCLUDED.results,
      result_count = EXCLUDED.result_count,
      fetched_at = EXCLUDED.fetched_at,
      expires_at = EXCLUDED.expires_at,
      updated_at = now();
  END IF;

  UPDATE private.global_search_jobs
  SET
    status = 'completed',
    result_count = accepted_count,
    cache_hit = coalesce(_cache_hit, false),
    lease_owner = NULL,
    lease_expires_at = NULL,
    finished_at = now(),
    updated_at = now()
  WHERE id = search_job.id;

  PERFORM private.refresh_global_scrape_campaign_v1(search_job.campaign_id);
  RETURN accepted_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_global_search_job(
  _job_id UUID,
  _worker_id UUID,
  _error_code TEXT,
  _error_message TEXT,
  _http_status INTEGER DEFAULT NULL,
  _retry_after_seconds INTEGER DEFAULT 300,
  _terminal BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  search_job private.global_search_jobs%ROWTYPE;
  terminal_failure BOOLEAN;
BEGIN
  SELECT job.*
  INTO search_job
  FROM private.global_search_jobs AS job
  WHERE job.id = _job_id
    AND job.status = 'leased'
    AND job.lease_owner = _worker_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  terminal_failure := coalesce(_terminal, false)
    OR search_job.attempt_count >= search_job.max_attempts;

  UPDATE private.global_search_jobs
  SET
    status = CASE WHEN terminal_failure THEN 'failed' ELSE 'queued' END,
    available_at = CASE
      WHEN terminal_failure THEN available_at
      ELSE now() + make_interval(
        secs => greatest(30, least(coalesce(_retry_after_seconds, 300), 86400))
      )
    END,
    lease_owner = NULL,
    lease_expires_at = NULL,
    http_status = CASE
      WHEN _http_status BETWEEN 100 AND 599 THEN _http_status::SMALLINT
      ELSE NULL
    END,
    error_code = nullif(left(btrim(_error_code), 100), ''),
    error_message = nullif(left(btrim(_error_message), 2000), ''),
    finished_at = CASE WHEN terminal_failure THEN now() ELSE NULL END,
    updated_at = now()
  WHERE id = search_job.id;

  PERFORM private.refresh_global_scrape_campaign_v1(search_job.campaign_id);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_global_crawl_continuations(
  _parent_job_id UUID,
  _worker_id UUID,
  _continuations JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  parent_job private.global_crawl_jobs%ROWTYPE;
  item JSONB;
  url_value TEXT;
  canonical_url_value TEXT;
  hostname_value TEXT;
  kind_value TEXT;
  accepted_count INTEGER := 0;
BEGIN
  IF _worker_id IS NULL
    OR jsonb_typeof(_continuations) IS DISTINCT FROM 'array'
    OR jsonb_array_length(_continuations) > 100
    OR pg_column_size(_continuations) > 262144
  THEN
    RAISE EXCEPTION 'invalid_crawl_continuations' USING ERRCODE = '22023';
  END IF;

  SELECT job.*
  INTO parent_job
  FROM private.global_crawl_jobs AS job
  WHERE job.id = _parent_job_id
    AND job.status = 'leased'
    AND job.lease_owner = _worker_id
    AND job.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'crawl_job_lease_not_owned' USING ERRCODE = '55000';
  END IF;

  IF parent_job.crawl_depth >= 64 AND jsonb_array_length(_continuations) > 0 THEN
    -- Never pretend an agenda was exhausted when the safety ceiling was hit.
    -- The worker records a visible failed attempt instead of silently losing
    -- the remaining pages.
    RAISE EXCEPTION 'crawl_continuation_depth_limit' USING ERRCODE = '54000';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(_continuations)
  LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'invalid_crawl_continuation_item' USING ERRCODE = '22023';
    END IF;

    url_value := left(btrim(coalesce(item->>'url', '')), 2000);
    canonical_url_value := left(
      btrim(coalesce(nullif(item->>'canonical_url', ''), url_value)),
      2000
    );
    kind_value := lower(btrim(coalesce(item->>'kind', '')));
    hostname_value := nullif(lower(rtrim(
      substring(canonical_url_value FROM '^https?://([^/?#:]+)'),
      '.'
    )), '');

    IF url_value !~* '^https?://[^[:space:]]+$'
      OR canonical_url_value !~* '^https?://[^[:space:]]+$'
      OR kind_value NOT IN ('event', 'pagination')
      OR nullif(lower(rtrim(
        substring(url_value FROM '^https?://([^/?#:]+)'),
        '.'
      )), '') IS DISTINCT FROM parent_job.domain
      OR hostname_value IS DISTINCT FROM parent_job.domain
    THEN
      RAISE EXCEPTION 'cross_domain_or_invalid_crawl_continuation: %', item
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO private.global_crawl_jobs (
      campaign_id,
      search_job_id,
      search_result_id,
      parent_job_id,
      city_id,
      url,
      canonical_url,
      domain,
      crawl_kind,
      crawl_depth,
      priority,
      available_at
    )
    VALUES (
      parent_job.campaign_id,
      parent_job.search_job_id,
      NULL,
      parent_job.id,
      parent_job.city_id,
      url_value,
      canonical_url_value,
      parent_job.domain,
      kind_value,
      parent_job.crawl_depth + 1,
      greatest(-1000, parent_job.priority - 1),
      now()
    )
    ON CONFLICT (campaign_id, city_id, canonical_url) DO UPDATE SET
      priority = greatest(private.global_crawl_jobs.priority, EXCLUDED.priority),
      status = CASE
        WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
          AND coalesce(
            private.global_crawl_jobs.finished_at,
            private.global_crawl_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN 'queued'
        ELSE private.global_crawl_jobs.status
      END,
      attempt_count = CASE
        WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
          AND coalesce(
            private.global_crawl_jobs.finished_at,
            private.global_crawl_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN 0
        ELSE private.global_crawl_jobs.attempt_count
      END,
      available_at = CASE
        WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
          AND coalesce(
            private.global_crawl_jobs.finished_at,
            private.global_crawl_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN now()
        ELSE private.global_crawl_jobs.available_at
      END,
      lease_owner = CASE
        WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
          AND coalesce(
            private.global_crawl_jobs.finished_at,
            private.global_crawl_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN NULL
        ELSE private.global_crawl_jobs.lease_owner
      END,
      lease_expires_at = CASE
        WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
          AND coalesce(
            private.global_crawl_jobs.finished_at,
            private.global_crawl_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN NULL
        ELSE private.global_crawl_jobs.lease_expires_at
      END,
      finished_at = CASE
        WHEN private.global_crawl_jobs.status IN ('completed', 'failed', 'skipped')
          AND coalesce(
            private.global_crawl_jobs.finished_at,
            private.global_crawl_jobs.updated_at
          ) <= now() - interval '24 hours'
          THEN NULL
        ELSE private.global_crawl_jobs.finished_at
      END,
      updated_at = now();

    accepted_count := accepted_count + 1;
  END LOOP;

  RETURN accepted_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_global_crawl_jobs(
  _worker_id UUID,
  _limit INTEGER DEFAULT 3,
  _lease_seconds INTEGER DEFAULT 120
)
RETURNS TABLE (
  job_id UUID,
  campaign_id UUID,
  search_job_id UUID,
  city_id UUID,
  url TEXT,
  canonical_url TEXT,
  domain TEXT,
  attempt_count INTEGER,
  max_attempts INTEGER,
  search_rank INTEGER,
  crawl_kind TEXT,
  crawl_depth INTEGER,
  parent_job_id UUID,
  robots_status TEXT,
  robots_rules JSONB,
  robots_expires_at TIMESTAMPTZ,
  crawl_delay_ms INTEGER,
  city_name TEXT,
  country_code TEXT,
  timezone TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  data_source_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  domain_record RECORD;
  exhausted_campaign RECORD;
  crawl_job private.global_crawl_jobs%ROWTYPE;
  claim_limit INTEGER := greatest(1, least(coalesce(_limit, 3), 25));
  claimed_count INTEGER := 0;
  lease_duration INTEGER := greatest(30, least(coalesce(_lease_seconds, 120), 900));
BEGIN
  IF _worker_id IS NULL THEN
    RAISE EXCEPTION 'worker_id_required' USING ERRCODE = '22023';
  END IF;

  -- Completed pages are never reopened merely because a worker asks for more
  -- work. A fresh SearXNG snapshot requeues only URLs it actually sees again;
  -- this prevents daily recrawls from starving untouched cities and avoids
  -- retrying terminal detail jobs forever.

  -- Expired domain leases are recoverable. Jobs whose last permitted attempt
  -- expired are made terminal so they cannot keep a campaign running forever.
  UPDATE private.global_domain_crawl_state AS state
  SET
    active_crawl_job_id = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now()
  WHERE state.active_crawl_job_id IS NOT NULL
    AND state.lease_expires_at <= now();

  FOR exhausted_campaign IN
    UPDATE private.global_crawl_jobs AS job
    SET
      status = 'failed',
      lease_owner = NULL,
      lease_expires_at = NULL,
      error_code = coalesce(job.error_code, 'lease_expired'),
      error_message = coalesce(job.error_message, 'Worker lease expired after the final attempt.'),
      finished_at = now(),
      updated_at = now()
    WHERE job.status = 'leased'
      AND job.lease_expires_at <= now()
      AND job.attempt_count >= job.max_attempts
    RETURNING job.campaign_id
  LOOP
    PERFORM private.refresh_global_scrape_campaign_v1(
      exhausted_campaign.campaign_id
    );
  END LOOP;

  UPDATE private.global_domain_crawl_state AS state
  SET
    robots_status = 'unknown',
    robots_rules = '{}'::JSONB,
    robots_fetched_at = NULL,
    robots_expires_at = NULL,
    updated_at = now()
  WHERE state.robots_expires_at IS NOT NULL
    AND state.robots_expires_at <= now();

  FOR domain_record IN
    SELECT state.domain
    FROM private.global_domain_crawl_state AS state
    WHERE state.next_allowed_at <= now()
      AND state.active_crawl_job_id IS NULL
      AND state.robots_status <> 'disallowed'
      AND EXISTS (
        SELECT 1
        FROM private.global_crawl_jobs AS candidate
        JOIN private.global_scrape_campaigns AS campaign
          ON campaign.id = candidate.campaign_id
        WHERE candidate.domain = state.domain
          AND campaign.status IN ('queued', 'running')
          AND candidate.available_at <= now()
          AND candidate.attempt_count < candidate.max_attempts
          AND (
            candidate.status = 'queued'
            OR (
              candidate.status = 'leased'
              AND candidate.lease_expires_at <= now()
            )
          )
      )
    ORDER BY
      (
        SELECT max(candidate.priority)
        FROM private.global_crawl_jobs AS candidate
        WHERE candidate.domain = state.domain
          AND candidate.status IN ('queued', 'leased')
      ) DESC NULLS LAST,
      state.next_allowed_at,
      state.domain
    LIMIT claim_limit
    FOR UPDATE OF state SKIP LOCKED
  LOOP
    SELECT job.*
    INTO crawl_job
    FROM private.global_crawl_jobs AS job
    JOIN private.global_scrape_campaigns AS campaign
      ON campaign.id = job.campaign_id
    WHERE job.domain = domain_record.domain
      AND campaign.status IN ('queued', 'running')
      AND job.available_at <= now()
      AND job.attempt_count < job.max_attempts
      AND (
        job.status = 'queued'
        OR (job.status = 'leased' AND job.lease_expires_at <= now())
      )
    ORDER BY job.priority DESC, job.available_at, job.created_at, job.id
    LIMIT 1
    FOR UPDATE OF job SKIP LOCKED;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    UPDATE private.global_crawl_jobs AS job
    SET
      status = 'leased',
      attempt_count = job.attempt_count + 1,
      lease_owner = _worker_id,
      lease_expires_at = now() + make_interval(secs => lease_duration),
      started_at = coalesce(job.started_at, now()),
      error_code = NULL,
      error_message = NULL,
      updated_at = now()
    WHERE job.id = crawl_job.id
    RETURNING job.* INTO crawl_job;

    UPDATE private.global_domain_crawl_state AS state
    SET
      active_crawl_job_id = crawl_job.id,
      lease_owner = _worker_id,
      lease_expires_at = crawl_job.lease_expires_at,
      next_allowed_at = greatest(
        state.next_allowed_at,
        now() + make_interval(secs => state.crawl_delay_ms / 1000.0)
      ),
      updated_at = now()
    WHERE state.domain = crawl_job.domain;

    claimed_count := claimed_count + 1;

    RETURN QUERY
    SELECT
      crawl_job.id,
      crawl_job.campaign_id,
      crawl_job.search_job_id,
      crawl_job.city_id,
      crawl_job.url,
      crawl_job.canonical_url,
      crawl_job.domain,
      crawl_job.attempt_count::INTEGER,
      crawl_job.max_attempts::INTEGER,
      search_result.rank::INTEGER,
      crawl_job.crawl_kind,
      crawl_job.crawl_depth::INTEGER,
      crawl_job.parent_job_id,
      state.robots_status,
      state.robots_rules,
      state.robots_expires_at,
      state.crawl_delay_ms,
      city.name,
      country.code,
      city.timezone,
      city.latitude,
      city.longitude,
      source.id
    FROM private.global_domain_crawl_state AS state
    LEFT JOIN private.global_search_results AS search_result
      ON search_result.id = crawl_job.search_result_id
    JOIN public.cities AS city ON city.id = crawl_job.city_id
    JOIN public.countries AS country ON country.id = city.country_id
    LEFT JOIN LATERAL (
      SELECT data_source.id
      FROM public.data_sources AS data_source
      WHERE data_source.city_id = crawl_job.city_id
        AND lower(data_source.domain) = crawl_job.domain
        AND data_source.status = 'active'
        AND data_source.is_authorized
        AND data_source.is_verified
        AND coalesce(data_source.metadata->>'global_discovery', 'false') = 'true'
        AND coalesce(data_source.metadata->>'automated_discovery', 'false') = 'true'
        AND data_source.metadata->>'verification_scope' = 'crawl_eligibility_only'
      ORDER BY
        (coalesce(data_source.metadata->>'global_discovery', 'false') = 'true') DESC,
        data_source.created_at
      LIMIT 1
    ) AS source ON true
    WHERE state.domain = crawl_job.domain;

    EXIT WHEN claimed_count >= claim_limit;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_global_domain_robots(
  _domain TEXT,
  _worker_id UUID,
  _job_id UUID,
  _robots_status TEXT,
  _robots_rules JSONB DEFAULT '{}'::JSONB,
  _crawl_delay_ms INTEGER DEFAULT 1500,
  _expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_domain TEXT := private.global_discovery_hostname(_domain);
  normalized_status TEXT := lower(btrim(coalesce(_robots_status, '')));
BEGIN
  IF normalized_status NOT IN ('unknown', 'allowed', 'disallowed', 'unavailable', 'error')
    OR jsonb_typeof(_robots_rules) IS DISTINCT FROM 'object'
    OR pg_column_size(_robots_rules) > 262144
  THEN
    RAISE EXCEPTION 'invalid_robots_policy' USING ERRCODE = '22023';
  END IF;

  UPDATE private.global_domain_crawl_state AS state
  SET
    robots_status = normalized_status,
    robots_rules = _robots_rules,
    robots_fetched_at = now(),
    robots_expires_at = greatest(
      coalesce(_expires_at, now() + interval '24 hours'),
      now() + interval '5 minutes'
    ),
    crawl_delay_ms = greatest(250, least(coalesce(_crawl_delay_ms, 1500), 86400000)),
    updated_at = now()
  WHERE state.domain = normalized_domain
    AND state.active_crawl_job_id = _job_id
    AND state.lease_owner = _worker_id
    AND state.lease_expires_at > now();

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_global_discovery_source(
  _city_id UUID,
  _domain TEXT,
  _base_url TEXT,
  _source_name TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_domain TEXT := private.global_discovery_hostname(_domain);
  base_url_domain TEXT;
  source_id_value UUID;
  city_name_value TEXT;
  locale_value TEXT;
BEGIN
  base_url_domain := private.global_discovery_hostname(
    substring(btrim(coalesce(_base_url, '')) FROM '^https?://([^/?#:]+)')
  );

  IF normalized_domain IS NULL
    OR normalized_domain ~ '[/@:]'
    OR length(normalized_domain) > 253
    OR btrim(coalesce(_base_url, '')) !~* '^https?://[^[:space:]]+$'
    OR base_url_domain IS DISTINCT FROM normalized_domain
    OR NOT EXISTS (
      SELECT 1
      FROM private.global_domain_crawl_state AS state
      WHERE state.domain = normalized_domain
        AND state.robots_status = 'allowed'
        AND state.robots_expires_at > now()
    )
  THEN
    RAISE EXCEPTION 'domain_not_crawl_authorized' USING ERRCODE = '42501';
  END IF;

  SELECT city.name, target.search_languages[1]
  INTO city_name_value, locale_value
  FROM public.cities AS city
  LEFT JOIN private.global_city_targets AS target ON target.city_id = city.id
  WHERE city.id = _city_id;

  IF city_name_value IS NULL THEN
    RAISE EXCEPTION 'unknown_city' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'global-source|' || _city_id::TEXT || '|' || normalized_domain,
      0
    )
  );

  SELECT source.id
  INTO source_id_value
  FROM public.data_sources AS source
  WHERE source.city_id = _city_id
    AND lower(source.domain) = normalized_domain
    AND source.status = 'active'
    AND source.is_authorized
    AND source.is_verified
    AND coalesce(source.metadata->>'global_discovery', 'false') = 'true'
    AND coalesce(source.metadata->>'automated_discovery', 'false') = 'true'
    AND source.metadata->>'verification_scope' = 'crawl_eligibility_only'
  ORDER BY
    (coalesce(source.metadata->>'global_discovery', 'false') = 'true') DESC,
    source.created_at
  LIMIT 1;

  IF source_id_value IS NOT NULL THEN
    RETURN source_id_value;
  END IF;

  INSERT INTO public.source_domains (
    domain,
    is_authorized,
    authorized_at,
    notes
  )
  VALUES (
    normalized_domain,
    true,
    now(),
    'Public event facts; automated discovery is gated by a fresh robots.txt decision and per-domain throttling.'
  )
  ON CONFLICT (domain) DO UPDATE SET
    is_authorized = true,
    authorized_at = coalesce(public.source_domains.authorized_at, now()),
    notes = EXCLUDED.notes;

  INSERT INTO public.data_sources (
    name,
    source_type,
    base_url,
    domain,
    is_authorized,
    is_verified,
    sync_frequency,
    status,
    legal_basis,
    city_id,
    page_count,
    priority,
    metadata
  )
  VALUES (
    left(
      coalesce(
        nullif(btrim(_source_name), ''),
        city_name_value || ' — ' || normalized_domain
      ),
      240
    ),
    'import'::public.data_source_type,
    left(btrim(_base_url), 1000),
    normalized_domain,
    true,
    true,
    'weekly',
    'active',
    'Public event facts; robots.txt checked before each crawl window.',
    _city_id,
    1,
    100,
    jsonb_strip_nulls(jsonb_build_object(
      'global_discovery', true,
      'automated_discovery', true,
      'robots_gated', true,
      'verification_scope', 'crawl_eligibility_only',
      'locale', locale_value,
      'max_distance_km', 250
    ))
  )
  RETURNING id INTO source_id_value;

  RETURN source_id_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_global_crawl_job(
  _job_id UUID,
  _worker_id UUID,
  _http_status INTEGER,
  _content_hash TEXT,
  _event_count INTEGER DEFAULT 0,
  _response_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  crawl_job private.global_crawl_jobs%ROWTYPE;
  domain_delay_ms INTEGER;
  event_error_count_value INTEGER := 0;
  partial_terminal BOOLEAN := false;
BEGIN
  IF jsonb_typeof(_response_metadata) IS DISTINCT FROM 'object'
    OR pg_column_size(_response_metadata) > 262144
    OR coalesce(_event_count, 0) < 0
  THEN
    RAISE EXCEPTION 'invalid_crawl_result' USING ERRCODE = '22023';
  END IF;

  SELECT job.*
  INTO crawl_job
  FROM private.global_crawl_jobs AS job
  WHERE job.id = _job_id
    AND job.status = 'leased'
    AND job.lease_owner = _worker_id
    AND job.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT state.crawl_delay_ms
  INTO domain_delay_ms
  FROM private.global_domain_crawl_state AS state
  WHERE state.domain = crawl_job.domain
    AND state.active_crawl_job_id = crawl_job.id
    AND state.lease_owner = _worker_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF coalesce(_response_metadata->>'event_error_count', '') ~ '^[0-9]{1,9}$' THEN
    event_error_count_value := least(
      100000000,
      (_response_metadata->>'event_error_count')::INTEGER
    );
  END IF;
  partial_terminal := event_error_count_value > 0
    AND crawl_job.attempt_count >= crawl_job.max_attempts;

  INSERT INTO private.global_crawl_attempts (
    crawl_job_id,
    attempt_number,
    outcome,
    http_status,
    event_count,
    event_error_count,
    error_code,
    error_message,
    response_metadata
  )
  VALUES (
    crawl_job.id,
    crawl_job.attempt_count,
    CASE
      WHEN partial_terminal THEN 'partial_failed'
      WHEN event_error_count_value > 0 THEN 'partial_retry'
      ELSE 'completed'
    END,
    CASE
      WHEN _http_status BETWEEN 100 AND 599 THEN _http_status::SMALLINT
      ELSE NULL
    END,
    coalesce(_event_count, 0),
    event_error_count_value,
    CASE WHEN event_error_count_value > 0 THEN 'partial_event_persistence' ELSE NULL END,
    CASE
      WHEN event_error_count_value > 0
        THEN left(event_error_count_value::TEXT || ' event(s) failed to persist', 2000)
      ELSE NULL
    END,
    _response_metadata
  );

  UPDATE private.global_crawl_jobs
  SET
    status = CASE
      WHEN partial_terminal THEN 'failed'
      WHEN event_error_count_value > 0 THEN 'queued'
      ELSE 'completed'
    END,
    available_at = CASE
      WHEN event_error_count_value > 0 AND NOT partial_terminal
        THEN now() + interval '5 minutes'
      ELSE available_at
    END,
    lease_owner = NULL,
    lease_expires_at = NULL,
    http_status = CASE
      WHEN _http_status BETWEEN 100 AND 599 THEN _http_status::SMALLINT
      ELSE NULL
    END,
    content_hash = nullif(left(btrim(_content_hash), 512), ''),
    event_count = coalesce(_event_count, 0),
    response_metadata = _response_metadata,
    error_code = CASE
      WHEN event_error_count_value > 0 THEN 'partial_event_persistence'
      ELSE NULL
    END,
    error_message = CASE
      WHEN event_error_count_value > 0
        THEN left(event_error_count_value::TEXT || ' event(s) failed to persist', 2000)
      ELSE NULL
    END,
    finished_at = CASE
      WHEN event_error_count_value = 0 OR partial_terminal THEN now()
      ELSE NULL
    END,
    updated_at = now()
  WHERE id = crawl_job.id;

  UPDATE private.global_domain_crawl_state
  SET
    active_crawl_job_id = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    next_allowed_at = now() + make_interval(
      secs => CASE
        WHEN event_error_count_value > 0 AND NOT partial_terminal
          THEN greatest(300, domain_delay_ms / 1000.0)
        ELSE domain_delay_ms / 1000.0
      END
    ),
    last_http_status = CASE
      WHEN _http_status BETWEEN 100 AND 599 THEN _http_status::SMALLINT
      ELSE NULL
    END,
    consecutive_failures = CASE
      WHEN event_error_count_value > 0 THEN consecutive_failures + 1
      ELSE 0
    END,
    last_error_code = CASE
      WHEN event_error_count_value > 0 THEN 'partial_event_persistence'
      ELSE NULL
    END,
    last_error_at = CASE
      WHEN event_error_count_value > 0 THEN now()
      ELSE last_error_at
    END,
    updated_at = now()
  WHERE domain = crawl_job.domain;

  PERFORM private.refresh_global_scrape_campaign_v1(crawl_job.campaign_id);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_global_crawl_job(
  _job_id UUID,
  _worker_id UUID,
  _error_code TEXT,
  _error_message TEXT,
  _http_status INTEGER DEFAULT NULL,
  _retry_after_seconds INTEGER DEFAULT 900,
  _terminal BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  crawl_job private.global_crawl_jobs%ROWTYPE;
  normalized_error_code TEXT := coalesce(
    lower(nullif(left(btrim(_error_code), 100), '')),
    'crawl_failed'
  );
  deferred_failure BOOLEAN;
  terminal_failure BOOLEAN;
  retry_seconds INTEGER;
BEGIN
  SELECT job.*
  INTO crawl_job
  FROM private.global_crawl_jobs AS job
  WHERE job.id = _job_id
    AND job.status = 'leased'
    AND job.lease_owner = _worker_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM private.global_domain_crawl_state AS state
    WHERE state.domain = crawl_job.domain
      AND state.active_crawl_job_id = crawl_job.id
      AND state.lease_owner = _worker_id
    FOR UPDATE
  ) THEN
    RETURN false;
  END IF;

  deferred_failure := coalesce(normalized_error_code IN (
    'crawl_delay_deferred',
    'domain_rate_limited',
    'robots_refresh_deferred'
  ), false);
  terminal_failure := NOT deferred_failure AND (
    coalesce(_terminal, false)
    OR crawl_job.attempt_count >= crawl_job.max_attempts
  );
  retry_seconds := greatest(1, least(coalesce(_retry_after_seconds, 900), 604800));

  INSERT INTO private.global_crawl_attempts (
    crawl_job_id,
    attempt_number,
    outcome,
    http_status,
    event_count,
    event_error_count,
    error_code,
    error_message,
    response_metadata
  )
  VALUES (
    crawl_job.id,
    crawl_job.attempt_count,
    CASE
      WHEN terminal_failure AND normalized_error_code = 'robots_disallowed' THEN 'skipped'
      WHEN terminal_failure THEN 'failed'
      ELSE 'retry'
    END,
    CASE
      WHEN _http_status BETWEEN 100 AND 599 THEN _http_status::SMALLINT
      ELSE NULL
    END,
    crawl_job.event_count,
    0,
    normalized_error_code,
    nullif(left(btrim(_error_message), 2000), ''),
    crawl_job.response_metadata
  );

  UPDATE private.global_crawl_jobs
  SET
    status = CASE
      WHEN terminal_failure AND normalized_error_code = 'robots_disallowed' THEN 'skipped'
      WHEN terminal_failure THEN 'failed'
      ELSE 'queued'
    END,
    attempt_count = CASE
      WHEN deferred_failure THEN greatest(0, attempt_count - 1)
      ELSE attempt_count
    END,
    available_at = CASE
      WHEN terminal_failure THEN available_at
      ELSE now() + make_interval(secs => retry_seconds)
    END,
    lease_owner = NULL,
    lease_expires_at = NULL,
    http_status = CASE
      WHEN _http_status BETWEEN 100 AND 599 THEN _http_status::SMALLINT
      ELSE NULL
    END,
    error_code = normalized_error_code,
    error_message = nullif(left(btrim(_error_message), 2000), ''),
    finished_at = CASE WHEN terminal_failure THEN now() ELSE NULL END,
    updated_at = now()
  WHERE id = crawl_job.id;

  UPDATE private.global_domain_crawl_state
  SET
    active_crawl_job_id = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    next_allowed_at = now() + make_interval(secs => retry_seconds),
    last_http_status = CASE
      WHEN _http_status BETWEEN 100 AND 599 THEN _http_status::SMALLINT
      ELSE NULL
    END,
    consecutive_failures = CASE
      WHEN deferred_failure THEN consecutive_failures
      ELSE consecutive_failures + 1
    END,
    last_error_code = normalized_error_code,
    last_error_at = now(),
    updated_at = now()
  WHERE domain = crawl_job.domain;

  PERFORM private.refresh_global_scrape_campaign_v1(crawl_job.campaign_id);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.register_global_event_source(
  _event_id UUID,
  _source_url TEXT,
  _canonical_url TEXT DEFAULT NULL,
  _domain TEXT DEFAULT NULL,
  _source_name TEXT DEFAULT NULL,
  _source_title TEXT DEFAULT NULL,
  _source_type TEXT DEFAULT 'discovery',
  _search_rank INTEGER DEFAULT NULL,
  _is_primary BOOLEAN DEFAULT false,
  _attribution TEXT DEFAULT NULL,
  _image_url TEXT DEFAULT NULL,
  _booking_url TEXT DEFAULT NULL,
  _identities JSONB DEFAULT '[]'::JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source_url_value TEXT := left(btrim(coalesce(_source_url, '')), 2000);
  canonical_url_value TEXT := left(
    btrim(coalesce(nullif(_canonical_url, ''), _source_url, '')),
    2000
  );
  domain_value TEXT;
  source_type_value TEXT := lower(btrim(coalesce(_source_type, 'discovery')));
  event_source_id_value UUID;
  identity_item JSONB;
  identity_type_value TEXT;
  identity_value_value TEXT;
  normalized_identity_value TEXT;
  identity_domain_value TEXT;
  identity_confidence_value NUMERIC;
  merged_sources_value JSONB;
BEGIN
  domain_value := private.global_discovery_domain(
    coalesce(
      nullif(_domain, ''),
      substring(canonical_url_value FROM '^https?://([^/?#:]+)')
    )
  );

  IF NOT EXISTS (SELECT 1 FROM public.events AS event WHERE event.id = _event_id)
    OR source_url_value !~* '^https?://[^[:space:]]+$'
    OR canonical_url_value !~* '^https?://[^[:space:]]+$'
    OR domain_value IS NULL
    OR domain_value ~ '[/@:]'
    OR length(domain_value) > 253
    OR source_type_value !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    OR (_search_rank IS NOT NULL AND _search_rank NOT BETWEEN 1 AND 10)
    OR (_image_url IS NOT NULL AND _image_url !~* '^https?://[^[:space:]]+$')
    OR (_booking_url IS NOT NULL AND _booking_url !~* '^https?://[^[:space:]]+$')
    OR jsonb_typeof(_identities) IS DISTINCT FROM 'array'
    OR jsonb_array_length(_identities) > 50
    OR pg_column_size(_identities) > 262144
  THEN
    RAISE EXCEPTION 'invalid_event_source' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended('global-event-sources|' || _event_id::TEXT, 0)
  );

  IF coalesce(_is_primary, false) THEN
    UPDATE public.event_sources
    SET is_primary = false
    WHERE event_id = _event_id
      AND canonical_url <> canonical_url_value
      AND is_primary;
  END IF;

  INSERT INTO public.event_sources (
    event_id,
    source_url,
    canonical_url,
    domain,
    source_name,
    source_title,
    source_type,
    search_rank,
    is_primary,
    attribution,
    image_url,
    booking_url,
    last_seen_at,
    last_verified_at
  )
  VALUES (
    _event_id,
    source_url_value,
    canonical_url_value,
    domain_value,
    nullif(left(btrim(_source_name), 256), ''),
    nullif(left(btrim(_source_title), 1000), ''),
    source_type_value,
    _search_rank::SMALLINT,
    coalesce(_is_primary, false),
    nullif(left(btrim(_attribution), 2000), ''),
    nullif(left(btrim(_image_url), 2000), ''),
    nullif(left(btrim(_booking_url), 2000), ''),
    now(),
    now()
  )
  ON CONFLICT (event_id, canonical_url) DO UPDATE SET
    source_url = EXCLUDED.source_url,
    domain = EXCLUDED.domain,
    source_name = coalesce(EXCLUDED.source_name, public.event_sources.source_name),
    source_title = coalesce(EXCLUDED.source_title, public.event_sources.source_title),
    source_type = EXCLUDED.source_type,
    search_rank = CASE
      WHEN public.event_sources.search_rank IS NULL THEN EXCLUDED.search_rank
      WHEN EXCLUDED.search_rank IS NULL THEN public.event_sources.search_rank
      ELSE least(public.event_sources.search_rank, EXCLUDED.search_rank)
    END,
    is_primary = public.event_sources.is_primary OR EXCLUDED.is_primary,
    attribution = coalesce(EXCLUDED.attribution, public.event_sources.attribution),
    image_url = coalesce(EXCLUDED.image_url, public.event_sources.image_url),
    booking_url = coalesce(EXCLUDED.booking_url, public.event_sources.booking_url),
    last_seen_at = now(),
    last_verified_at = now()
  RETURNING id INTO event_source_id_value;

  -- Registration can be retried independently from ingestion. Re-assert the
  -- durable provenance rule every time: automation-created events stay
  -- unverified, while any genuine verified editorial source wins.
  IF private.event_is_automated_only_v1(_event_id) THEN
    UPDATE public.events
    SET
      is_verified = false,
      verification_level = 'unverified'::public.verification_level
    WHERE id = _event_id;

    UPDATE public.organizers AS organizer
    SET
      is_verified = false,
      verification_level = 'unverified'::public.verification_level
    WHERE organizer.id = (
      SELECT event.organizer_id
      FROM public.events AS event
      WHERE event.id = _event_id
    )
      AND NOT EXISTS (
        SELECT 1
        FROM public.events AS other_event
        WHERE other_event.organizer_id = organizer.id
          AND other_event.id <> _event_id
          AND other_event.is_verified
      );

    UPDATE public.venues AS venue
    SET is_verified = false
    WHERE venue.id = (
      SELECT event.venue_id
      FROM public.events AS event
      WHERE event.id = _event_id
    )
      AND NOT EXISTS (
        SELECT 1
        FROM public.events AS other_event
        WHERE other_event.venue_id = venue.id
          AND other_event.id <> _event_id
          AND other_event.is_verified
      );
  END IF;

  -- URL is corroborating source data, not an event identity: one dynamic
  -- agenda URL may describe many events and many city contexts. The public
  -- event_sources relation preserves it without collapsing those events.

  FOR identity_item IN SELECT value FROM jsonb_array_elements(_identities)
  LOOP
    identity_type_value := lower(btrim(coalesce(identity_item->>'type', '')));
    identity_value_value := left(btrim(coalesce(identity_item->>'value', '')), 2000);
    normalized_identity_value := left(
      btrim(coalesce(
        nullif(identity_item->>'normalized_value', ''),
        lower(identity_value_value)
      )),
      2000
    );
    IF identity_type_value = 'event_fingerprint' THEN
      -- The collector's short fingerprint is useful for diagnostics but is
      -- not the authoritative DB SHA-256 global identity.
      identity_type_value := 'collector_fingerprint';
    END IF;

    identity_domain_value := CASE
      WHEN identity_type_value = 'global_fingerprint' THEN ''
      WHEN identity_type_value = 'external_id' THEN domain_value
      ELSE coalesce(
        private.global_discovery_domain(identity_item->>'source_domain'),
        domain_value,
        ''
      )
    END;

    BEGIN
      identity_confidence_value := coalesce(
        nullif(identity_item->>'confidence', '')::NUMERIC,
        1
      );
    EXCEPTION WHEN invalid_text_representation THEN
      identity_confidence_value := 1;
    END;

    IF identity_type_value !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
      OR identity_value_value = ''
      OR normalized_identity_value = ''
      OR identity_domain_value ~ '[/@:]'
    THEN
      CONTINUE;
    END IF;

    INSERT INTO private.global_event_identities (
      event_id,
      identity_type,
      identity_value,
      normalized_value,
      source_domain,
      confidence,
      metadata,
      last_seen_at
    )
    VALUES (
      _event_id,
      identity_type_value,
      identity_value_value,
      normalized_identity_value,
      identity_domain_value,
      greatest(0, least(1, identity_confidence_value)),
      CASE
        WHEN jsonb_typeof(identity_item->'metadata') = 'object'
          AND pg_column_size(identity_item->'metadata') <= 65536
          THEN identity_item->'metadata'
        ELSE '{}'::JSONB
      END,
      now()
    )
    ON CONFLICT (identity_type, source_domain, normalized_value) DO UPDATE SET
      confidence = greatest(private.global_event_identities.confidence, EXCLUDED.confidence),
      metadata = private.global_event_identities.metadata || EXCLUDED.metadata,
      last_seen_at = now();
  END LOOP;

  SELECT coalesce(
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'name', left(source.source_name, 160),
        'title', left(source.source_title, 400),
        'url', source.source_url,
        'domain', source.domain,
        'type', source.source_type,
        'rank', source.search_rank,
        'primary', source.is_primary,
        'attribution', left(source.attribution, 500),
        'booking_url', source.booking_url,
        'last_verified_at', source.last_verified_at
      ))
      ORDER BY
        source.is_primary DESC,
        source.search_rank ASC NULLS LAST,
        source.first_seen_at,
        source.id
    ),
    '[]'::JSONB
  )
  INTO merged_sources_value
  FROM (
    SELECT event_source.*
    FROM public.event_sources AS event_source
    WHERE event_source.event_id = _event_id
    ORDER BY
      event_source.is_primary DESC,
      event_source.search_rank ASC NULLS LAST,
      event_source.first_seen_at,
      event_source.id
  ) AS source;

  INSERT INTO public.event_scraped_details (event_id, details, updated_at)
  VALUES (
    _event_id,
    jsonb_build_object('merged_sources', merged_sources_value),
    now()
  )
  ON CONFLICT (event_id) DO UPDATE SET
    details = public.event_scraped_details.details
      || jsonb_build_object('merged_sources', merged_sources_value),
    updated_at = now()
  WHERE pg_column_size(
    public.event_scraped_details.details
      || jsonb_build_object('merged_sources', merged_sources_value)
  ) <= 524288;

  UPDATE public.source_records AS record
  SET
    event_id = _event_id,
    canonical_url = canonical_url_value
  WHERE record.id = (
    SELECT candidate.id
    FROM public.source_records AS candidate
    WHERE candidate.source_url IN (source_url_value, canonical_url_value)
      AND candidate.extracted_data->>'event_id' = _event_id::TEXT
    ORDER BY candidate.processed_at DESC NULLS LAST, candidate.fetched_at DESC
    LIMIT 1
  );

  RETURN event_source_id_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.global_scrape_campaign_status(
  _campaign_id UUID
)
RETURNS TABLE (
  campaign_id UUID,
  campaign_key TEXT,
  status TEXT,
  period_start DATE,
  period_end DATE,
  provider TEXT,
  total_search_jobs BIGINT,
  queued_search_jobs BIGINT,
  leased_search_jobs BIGINT,
  completed_search_jobs BIGINT,
  failed_search_jobs BIGINT,
  total_crawl_jobs BIGINT,
  queued_crawl_jobs BIGINT,
  leased_crawl_jobs BIGINT,
  completed_crawl_jobs BIGINT,
  failed_crawl_jobs BIGINT,
  created_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    campaign.id,
    campaign.campaign_key,
    campaign.status,
    campaign.period_start,
    campaign.period_end,
    campaign.provider,
    coalesce(search_stats.total, 0),
    coalesce(search_stats.queued, 0),
    coalesce(search_stats.leased, 0),
    coalesce(search_stats.completed, 0),
    coalesce(search_stats.failed, 0),
    coalesce(crawl_stats.total, 0),
    coalesce(crawl_stats.queued, 0),
    coalesce(crawl_stats.leased, 0),
    coalesce(crawl_stats.completed, 0),
    coalesce(crawl_stats.failed, 0),
    campaign.created_at,
    campaign.started_at,
    campaign.finished_at
  FROM private.global_scrape_campaigns AS campaign
  LEFT JOIN LATERAL (
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE job.status = 'queued') AS queued,
      count(*) FILTER (WHERE job.status = 'leased') AS leased,
      count(*) FILTER (WHERE job.status = 'completed') AS completed,
      count(*) FILTER (WHERE job.status = 'failed') AS failed
    FROM private.global_search_jobs AS job
    WHERE job.campaign_id = campaign.id
  ) AS search_stats ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE job.status = 'queued') AS queued,
      count(*) FILTER (WHERE job.status = 'leased') AS leased,
      count(*) FILTER (WHERE job.status = 'completed') AS completed,
      count(*) FILTER (WHERE job.status IN ('failed', 'skipped')) AS failed
    FROM private.global_crawl_jobs AS job
    WHERE job.campaign_id = campaign.id
  ) AS crawl_stats ON true
  WHERE campaign.id = _campaign_id;
$$;

CREATE OR REPLACE FUNCTION public.global_discovery_backlog()
RETURNS TABLE (
  search_backlog BIGINT,
  crawl_backlog BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (
      SELECT count(*)
      FROM private.global_search_jobs AS job
      WHERE job.status IN ('queued', 'leased')
    ),
    (
      SELECT count(*)
      FROM private.global_crawl_jobs AS job
      WHERE job.status IN ('queued', 'leased')
    );
$$;

-- ---------------------------------------------------------------------------
-- RPC privileges. SECURITY DEFINER functions are never executable through
-- PUBLIC inheritance; only a server-side service-role client can call them.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION private.unicode_event_fingerprint_v1(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.global_ticket_currency_value_v1(TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_global_ticket_currency_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.protect_unicode_event_fingerprint_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.populate_source_record_links_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.demote_automated_discovery_verification_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.event_is_automated_only_v1(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.global_discovery_domain(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.global_discovery_hostname(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.global_event_fingerprint_v1(JSONB, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.global_event_canonical_occurrence_v1(JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.merge_fresh_global_event_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.refresh_global_scrape_campaign_v1(UUID)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.upsert_ingested_event_v2(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_global_city_targets(JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_global_city_targets(TEXT[], BIGINT[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_global_scrape_campaign(TEXT, DATE, DATE, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_due_global_city_targets(INTEGER, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_global_search_jobs(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_global_search_jobs(UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_global_search_job(UUID, UUID, JSONB, INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_global_search_job(UUID, UUID, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_global_crawl_continuations(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_global_crawl_jobs(UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_global_domain_robots(TEXT, UUID, UUID, TEXT, JSONB, INTEGER, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_global_discovery_source(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_global_crawl_job(UUID, UUID, INTEGER, TEXT, INTEGER, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_global_crawl_job(UUID, UUID, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_global_event_source(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.global_scrape_campaign_status(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.global_discovery_backlog()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_ingested_event_v2(UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.import_global_city_targets(JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_global_city_targets(TEXT[], BIGINT[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_global_scrape_campaign(TEXT, DATE, DATE, TEXT, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.list_due_global_city_targets(INTEGER, TIMESTAMPTZ)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_global_search_jobs(UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_global_search_jobs(UUID, INTEGER, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_global_search_job(UUID, UUID, JSONB, INTEGER, BOOLEAN)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_global_search_job(UUID, UUID, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_global_crawl_continuations(UUID, UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_global_crawl_jobs(UUID, INTEGER, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.update_global_domain_robots(TEXT, UUID, UUID, TEXT, JSONB, INTEGER, TIMESTAMPTZ)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_global_discovery_source(UUID, TEXT, TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_global_crawl_job(UUID, UUID, INTEGER, TEXT, INTEGER, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_global_crawl_job(UUID, UUID, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.register_global_event_source(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, TEXT, TEXT, TEXT, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.global_scrape_campaign_status(UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.global_discovery_backlog()
  TO service_role;

COMMENT ON FUNCTION public.import_global_city_targets(JSONB) IS
  'Service-role batch upsert of GeoNames countries, cities and adaptive city targets.';
COMMENT ON FUNCTION public.claim_global_crawl_jobs(UUID, INTEGER, INTEGER) IS
  'Atomically leases at most one crawl per domain using row locks and SKIP LOCKED.';
COMMENT ON FUNCTION public.enqueue_global_crawl_continuations(UUID, UUID, JSONB) IS
  'SERVICE-ROLE RPC CONTRACT: public.enqueue_global_crawl_continuations(_parent_job_id uuid, _worker_id uuid, _continuations jsonb) returns integer. Requires the live parent lease; accepts at most 100 {url, canonical_url?, kind:event|pagination} objects on the exact parent domain; and durably enqueues depth-limited child crawl jobs without a search_result row.';
COMMENT ON FUNCTION public.ensure_global_discovery_source(UUID, TEXT, TEXT, TEXT) IS
  'Creates a robots-gated automated source. is_verified is ingestion compatibility only; metadata.verification_scope is crawl_eligibility_only and created events are atomically demoted to unverified.';
COMMENT ON FUNCTION public.register_global_event_source(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, TEXT, TEXT, TEXT, JSONB
) IS
  'Registers one corroborating public event URL, alternative identities and the visitor-facing merged_sources projection.';
