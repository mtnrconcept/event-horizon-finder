import assert from "node:assert/strict";
import test from "node:test";

import {
  attachMapOccurrenceDetailCollections,
  assertMapOccurrenceId,
  formatMapDetailPrice,
  mapDetailLocationParts,
  parseMapOccurrenceDetailRow,
  safeExternalUrl,
} from "../src/lib/map-event-details.ts";
import { loadAllPages } from "../src/lib/load-all-pages.ts";

const OCCURRENCE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_OCCURRENCE_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const VENUE_ID = "44444444-4444-4444-8444-444444444444";
const CITY_ID = "55555555-5555-4555-8555-555555555555";
const REGION_ID = "66666666-6666-4666-8666-666666666666";
const COUNTRY_ID = "77777777-7777-4777-8777-777777777777";
const ORGANIZER_ID = "88888888-8888-4888-8888-888888888888";

function occurrence(id: string, startsAt: string) {
  return {
    id,
    starts_at: startsAt,
    ends_at: "2026-07-19T02:00:00+02:00",
    doors_open_at: "2026-07-18T19:00:00+02:00",
    timezone: "Europe/Zurich",
    all_day: false,
    time_precision: "exact",
    local_start_date: "2026-07-18",
    local_end_date: "2026-07-19",
    status: "scheduled",
    ticket_status: "available",
    capacity: "2500",
    latitude: 46.2044,
    longitude: 6.1432,
  };
}

function rawDetail(overrides: Record<string, unknown> = {}) {
  const city = {
    id: CITY_ID,
    slug: "geneve",
    name: "Genève",
    timezone: "Europe/Zurich",
    region: { id: REGION_ID, name: "Genève" },
    country: { id: COUNTRY_ID, code: "CH", name: "Suisse" },
  };
  return {
    ...occurrence(OCCURRENCE_ID, "2026-07-18T20:00:00+02:00"),
    event: {
      id: EVENT_ID,
      slug: "open-air-geneve",
      title: "Open Air Genève",
      short_description: "Une nuit au bord du lac.",
      description: "Programmation complète.",
      cover_image_url: "https://cdn.example.test/cover.jpg",
      official_url: "https://events.example.test/open-air",
      age_restriction: "18+",
      genres: ["Electronic", " House ", "Electronic", null],
      language: "fr",
      is_free: false,
      is_verified: true,
      status: "published",
      verification_level: "official",
      category: {
        slug: "concerts",
        name_fr: "Concerts",
        name_en: "Concerts",
        icon: "music",
      },
      organizer: {
        id: ORGANIZER_ID,
        slug: "global-party",
        name: "Global Party",
        description: "Organisateur",
        website: "https://organizer.example.test",
        logo_url: "https://cdn.example.test/logo.png",
        is_verified: true,
      },
      venue: {
        id: VENUE_ID,
        slug: "le-club",
        name: "Le Club",
        address: "Rue du Lac 1",
        postal_code: "1200",
        description: "Salle principale",
        capacity: 3000,
        website: "https://venue.example.test",
        cover_image_url: "https://cdn.example.test/venue.jpg",
        is_verified: true,
        latitude: 46.2044,
        longitude: 6.1432,
        city,
        country: city.country,
      },
      city,
      occurrences: [
        occurrence(SECOND_OCCURRENCE_ID, "2026-07-20T20:00:00+02:00"),
        occurrence(OCCURRENCE_ID, "2026-07-18T20:00:00+02:00"),
      ],
      offers: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          name: "Tarif standard",
          price_min: "25.50",
          price_max: 45,
          currency: "chf",
          is_free: false,
          ticket_url: "https://tickets.example.test/open-air",
          status: "available",
        },
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "Invitation",
          price_min: null,
          price_max: null,
          currency: "CHF",
          is_free: true,
          ticket_url: "javascript:alert(1)",
          status: "available",
        },
      ],
      media: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          url: "https://cdn.example.test/gallery.jpg",
          media_type: "image",
          attribution: "Photographe",
          license: "CC BY",
          source_url: "https://source.example.test/photo",
          sort_order: 2,
        },
        {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          url: "https://cdn.example.test/trailer.mp4",
          media_type: "video",
          attribution: null,
          license: null,
          source_url: null,
          sort_order: 1,
        },
      ],
      accessibility: {
        wheelchair: true,
        hearing_loop: false,
        sign_language: null,
        quiet_space: true,
        notes: "Entrée latérale accessible",
      },
      performers: [
        {
          is_headliner: false,
          performer: {
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            slug: "b-artist",
            name: "B Artist",
            type: "DJ",
            bio: "Bio B",
            image_url: "https://cdn.example.test/b.jpg",
          },
        },
        {
          is_headliner: true,
          performer: {
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            slug: "a-artist",
            name: "A Artist",
            type: "Live",
            bio: "Bio A",
            image_url: "https://cdn.example.test/a.jpg",
          },
        },
      ],
      publication: [
        {
          short_description: "Résumé factuel public.",
          description: "Description factuelle publique.",
          cover_image_url: null,
          projection_version: 2,
          is_active: true,
          details: {
            booking_required: true,
            source: "Agenda public",
            source_url: "https://partner.example.test",
          },
        },
      ],
    },
    ...overrides,
  };
}

test("validates and normalizes the occurrence UUID before querying", () => {
  assert.equal(assertMapOccurrenceId(`  ${OCCURRENCE_ID}  `), OCCURRENCE_ID);
  assert.throws(() => assertMapOccurrenceId("occurrence-1"), {
    name: "TypeError",
    message: "Invalid occurrence id",
  });
});

