-- Cover every referencing side of the worldwide discovery foreign keys. These
-- indexes keep queue joins and parent-row deletes from degrading into table
-- scans once the global crawl and persistence tables grow.

CREATE INDEX IF NOT EXISTS global_search_jobs_city_id_idx
  ON private.global_search_jobs (city_id);

CREATE INDEX IF NOT EXISTS global_crawl_jobs_city_id_idx
  ON private.global_crawl_jobs (city_id);

CREATE INDEX IF NOT EXISTS global_crawl_jobs_search_job_id_idx
  ON private.global_crawl_jobs (search_job_id);

CREATE INDEX IF NOT EXISTS global_crawl_jobs_search_result_id_idx
  ON private.global_crawl_jobs (search_result_id)
  WHERE search_result_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS global_crawl_jobs_parent_job_id_idx
  ON private.global_crawl_jobs (parent_job_id)
  WHERE parent_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS global_domain_crawl_state_active_job_idx
  ON private.global_domain_crawl_state (active_crawl_job_id)
  WHERE active_crawl_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS global_event_persistence_jobs_data_source_idx
  ON private.global_event_persistence_jobs (data_source_id);

CREATE INDEX IF NOT EXISTS global_event_persistence_jobs_event_id_idx
  ON private.global_event_persistence_jobs (event_id)
  WHERE event_id IS NOT NULL;
