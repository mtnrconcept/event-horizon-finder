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
        self.assertEqual(payload["_title"], "Concert Test")
        self.assertEqual(payload["_data_source_id"], "00000000-0000-0000-0000-000000000000")
        self.assertIn("_external_identifier", payload)

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


if __name__ == "__main__":
    unittest.main()
