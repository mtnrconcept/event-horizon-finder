import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "scripts" / "scrape_geneva_events.py"
SPEC = importlib.util.spec_from_file_location("geneva_scraper", SCRIPT)
assert SPEC and SPEC.loader
SCRAPER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SCRAPER
SPEC.loader.exec_module(SCRAPER)


class GenevaScraperTests(unittest.TestCase):
    def test_client_timeout_covers_server_side_retries(self):
        self.assertGreaterEqual(SCRAPER.DEFAULT_TIMEOUT, 2 * 72 + 5)

    def test_world_expansion_currency_fallbacks(self):
        self.assertEqual(SCRAPER._currency_for_country("MX"), "MXN")
        self.assertEqual(SCRAPER._currency_for_country("kr"), "KRW")
        self.assertEqual(SCRAPER._currency_for_country("SG"), "SGD")
        self.assertEqual(SCRAPER._currency_for_country("AE"), "AED")
        self.assertEqual(SCRAPER._currency_for_country("ZA"), "ZAR")
        self.assertEqual(SCRAPER._currency_for_country("MA"), "MAD")

    def test_extracts_nested_schema_org_event(self):
        html = """
        <html><head><script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@graph": [{
            "@type": "MusicEvent",
            "@id": "/events/night-one",
            "name": "Night One",
            "description": "Live and club night",
            "startDate": "2027-01-08T22:30:00+01:00",
            "endDate": "2027-01-09T05:00:00+01:00",
            "image": ["/media/night-one.jpg"],
            "location": {
              "@type": "Place",
              "name": "Le Club",
              "address": {
                "streetAddress": "1 rue du Test",
                "postalCode": "1201",
                "addressLocality": "Genève"
              },
              "geo": {"latitude": 46.2, "longitude": 6.15}
            },
            "offers": {"price": "0", "url": "/tickets/night-one"}
          }]
        }
        </script></head></html>
        """
        events = SCRAPER.extract_json_ld_events(html, "https://venue.example/agenda", "soirees")
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event.title, "Night One")
        self.assertEqual(event.venue_name, "Le Club")
        self.assertEqual(event.address, "1 rue du Test, 1201, Genève")
        self.assertEqual(event.ticket_url, "https://venue.example/tickets/night-one")
        self.assertTrue(event.is_free)

    def test_deduplicates_repeated_json_ld(self):
        block = """{
          "@type": "Event",
          "name": "Festival Test",
          "startDate": "2027-07-01T18:00:00+02:00",
          "url": "/festival-test"
        }"""
        html = f'<script type="application/ld+json">{block}</script>' * 2
        events = SCRAPER.extract_json_ld_events(html, "https://festival.example/programme", "festivals")
        self.assertEqual(len(events), 1)

    def test_uses_source_timezone_for_naive_dates_and_preserves_all_day_interval(self):
        html = """
        <script type="application/ld+json"><!--
        {
          "@type": "MusicEvent",
          "name": "Brooklyn Summer Session",
          "startDate": "2027-07-10",
          "endDate": "2027-07-11",
          "location": {"name": "Example Hall"},
          "url": "/events/summer-session"
        }
        --></script>
        """
        events = SCRAPER.extract_json_ld_events(
            html,
            "https://newyork.example/calendar",
            timezone_name="America/New_York",
            city_name="New York",
            city_latitude=40.7128,
            city_longitude=-74.006,
            country_code="US",
        )
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event.starts_at, "2027-07-10T00:00:00-04:00")
        self.assertEqual(event.ends_at, "2027-07-12T00:00:00-04:00")
        self.assertTrue(event.all_day)
        self.assertEqual(event.time_precision, "date")

    def test_extracts_price_range_and_discards_distant_coordinates(self):
        html = """
        <script type="application/ld+json">
        {
          "@type": "Event",
          "name": "Geneva Electronic Festival",
          "description": "Une annonce officielle suffisamment détaillée pour cette soirée électronique.",
          "startDate": "2027-08-01T20:00:00+02:00",
          "location": {
            "name": "Scène du Lac",
            "geo": {"latitude": 40.7128, "longitude": -74.006}
          },
          "organizer": {"name": "Association du Lac", "url": "/association"},
          "offers": [
            {"price": "45.00", "priceCurrency": "CHF", "url": "/tickets/standard"},
            {"price": "90.00", "priceCurrency": "CHF"}
          ],
          "url": "https://invented.invalid/events/electronic-festival"
        }
        </script>
        """
        event = SCRAPER.extract_json_ld_events(
            html, "https://festival.example/agenda", "festivals"
        )[0]
        self.assertEqual(event.price_min, 45)
        self.assertEqual(event.price_max, 90)
        self.assertEqual(event.currency, "CHF")
        self.assertEqual(event.ticket_url, "https://festival.example/tickets/standard")
        self.assertEqual(event.organizer_name, "Association du Lac")
        self.assertEqual(event.organizer_url, "https://festival.example/association")
        self.assertEqual(event.source_url, "https://festival.example/agenda")
        self.assertIsNone(event.latitude)
        self.assertIsNone(event.longitude)
        self.assertIn("coordinates_outside_source_area", event.warnings)
        self.assertIn("off_domain_source_url", event.warnings)

    def test_dedupe_keeps_distinct_sessions(self):
        common = {
            "title": "Summer House Party",
            "source_url": "https://club.example/events/summer-house",
            "venue_name": "Lake Club",
            "quality_score": 75,
        }
        first = SCRAPER.Event(starts_at="2027-08-10T20:00:00+02:00", **common)
        duplicate = SCRAPER.Event(
            starts_at="2027-08-10T20:05:00+02:00",
            description="Description plus complète de la soirée officielle.",
            quality_score=82,
            **{key: value for key, value in common.items() if key != "quality_score"},
        )
        second_session = SCRAPER.Event(
            starts_at="2027-08-10T22:00:00+02:00",
            external_identifier="session-2",
            **common,
        )
        events = SCRAPER._dedupe([first, duplicate, second_session])
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0].quality_score, 82)

    def test_discovers_only_same_domain_event_links(self):
        html = """
        <a href="/agenda/concert-a">A</a>
        <a href="https://club.example/events/party-b#tickets">B</a>
        <a href="https://other.example/events/not-ours">External</a>
        <a href="/media/poster.jpg">Image</a>
        <a href="/contact">Contact</a>
        """
        links = SCRAPER.discover_event_links(html, "https://club.example/agenda/")
        self.assertEqual(
            links,
            ["https://club.example/agenda/concert-a", "https://club.example/events/party-b"],
        )

    def test_rpc_payload_uses_protected_function_contract(self):
        event = SCRAPER.Event(
            title="Concert Test",
            starts_at="2027-01-01T20:00:00+01:00",
            source_url="https://venue.example/events/test",
        )
        payload = event.rpc_payload("00000000-0000-0000-0000-000000000000")
        self.assertEqual(payload["_data_source_id"], "00000000-0000-0000-0000-000000000000")
        self.assertEqual(payload["_payload"]["title"], "Concert Test")
        self.assertIn("external_identifier", payload["_payload"])
        self.assertIn("timezone", payload["_payload"])
        self.assertIn("genres", payload["_payload"])

    def test_edge_mode_prefers_normalized_function_url(self):
        args = SimpleNamespace(
            max_batches=1,
            batch_size=3,
            force=False,
            source_id=[],
            timeout=30,
        )
        calls = []

        def fake_request(url, **kwargs):
            calls.append(url)
            return {"hasMore": False, "nextCursor": 0}

        with patch.dict(
            SCRAPER.os.environ,
            {
                "SUPABASE_FUNCTION_URL": "https://project.supabase.co",
                "SUPABASE_URL": "https://malformed.invalid",
                "GENEVA_SCRAPER_SECRET": "secret",
            },
            clear=True,
        ), patch.object(SCRAPER, "_request_json", side_effect=fake_request):
            self.assertEqual(SCRAPER.run_edge(args), 0)

        self.assertEqual(
            calls,
            ["https://project.supabase.co/functions/v1/scrape-geneva-events"],
        )

    def test_edge_mode_can_force_direct_scraping_without_firecrawl(self):
        args = SimpleNamespace(
            max_batches=1,
            batch_size=1,
            force=True,
            direct_only=True,
            source_id=["00000000-0000-0000-0000-000000000000"],
            timeout=30,
        )
        payloads = []

        def fake_request(_url, **kwargs):
            payloads.append(kwargs["payload"])
            return {"hasMore": False, "nextCursor": 0}

        with patch.dict(
            SCRAPER.os.environ,
            {
                "SUPABASE_URL": "https://project.supabase.co",
                "GENEVA_SCRAPER_SECRET": "secret",
            },
            clear=True,
        ), patch.object(SCRAPER, "_request_json", side_effect=fake_request):
            self.assertEqual(SCRAPER.run_edge(args), 0)

        self.assertTrue(payloads[0]["directOnly"])
        self.assertTrue(payloads[0]["force"])
        self.assertEqual(payloads[0]["sourceIds"], args.source_id)


if __name__ == "__main__":
    unittest.main()
