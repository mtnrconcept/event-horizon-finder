from pathlib import Path
import unittest


MIGRATION = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260720124500_legal_public_event_projection.sql"
)


class LegalPublicEventProjectionMigrationTests(unittest.TestCase):
    def test_projection_install_defers_historical_backfill(self) -> None:
        sql = MIGRATION.read_text(encoding="utf-8")
        post_triggers = sql.split(
            "EXECUTE FUNCTION private.refresh_event_publication_media_trigger_v2();",
            maxsplit=1,
        )[1]

        self.assertIn(
            "CREATE OR REPLACE FUNCTION public.backfill_event_publications_v2",
            post_triggers,
        )
        self.assertNotIn("ANALYZE public.event_publications_v2", post_triggers)
        self.assertNotIn("FROM candidates AS candidate", post_triggers)
        self.assertNotIn(
            "JOIN public.event_publications_v2 AS publication ON",
            post_triggers,
        )

    def test_projection_backfill_is_bounded_and_service_role_only(self) -> None:
        sql = MIGRATION.read_text(encoding="utf-8")
        backfill = sql.split(
            "CREATE OR REPLACE FUNCTION public.backfill_event_publications_v2",
            maxsplit=1,
        )[1]

        self.assertIn("least(coalesce(_limit, 100), 500)", backfill)
        self.assertIn("LIMIT batch_limit", backfill)
        self.assertIn("FOR UPDATE OF detail SKIP LOCKED", backfill)
        self.assertIn(
            "REVOKE ALL ON FUNCTION public.backfill_event_publications_v2(INTEGER)",
            backfill,
        )
        self.assertIn(
            "GRANT EXECUTE ON FUNCTION public.backfill_event_publications_v2(INTEGER)",
            backfill,
        )
        self.assertIn("TO service_role", backfill)

    def test_media_license_classifier_rejects_noncommercial_and_generic_cc(self) -> None:
        sql = MIGRATION.read_text(encoding="utf-8")
        classifier = sql.split(
            "CREATE OR REPLACE FUNCTION private.public_event_media_is_approved_v2",
            maxsplit=1,
        )[1].split(
            "CREATE OR REPLACE FUNCTION private.refresh_event_publication_v2",
            maxsplit=1,
        )[0]

        self.assertIn("non[[:space:]_-]*commercial", classifier)
        self.assertIn("by[[:space:]_-]*nc", classifier)
        self.assertIn("THEN FALSE", classifier)
        self.assertNotIn("|creative commons|", classifier)

    def test_media_license_classifier_keeps_reusable_allowlist(self) -> None:
        sql = MIGRATION.read_text(encoding="utf-8")
        classifier = sql.split(
            "CREATE OR REPLACE FUNCTION private.public_event_media_is_approved_v2",
            maxsplit=1,
        )[1].split(
            "CREATE OR REPLACE FUNCTION private.refresh_event_publication_v2",
            maxsplit=1,
        )[0]

        self.assertIn("cc[[:space:]_-]*0", classifier)
        self.assertIn("public[[:space:]_-]+domain", classifier)
        self.assertIn("cc[[:space:]_-]*by", classifier)
        self.assertIn("creativecommons[.]org/licenses/by(-sa)?/", classifier)
        self.assertIn("licen[cs]e[[:space:]_-]+ouverte", classifier)
        self.assertIn("open[[:space:]_-]+licen[cs]e", classifier)
        self.assertIn("THEN has_attribution", classifier)


if __name__ == "__main__":
    unittest.main()
