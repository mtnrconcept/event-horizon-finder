-- Backfill continuous scraper records separately from the schema migration so
-- source_records DDL locks are not held during the catalogue scan.

WITH ranked_records AS MATERIALIZED (
  SELECT
    (record.extracted_data->>'event_id')::UUID AS event_id,
    record.extracted_data->'normalized_payload' AS payload,
    record.source_url,
    source.name AS source_name,
    coalesce(
      record.processed_at,
      record.fetched_at,
      '1970-01-01 00:00:00+00'::TIMESTAMPTZ
    ) AS source_updated_at,
    row_number() OVER (
      PARTITION BY record.extracted_data->>'event_id'
      ORDER BY
        coalesce(
          record.processed_at,
          record.fetched_at,
          '1970-01-01 00:00:00+00'::TIMESTAMPTZ
        ) DESC,
        record.processed_at DESC NULLS LAST,
        record.fetched_at DESC NULLS LAST,
        record.id DESC
    ) AS source_rank
  FROM public.source_records AS record
  LEFT JOIN public.data_sources AS source ON source.id = record.data_source_id
  WHERE record.extracted_data->>'event_id' ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND jsonb_typeof(record.extracted_data->'normalized_payload') = 'object'
), prepared AS MATERIALIZED (
  SELECT
    ranked.event_id,
    private.public_event_scraped_details_v1(
      ranked.payload,
      ranked.source_url,
      ranked.source_name
    ) AS details,
    ranked.source_updated_at,
    ranked.source_rank
  FROM ranked_records AS ranked
  JOIN public.events AS event ON event.id = ranked.event_id
), flattened AS MATERIALIZED (
  SELECT
    prepared.event_id,
    item.key,
    item.value,
    prepared.source_updated_at,
    prepared.source_rank
  FROM prepared
  CROSS JOIN LATERAL jsonb_each(prepared.details) AS item(key, value)
  WHERE prepared.details <> '{}'::JSONB
    AND pg_column_size(prepared.details) <= 524288
), merged AS MATERIALIZED (
  SELECT
    flattened.event_id,
    jsonb_object_agg(
      flattened.key,
      flattened.value
      ORDER BY flattened.source_rank DESC
    ) AS details,
    (array_agg(
      flattened.source_updated_at
      ORDER BY flattened.source_rank
    ))[1] AS source_updated_at
  FROM flattened
  GROUP BY flattened.event_id
)
INSERT INTO public.event_scraped_details(event_id, details, updated_at)
SELECT event_id, details, source_updated_at
FROM merged
WHERE source_updated_at IS NOT NULL
  AND pg_column_size(details) <= 524288
ON CONFLICT (event_id) DO UPDATE SET
  details = CASE
    WHEN EXCLUDED.updated_at >= public.event_scraped_details.updated_at
      THEN public.event_scraped_details.details || EXCLUDED.details
    ELSE EXCLUDED.details || public.event_scraped_details.details
  END,
  updated_at = greatest(public.event_scraped_details.updated_at, EXCLUDED.updated_at);
