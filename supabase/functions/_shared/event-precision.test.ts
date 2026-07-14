import assert from "node:assert/strict";
import test from "node:test";

import {
  deduplicateNormalizedEvents,
  extractJsonLdCandidates,
  normalizeEventCandidate,
  type EventCandidate,
  type EventSourceContext,
} from "./event-precision.ts";

const GENEVA_SOURCE: EventSourceContext = {
  id: "source-geneva",
  name: "Agenda Genève",
  domain: "example.ch",
  category_slug: "concerts",
  metadata: {},
  city: {
    name: "Genève",
    timezone: "Europe/Zurich",
    latitude: 46.2044,
    longitude: 6.1432,
    country: { code: "CH" },
  },
};

const NOW = new Date("2026-07-14T12:00:00Z");

function normalize(candidate: EventCandidate) {
  const result = normalizeEventCandidate(
    candidate,
    GENEVA_SOURCE,
    "https://example.ch/agenda",
    NOW,
  );
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  return result.ok ? result.event : assert.fail("normalization failed");
}

test("JSON-LD wins deterministic dates, offers, place and status", () => {
  const html = `
    <script type="application/ld+json"><!--
    {
      "@context":"https://schema.org",
      "@type":"MusicEvent",
      "@id":"show-42",
      "name":"Live au bord du lac",
      "description":"Un concert officiel avec une description assez complète pour être publié.",
      "startDate":"2026-07-20",
      "endDate":"2026-07-21",
      "eventStatus":"https://schema.org/EventScheduled",
      "location": {
        "@type":"Place",
        "name":"Scène du Lac",
        "address": {
          "streetAddress":"Quai du Mont-Blanc 1",
          "postalCode":"1201",
          "addressLocality":"Genève",
          "addressCountry":"CH"
        },
        "geo":{"latitude":"46.207", "longitude":"6.151"}
      },
      "offers": [{"lowPrice":"15", "highPrice":"35", "priceCurrency":"CHF", "url":"/tickets/42"}],
      "image":{"url":"/media/show-42.jpg"},
      "url":"/events/show-42"
    }
    --></script>`;
  const candidates = extractJsonLdCandidates(html, "https://example.ch/agenda", GENEVA_SOURCE);
  assert.equal(candidates.length, 1);
  const result = normalizeEventCandidate(
    candidates[0],
    GENEVA_SOURCE,
    "https://example.ch/agenda",
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.extractionMethod, "jsonld");
  assert.equal(result.event.timePrecision, "date");
  assert.equal(result.event.allDay, true);
  assert.equal(result.event.startDate, "2026-07-19T22:00:00.000Z");
  assert.equal(result.event.endDate, "2026-07-21T22:00:00.000Z");
  assert.equal(result.event.priceMin, 15);
  assert.equal(result.event.priceMax, 35);
  assert.equal(result.event.currency, "CHF");
  assert.equal(result.event.ticketUrl, "https://example.ch/tickets/42");
  assert.equal(result.event.latitude, 46.207);
  assert.ok(result.event.qualityScore >= 80);
});

test("naive times use the source IANA timezone instead of the runner timezone", () => {
  const source: EventSourceContext = {
    ...GENEVA_SOURCE,
    domain: "events.example.com",
    city: {
      name: "New York",
      timezone: "America/New_York",
      latitude: 40.7128,
      longitude: -74.006,
      country: { code: "US" },
    },
  };
  const result = normalizeEventCandidate(
    {
      title: "Brooklyn Night Session",
      description: "A detailed official club night announcement in Brooklyn.",
      startDate: "2026-07-20T20:30:00",
      venueName: "Example Hall",
      sourceUrl: "https://events.example.com/shows/1",
    },
    source,
    "https://events.example.com/calendar",
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.startDate, "2026-07-21T00:30:00.000Z");
  assert.equal(result.event.currency, "USD");
});

test("hallucinated coordinates and off-domain detail URLs are discarded", () => {
  const event = normalize({
    title: "Festival Test",
    description: "Festival officiel annoncé avec tous les détails utiles pour le public.",
    startDate: "2026-08-10T19:00:00+02:00",
    venueName: "Plaine de Plainpalais",
    latitude: 40.7128,
    longitude: -74.006,
    sourceUrl: "https://invented.invalid/event/123",
  });
  assert.equal(event.latitude, null);
  assert.equal(event.longitude, null);
  assert.equal(event.sourceUrl, "https://example.ch/agenda");
  assert.ok(
    event.warnings.some((warning) => warning.startsWith("coordinates_outside_source_area")),
  );
  assert.ok(event.warnings.includes("off_domain_source_url"));
});

test("navigation and commerce cards are rejected", () => {
  const result = normalizeEventCandidate(
    { title: "Gift card", startDate: "2026-08-10" },
    GENEVA_SOURCE,
    "https://example.ch/agenda",
    NOW,
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "navigation_or_commerce",
    candidate: { title: "Gift card", startDate: "2026-08-10" },
  });
});

test("duplicates merge but distinct sessions remain distinct", () => {
  const first = normalize({
    externalId: "party-1",
    title: "Summer House Party",
    description: "Une grande soirée house officielle au bord du lac avec billetterie.",
    startDate: "2026-08-10T20:00:00+02:00",
    venueName: "Lake Club",
    sourceUrl: "https://example.ch/events/party-1",
  });
  const enriched = normalize({
    externalId: "party-1",
    title: "Summer House Party",
    description:
      "Une grande soirée house officielle au bord du lac avec billetterie et DJ invités.",
    startDate: "2026-08-10T20:00:00+02:00",
    venueName: "Lake Club",
    imageUrl: "https://example.ch/media/party.jpg",
    sourceUrl: "https://example.ch/events/party-1",
  });
  const secondSession = normalize({
    externalId: "party-2",
    title: "Summer House Party",
    description: "Une seconde séance officielle de la même soirée house.",
    startDate: "2026-08-10T22:00:00+02:00",
    venueName: "Lake Club",
    sourceUrl: "https://example.ch/events/party-2",
  });
  const result = deduplicateNormalizedEvents([first, enriched, secondSession]);
  assert.equal(result.events.length, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.events[0].imageUrl, "https://example.ch/media/party.jpg");
});
