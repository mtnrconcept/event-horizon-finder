-- Licensed bulk feeds are registry-only roots. The collector does not crawl
-- their landing pages; rows imported from their datasets are normalized by
-- upsert_ingested_event_v2 into city-scoped derived sources.
INSERT INTO public.data_sources(
  name, source_type, base_url, domain, is_authorized, is_verified,
  sync_frequency, status, legal_basis, category_slug, page_count, priority, metadata
)
SELECT source.name, 'import'::public.data_source_type, source.base_url, source.domain,
  true, true, 'daily', 'active', source.license, 'concerts', 1, 20,
  jsonb_build_object(
    'import_only', true,
    'dataset_url', source.dataset_url,
    'license', source.license
  )
FROM (VALUES
  (
    'DATAtourisme — import mondial',
    'https://www.datatourisme.fr/',
    'datatourisme.fr',
    'https://www.data.gouv.fr/datasets/datatourisme-la-base-nationale-des-donnees-publiques-dinformation-touristique-en-open-data/',
    'Licence Ouverte 2.0'
  ),
  (
    'OpenAgenda public — import mondial',
    'https://openagenda.com/',
    'openagenda.com',
    'https://openagenda.com/',
    'Licence Ouverte v1.0'
  ),
  (
    'Hong Kong LCSD Cultural Events — import mondial',
    'https://www.lcsd.gov.hk/',
    'lcsd.gov.hk',
    'https://data.gov.hk/',
    'DATA.GOV.HK Terms and Conditions'
  )
) AS source(name, base_url, domain, dataset_url, license)
WHERE NOT EXISTS (
  SELECT 1 FROM public.data_sources existing WHERE existing.name = source.name
);