test("accepts only absolute credential-free HTTP(S) URLs", () => {
  assert.equal(safeExternalUrl("HTTPS://Example.com/path"), "https://example.com/path");
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("/relative"), null);
  assert.equal(safeExternalUrl("https://user:secret@example.com/path"), null);
});

test("parses the complete public event graph and keeps the clicked occurrence id", () => {
  const detail = parseMapOccurrenceDetailRow(rawDetail());
  assert.ok(detail);
  assert.equal(detail.occurrence_id, OCCURRENCE_ID);
  assert.equal(detail.selected_occurrence.id, OCCURRENCE_ID);
  assert.equal(detail.event_id, EVENT_ID);
  assert.equal(detail.uses_publication_projection, true);
  assert.equal(detail.short_description, "Résumé factuel public.");
  assert.equal(detail.description, "Description factuelle publique.");
  assert.equal(detail.cover_image_url, null);
  assert.equal(detail.venue?.description, null);
  assert.equal(detail.venue?.cover_image_url, null);
  assert.equal(detail.organizer?.description, null);
  assert.equal(detail.organizer?.logo_url, null);
  assert.deepEqual(detail.genres, ["Electronic", "House"]);
  assert.deepEqual(
    detail.occurrences.map((item) => item.id),
    [OCCURRENCE_ID, SECOND_OCCURRENCE_ID],
  );
  assert.deepEqual(
    detail.offers.map((item) => item.name),
    ["Invitation", "Tarif standard"],
  );
  assert.equal(detail.offers[0].ticket_url, null);
  assert.equal(detail.offers[1].price_min, 25.5);
  assert.deepEqual(
    detail.media.map((item) => item.media_type),
    ["video", "image"],
  );
  assert.deepEqual(
    detail.performers.map((item) => item.name),
    ["A Artist", "B Artist"],
  );
  assert.deepEqual(detail.scraped_details, {
    booking_required: true,
    source: "Agenda public",
    source_url: "https://partner.example.test",
  });
  assert.ok(detail.performers.every((performer) => !performer.bio && !performer.image_url));
  assert.deepEqual(mapDetailLocationParts(detail), [
    "Le Club",
    "Rue du Lac 1",
    "1200 Genève",
    "Genève",
    "Suisse",
  ]);
});

test("keeps original fields for organizer-managed events without a publication projection", () => {
  const value = rawDetail();
  const event = value.event as Record<string, unknown>;
  delete event.publication;
  const detail = parseMapOccurrenceDetailRow(value);
  assert.ok(detail);
  assert.equal(detail.uses_publication_projection, false);
  assert.equal(detail.description, "Programmation complète.");
  assert.equal(detail.venue?.description, "Salle principale");
  assert.equal(detail.organizer?.description, "Organisateur");
  assert.equal(detail.performers[0].bio, "Bio A");
});

test("attaches every paginated row beyond 1,000 without mutating the main payload", async () => {
  const sourceOffers = Array.from({ length: 1_005 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    name: `Offer ${index.toString().padStart(4, "0")}`,
    price_min: index,
    price_max: index,
    currency: "CHF",
    is_free: false,
    ticket_url: null,
    status: "available",
  }));
  const pageRequests: Array<{ limit: number; offset: number }> = [];
  const offers = await loadAllPages({
    pageSize: 400,
    getKey: (offer) => offer.id,
    fetchPage: async (request) => {
      pageRequests.push(request);
      return sourceOffers.slice(request.offset, request.offset + request.limit);
    },
  });
  const value = rawDetail();
  const event = value.event as Record<string, unknown>;
  const originalOffers = event.offers;
  const attached = attachMapOccurrenceDetailCollections(value, {
    occurrences: [],
    offers,
    media: event.media as unknown[],
    performers: event.performers as unknown[],
  });

  assert.notEqual(attached, value);
  assert.equal(event.offers, originalOffers);
  assert.deepEqual(pageRequests, [
    { limit: 400, offset: 0 },
    { limit: 400, offset: 400 },
    { limit: 400, offset: 800 },
  ]);

  const detail = parseMapOccurrenceDetailRow(attached);
  assert.ok(detail);
  assert.equal(detail.offers.length, sourceOffers.length);
  assert.equal(detail.occurrences.length, 1);
  assert.equal(detail.occurrences[0].id, OCCURRENCE_ID);
  assert.equal(detail.media.length, 2);
  assert.equal(detail.performers.length, 2);
});

test("drops malformed optional relations but rejects a malformed primary record", () => {
  const value = rawDetail();
  const event = value.event as Record<string, unknown>;
  event.organizer = { id: "not-a-uuid", name: "Broken" };
  event.media = [{ id: "bad", url: "javascript:bad", media_type: "image" }];
  const detail = parseMapOccurrenceDetailRow(value);
  assert.ok(detail);
  assert.equal(detail.organizer, null);
  assert.deepEqual(detail.media, []);

  assert.equal(parseMapOccurrenceDetailRow({ ...value, id: "not-an-id" }), null);
  assert.equal(parseMapOccurrenceDetailRow(null), null);
});

test("formats free, fixed and ranged prices without inventing a value", () => {
  assert.equal(
    formatMapDetailPrice({ price_min: null, price_max: null, currency: "CHF", is_free: true }),
    "Gratuit",
  );
  assert.equal(
    formatMapDetailPrice({ price_min: 20, price_max: 20, currency: "CHF", is_free: false }),
    "20 CHF",
  );
  assert.equal(
    formatMapDetailPrice({ price_min: 20, price_max: 35, currency: "CHF", is_free: false }),
    "20 – 35 CHF",
  );
  assert.equal(
    formatMapDetailPrice({ price_min: null, price_max: null, currency: null, is_free: false }),
    null,
  );
});
