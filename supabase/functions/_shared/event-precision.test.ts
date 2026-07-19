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

test("JSON-LD ImageObject prefers contentUrl over its human-readable name", () => {
  const html = `<script type="application/ld+json">{
    "@type":"Event",
    "name":"Affiche officielle",
    "startDate":"2026-08-20T20:00:00+02:00",
    "image":{"@type":"ImageObject","name":"Affiche","contentUrl":"/media/poster.jpg"},
    "url":"/events/poster"
  }</script>`;
  const candidate = extractJsonLdCandidates(html, "https://example.ch/agenda", GENEVA_SOURCE)[0];
  assert.equal(candidate?.imageUrls?.[0], "https://example.ch/media/poster.jpg");
});

test("JSON-LD preserves explicit venue, performer, age and accessibility data", () => {
  const html = `
    <script type="application/ld+json">
    {
      "@context":"https://schema.org",
      "@type":"MusicEvent",
      "@id":"rich-show-1",
      "name":"Lake Collective avec DJ Support",
      "description":"Une soirée officielle avec toutes les informations pratiques pour le public.",
      "startDate":"2026-08-22T20:00:00+02:00",
      "typicalAgeRange":"18+",
      "location": {
        "@type":"Place",
        "name":"Scène du Lac",
        "url":"/venues/scene-du-lac",
        "address": {
          "streetAddress":"Quai du Mont-Blanc 1",
          "postalCode":"1201",
          "addressLocality":"Genève",
          "addressCountry":"CH"
        },
        "amenityFeature":[
          {"@type":"LocationFeatureSpecification","name":"wheelchairAccessible","value":true}
        ],
        "accessibilitySummary":"Entrée sans marche par le quai."
      },
      "performer":[
        {"@type":"https://schema.org/MusicGroup","name":"Lake Collective"},
        {"@type":"Person","name":"DJ Support","image":"/artists/dj-support.jpg"}
      ],
      "headliner":{
        "@type":"MusicGroup",
        "name":"Lake Collective",
        "image":"/artists/lake-collective.jpg"
      },
      "accessibilityFeature":["hearingLoop","signLanguage","quietSpace"],
      "accessibilitySummary":"Interprétation en langue des signes annoncée.",
      "url":"/events/rich-show-1"
    }
    </script>`;

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

  assert.equal(result.event.venueUrl, "https://example.ch/venues/scene-du-lac");
  assert.equal(result.event.postalCode, "1201");
  assert.equal(result.event.ageRestriction, "18+");
  assert.deepEqual(result.event.performers, [
    {
      name: "Lake Collective",
      type: "MusicGroup",
      imageUrl: "https://example.ch/artists/lake-collective.jpg",
      isHeadliner: true,
    },
    {
      name: "DJ Support",
      type: "Person",
      imageUrl: "https://example.ch/artists/dj-support.jpg",
      isHeadliner: false,
    },
  ]);
  assert.deepEqual(result.event.accessibility, {
    wheelchair: true,
    hearingLoop: true,
    signLanguage: true,
    quietSpace: true,
    notes: "Interprétation en langue des signes annoncée. · Entrée sans marche par le quai.",
  });
});

