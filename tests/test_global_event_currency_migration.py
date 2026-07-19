from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (
    ROOT
    / "supabase"
    / "migrations"
    / "20260719001206_global_event_discovery_pipeline.sql"
)
INDEX_MIGRATION = (
    ROOT
    / "supabase"
    / "migrations"
    / "20260719025620_optimize_global_discovery_foreign_keys.sql"
)
RUNTIME_MIGRATION = (
    ROOT
    / "supabase"
    / "migrations"
    / "20260719030642_fix_geonames_postgis_runtime.sql"
)


class GlobalEventCurrencyMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sql = MIGRATION.read_text(encoding="utf-8")
        cls.index_sql = INDEX_MIGRATION.read_text(encoding="utf-8")
        cls.runtime_sql = RUNTIME_MIGRATION.read_text(encoding="utf-8")

    def test_ticket_offer_has_no_catalog_wide_eur_default(self) -> None:
        self.assertRegex(
            self.sql,
            r"ALTER TABLE public\.ticket_offers\s+"
            r"ALTER COLUMN currency DROP DEFAULT",
        )

    def test_unknown_currency_guard_is_transaction_scoped(self) -> None:
        self.assertIn("private.guard_global_ticket_currency_v1", self.sql)
        self.assertIn("partyfinder.global_currency_unknown", self.sql)
        self.assertIn("v_currency_unknown BOOLEAN := false", self.sql)
        self.assertGreaterEqual(
            self.sql.count("pg_catalog.set_config("),
            4,
            "both legacy-core calls must set and restore the transaction guard",
        )

    def test_unknown_is_null_but_explicit_eur_is_preserved(self) -> None:
        helper = re.search(
            r"CREATE OR REPLACE FUNCTION "
            r"private\.global_ticket_currency_value_v1\(.+?\n\$\$;",
            self.sql,
            flags=re.DOTALL,
        )
        self.assertIsNotNone(helper)
        helper_sql = helper.group(0)
        self.assertIn("WHEN _currency_unknown IS TRUE THEN NULL::TEXT", helper_sql)
        self.assertIn("ELSE _currency", helper_sql)
        self.assertIn("global_ticket_currency_invariant", self.sql)

    def test_final_wrapper_has_no_eur_fallback(self) -> None:
        self.assertNotRegex(
            self.sql,
            r"coalesce\s*\(\s*v_currency\s*,\s*'EUR'\s*\)",
        )

    def test_geonames_import_resolves_the_installed_postgis_schema(self) -> None:
        self.assertIn("city_location_value public.cities.location%TYPE", self.sql)
        self.assertIn("WHERE extension.extname = 'postgis'", self.sql)
        self.assertIn("postgis_schema_value", self.sql)
        self.assertNotIn("extensions.geography", self.sql)

    def test_every_discovery_foreign_key_reported_by_advisors_is_indexed(self) -> None:
        expected_indexes = {
            "global_search_jobs_city_id_idx",
            "global_crawl_jobs_city_id_idx",
            "global_crawl_jobs_search_job_id_idx",
            "global_crawl_jobs_search_result_id_idx",
            "global_crawl_jobs_parent_job_id_idx",
            "global_domain_crawl_state_active_job_idx",
            "global_event_persistence_jobs_data_source_idx",
            "global_event_persistence_jobs_event_id_idx",
        }
        for index_name in expected_indexes:
            with self.subTest(index_name=index_name):
                self.assertIn(f"CREATE INDEX IF NOT EXISTS {index_name}", self.index_sql)

    def test_geonames_runtime_does_not_assume_the_postgis_schema(self) -> None:
        self.assertIn("postgis_schema_value", self.runtime_sql)
        self.assertIn("city_location_value public.cities.location%TYPE", self.runtime_sql)
        self.assertNotRegex(self.runtime_sql, r"extensions\.st_(?:dwithin|distance)")


if __name__ == "__main__":
    unittest.main()
