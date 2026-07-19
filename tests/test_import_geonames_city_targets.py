import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "import_geonames_city_targets.py"
SPEC = importlib.util.spec_from_file_location("geonames_importer", SCRIPT)
assert SPEC and SPEC.loader
IMPORTER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = IMPORTER
SPEC.loader.exec_module(IMPORTER)


class GeoNamesImporterTests(unittest.TestCase):
    def test_adaptive_city_limit(self):
        cases = [
            (99_999, 1),
            (100_000, 3),
            (1_000_000, 8),
            (5_000_000, 15),
            (20_000_000, 25),
            (50_000_000, 40),
            (100_000_000, 50),
        ]
        for population, expected in cases:
            with self.subTest(population=population):
                self.assertEqual(IMPORTER.adaptive_city_limit(population), expected)
        self.assertEqual(IMPORTER.adaptive_city_limit(200_000_000, available=7), 7)

    def test_parses_country_languages_without_paid_api(self):
        line = (
            "CH\tCHE\t756\tSZ\tSwitzerland\tBern\t41290\t8654622\tEU\t.ch\tCHF\t"
            "Franc\t41\t####\t\tde-CH,fr-CH,it-CH,rm\t2658434\tDE,IT,LI,FR,AT\t"
        )
        countries = IMPORTER.parse_country_info("# header\n" + line)
        self.assertEqual(countries["CH"].languages, ("de", "fr", "it", "rm"))
        self.assertEqual(countries["CH"].population, 8_654_622)
        self.assertEqual(countries["CH"].geonames_id, 2_658_434)
        self.assertEqual(countries["CH"].area_sq_km, 41_290)

    def test_selects_strict_largest_cities_and_retains_capital_metadata(self):
        country = IMPORTER.Country(
            "XY", "XYZ", "Example", 99, 1234.0, 400_000, "Capital", ("en",)
        )
        cities = [
            IMPORTER.City(1, "Largest", "Largest", 1, 1, "PPL", "XY", "1", 900_000, "UTC"),
            IMPORTER.City(2, "Second", "Second", 2, 2, "PPL", "XY", "2", 500_000, "UTC"),
            IMPORTER.City(3, "Capital", "Capital", 3, 3, "PPLC", "XY", "3", 10_000, "UTC"),
            IMPORTER.City(4, "Fourth", "Fourth", 4, 4, "PPL", "XY", "4", 8_000, "UTC"),
        ]
        rows = IMPORTER.select_city_targets({"XY": country}, cities)
        self.assertEqual([row[1].geonames_id for row in rows], [1, 2, 3])
        self.assertEqual([row[2] for row in rows], [1, 2, 3])
        self.assertTrue(IMPORTER.target_payload(*rows[2])["is_capital"])

    def test_parses_city_dump_line(self):
        line = (
            "2660646\tGeneva\tGeneva\tGenève,Geneva\t46.20222\t6.14569\tP\tPPLA\tCH\t\t"
            "GE\t\t\t\t203856\t\t375\tEurope/Zurich\t2026-01-01\n"
        )
        city = list(IMPORTER.parse_cities([line]))[0]
        self.assertEqual(city.name, "Geneva")
        self.assertEqual(city.country_code, "CH")
        self.assertEqual(city.population, 203_856)
        self.assertEqual(city.timezone, "Europe/Zurich")

    def test_reconciliation_sends_the_complete_selected_geonames_set(self):
        rows = [
            {"country_code": "CH", "city_geonames_id": 2},
            {"country_code": "CH", "city_geonames_id": 1},
            {"country_code": "FR", "city_geonames_id": 3},
        ]

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b"4"

        captured = {}

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["body"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return Response()

        with mock.patch.object(IMPORTER, "urlopen", side_effect=fake_urlopen):
            disabled = IMPORTER._rpc_reconcile(
                "https://project.supabase.co", "service-secret", rows, timeout=12
            )

        self.assertEqual(disabled, 4)
        self.assertTrue(captured["url"].endswith("/rpc/reconcile_global_city_targets"))
        self.assertEqual(captured["body"]["_country_codes"], ["CH", "FR"])
        self.assertEqual(captured["body"]["_selected_geonames_ids"], [1, 2, 3])
        self.assertEqual(captured["timeout"], 12)


if __name__ == "__main__":
    unittest.main()