test("JSON-LD derives an age range only from explicit PeopleAudience bounds", () => {
  const html = `
    <script type="application/ld+json">
    {
      "@context":"https://schema.org",
      "@type":"Event",
      "name":"Atelier adolescents",
      "description":"Un atelier officiel avec inscription et informations pratiques complètes.",
      "startDate":"2026-08-23T14:00:00+02:00",
      "audience":{
        "@type":"PeopleAudience",
        "audienceType":"Familles",
        "suggestedMinAge":12,
        "suggestedMaxAge":17
      },
      "location":{"@type":"Place","name":"Maison de quartier"},
      "url":"/events/atelier-adolescents"
    }
    </script>`;

  const [candidate] = extractJsonLdCandidates(html, "https://example.ch/agenda", GENEVA_SOURCE);
  assert.equal(candidate.ageRestriction, "12-17");
  const event = normalize(candidate);
  assert.equal(event.ageRestriction, "12-17");
  assert.deepEqual(event.performers, []);
  assert.equal(event.accessibility, null);
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

test("country names are converted to ISO codes instead of being truncated", () => {
  const cases = [
    { supplied: "United States", fallback: "US", expected: "US", currency: "USD" },
    { supplied: "South Africa", fallback: "ZA", expected: "ZA", currency: "ZAR" },
    { supplied: "United Arab Emirates", fallback: "AE", expected: "AE", currency: "AED" },
  ];

  for (const country of cases) {
    const source: EventSourceContext = {
      ...GENEVA_SOURCE,
      city: {
        ...GENEVA_SOURCE.city!,
        country: { code: country.fallback },
      },
    };
    const result = normalizeEventCandidate(
      {
        title: `Official event in ${country.supplied}`,
        description: "A detailed official event description for country normalization coverage.",
        startDate: "2026-07-20T20:30:00+02:00",
        countryCode: country.supplied,
        sourceUrl: "https://example.ch/events/country-test",
      },
      source,
      "https://example.ch/agenda",
      NOW,
    );
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.event.countryCode, country.expected);
    assert.equal(result.event.currency, country.currency);
  }
});

test("unknown country names fall back to the source country", () => {
  const event = normalize({
    title: "Official event with an ambiguous country label",
    description: "A detailed official event description with a non-standard country label.",
    startDate: "2026-07-20T20:30:00+02:00",
    countryCode: "Confederation Helvetica",
    sourceUrl: "https://example.ch/events/fallback-country",
  });
  assert.equal(event.countryCode, "CH");
  assert.equal(event.currency, "CHF");
});

test("a source-city event cannot switch to a conflicting two-letter country", () => {
  const event = normalize({
    title: "Official Geneva city event",
    description: "A detailed official event description in the registered source city.",
    startDate: "2026-07-20T20:30:00+02:00",
    city: "Genève",
    countryCode: "UN",
    sourceUrl: "https://example.ch/events/source-country-guard",
  });
  assert.equal(event.countryCode, "CH");
  assert.ok(event.warnings.includes("country_differs_from_source"));
});

test("unclassified events use the recognizable other category", () => {
  const source: EventSourceContext = { ...GENEVA_SOURCE, category_slug: null };
  const result = normalizeEventCandidate(
    {
      title: "A singular gathering",
      description: "A detailed announcement without any supported taxonomy keyword.",
      startDate: "2026-07-20T20:30:00+02:00",
      sourceUrl: "https://example.ch/events/unclassified",
    },
    source,
    "https://example.ch/agenda",
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.category, "other");
});

test("nearby derived cities keep an explicitly approximate event pin", () => {
  const source: EventSourceContext = {
    ...GENEVA_SOURCE,
    city: {
      name: "Los Angeles",
      timezone: "America/Los_Angeles",
      latitude: 34.0522,
      longitude: -118.2437,
      country: { code: "US" },
    },
  };
  const result = normalizeEventCandidate(
    {
      title: "Burbank community gathering",
      description: "A detailed official event announcement without explicit venue coordinates.",
      startDate: "2026-07-20T20:30:00-07:00",
      city: "Burbank",
      countryCode: "United States",
      sourceUrl: "https://example.ch/events/burbank",
    },
    source,
    "https://example.ch/agenda",
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.latitude, 34.0522);
  assert.equal(result.event.longitude, -118.2437);
  assert.ok(result.event.warnings.includes("approximate_source_city_coordinates"));
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

test("the worldwide taxonomy preserves every supported category slug", () => {
  const categories = [
    "concerts",
    "festivals",
    "expositions",
    "soirees",
    "theatre",
    "famille",
    "sports-outdoor",
    "heritage",
    "gastronomy",
    "activities",
    "conferences",
    "cinema",
    "leisure",
    "other",
  ];

  for (const [index, category] of categories.entries()) {
    const event = normalize({
      title: `Événement mondial ${index + 1}`,
      description: "Un rendez-vous officiel avec toutes les informations utiles pour le public.",
      category,
      startDate: `2026-09-${String(index + 1).padStart(2, "0")}T18:00:00+02:00`,
      venueName: "Lieu officiel",
      sourceUrl: `https://example.ch/events/world-${index + 1}`,
    });
    assert.equal(event.category, category);
  }
});

test("outdoor, food, talks and screenings are classified from multilingual content", () => {
  const cases = [
    ["Randonnée urbaine", "Visite guidée et randonnée en plein air.", "sports-outdoor"],
    ["Open Air Yoga", "Cours collectif dans le parc.", "sports-outdoor"],
    ["Open Air Festival", "Programmation musicale sur plusieurs scènes.", "festivals"],
    ["Marché gourmand", "Dégustation et cuisine locale.", "gastronomy"],
    ["Rencontre publique", "Conférence et débat avec les artistes.", "conferences"],
    ["Film sous les étoiles", "Projection cinéma officielle.", "cinema"],
  ] as const;

  for (const [index, [title, description, expected]] of cases.entries()) {
    const event = normalize({
      title,
      description,
      startDate: `2026-10-${String(index + 1).padStart(2, "0")}T19:00:00+02:00`,
      venueName: "Lieu officiel",
      sourceUrl: `https://example.ch/events/classified-${index + 1}`,
    });
    assert.equal(event.category, expected);
  }
});

test("known city aliases resolve to the registered source city", () => {
  const source: EventSourceContext = {
    ...GENEVA_SOURCE,
    name: "Rome — agenda officiel",
    domain: "turismoroma.it",
    metadata: { city_aliases: ["Rome", "Roma"] },
    city: {
      name: "Rome",
      timezone: "Europe/Rome",
      latitude: 41.9028,
      longitude: 12.4964,
      country: { code: "IT" },
    },
  };
  const result = normalizeEventCandidate(
    {
      title: "Visita serale",
      description: "Visita guidata ufficiale con tutte le informazioni per il pubblico.",
      startDate: "2026-11-12T19:00:00+01:00",
      city: "Roma",
      venueName: "Museo civico",
      sourceUrl: "https://turismoroma.it/eventi/visita-serale",
    },
    source,
    "https://turismoroma.it/eventi",
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.city, "Rome");
  assert.equal(result.event.warnings.includes("city_differs_from_source"), false);
});

test("world expansion countries use their local currency fallback", () => {
  const cases = [
    ["MX", "MXN", "America/Mexico_City"],
    ["KR", "KRW", "Asia/Seoul"],
    ["SG", "SGD", "Asia/Singapore"],
    ["AE", "AED", "Asia/Dubai"],
    ["ZA", "ZAR", "Africa/Johannesburg"],
    ["MA", "MAD", "Africa/Casablanca"],
  ] as const;

  for (const [index, [countryCode, currency, timezone]] of cases.entries()) {
    const source: EventSourceContext = {
      ...GENEVA_SOURCE,
      category_slug: null,
      city: {
        name: `Ville ${countryCode}`,
        timezone,
        latitude: null,
        longitude: null,
        country: { code: countryCode },
      },
    };
    const result = normalizeEventCandidate(
      {
        title: `Événement officiel ${countryCode}`,
        description: "Toutes les informations utiles sont publiées dans l’agenda officiel.",
        startDate: `2026-12-${String(index + 1).padStart(2, "0")}T19:00:00`,
        venueName: "Centre culturel",
        sourceUrl: "https://example.ch/agenda",
      },
      source,
      "https://example.ch/agenda",
      NOW,
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.event.currency, currency);
  }
});

test("an unmapped country never receives an invented EUR currency", () => {
  const source: EventSourceContext = {
    ...GENEVA_SOURCE,
    city: {
      name: "Mumbai",
      timezone: "Asia/Kolkata",
      latitude: 19.076,
      longitude: 72.8777,
      country: { code: "IN" },
    },
  };
  const result = normalizeEventCandidate(
    {
      title: "Open Air Mumbai",
      description: "A complete official listing with practical information for visitors.",
      startDate: "2026-12-10T19:00:00+05:30",
      venueName: "City Park",
      sourceUrl: "https://example.ch/mumbai/open-air",
    },
    source,
    "https://example.ch/mumbai/open-air",
    NOW,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.event.currency, null);
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

test("duplicate merging keeps rich fields from the lower-scored source", () => {
  const primary = normalize({
    externalId: "rich-merge-1",
    title: "Global Music Night",
    description:
      "Une longue description officielle avec tous les détails du programme et de la billetterie.",
    startDate: "2026-09-18T20:00:00+02:00",
    endDate: "2026-09-18T23:30:00+02:00",
    venueName: "Lake Club",
    imageUrl: "https://example.ch/media/global-music-night.jpg",
    ticketUrl: "https://example.ch/tickets/global-music-night",
    performers: [{ name: "Artist One", type: "Person", isHeadliner: false }],
    accessibility: { wheelchair: true },
    sourceUrl: "https://example.ch/events/rich-merge-1",
  });
  const secondary = normalize({
    externalId: "rich-merge-1",
    title: "Global Music Night",
    description: "Programme officiel.",
    startDate: "2026-09-18T20:00:00+02:00",
    venueName: "Lake Club",
    venueUrl: "https://example.ch/venues/lake-club",
    postalCode: "1201",
    ageRestriction: "18+",
    performers: [
      {
        name: "Artist One",
        type: "Person",
        imageUrl: "https://example.ch/artists/artist-one.jpg",
        isHeadliner: true,
      },
      { name: "Artist Two", type: "MusicGroup", isHeadliner: false },
    ],
    accessibility: {
      hearingLoop: true,
      signLanguage: true,
      notes: "Boucle auditive disponible.",
    },
    sourceUrl: "https://example.ch/events/rich-merge-1",
  });
  assert.ok(primary.qualityScore > secondary.qualityScore);

  const result = deduplicateNormalizedEvents([primary, secondary]);
  assert.equal(result.events.length, 1);
  assert.equal(result.duplicates, 1);
  const [event] = result.events;
  assert.equal(event.venueUrl, "https://example.ch/venues/lake-club");
  assert.equal(event.postalCode, "1201");
  assert.equal(event.ageRestriction, "18+");
  assert.deepEqual(event.performers, [
    {
      name: "Artist One",
      type: "Person",
      imageUrl: "https://example.ch/artists/artist-one.jpg",
      isHeadliner: true,
    },
    {
      name: "Artist Two",
      type: "MusicGroup",
      imageUrl: null,
      isHeadliner: false,
    },
  ]);
  assert.deepEqual(event.accessibility, {
    wheelchair: true,
    hearingLoop: true,
    signLanguage: true,
    quietSpace: false,
    notes: "Boucle auditive disponible.",
  });
});
