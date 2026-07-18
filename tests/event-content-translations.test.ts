import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDraftTranslations,
  buildEventTranslationDraft,
  isTranslatableScrapedText,
  normalizeSourceLocale,
  plainTranslationText,
  splitTranslationText,
  type TranslationEventRow,
} from "../supabase/functions/_shared/event-content-translation.ts";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const VENUE_ID = "22222222-2222-4222-8222-222222222222";
const ORGANIZER_ID = "33333333-3333-4333-8333-333333333333";
const OFFER_ID = "44444444-4444-4444-8444-444444444444";
const PERFORMER_ID = "55555555-5555-4555-8555-555555555555";

function eventRow(): TranslationEventRow {
  return {
    id: EVENT_ID,
    title: "Summer night",
    short_description: "A night by the lake",
    description: "<p>Doors open at eight.</p><p>Live music all night.</p>",
    age_restriction: "Adults only",
    language: "English",
    updated_at: "2026-07-19T12:00:00.000Z",
    venue: {
      id: VENUE_ID,
      name: "Lake Hall",
      description: "A venue beside the lake",
      updated_at: "2026-07-19T12:00:00.000Z",
    },
    organizer: {
      id: ORGANIZER_ID,
      name: "Night Culture",
      description: "Independent cultural association",
      updated_at: "2026-07-19T12:00:00.000Z",
    },
    accessibility: { notes: "Use the side entrance" },
    offers: [{ id: OFFER_ID, name: "Early bird ticket" }],
    performers: [
      {
        performer: {
          id: PERFORMER_ID,
          name: "The Example Band",
          type: "Live band",
          bio: "Five musicians from London",
        },
      },
    ],
    scraped: {
      details: {
        schedule: "Concert starts at 20:00",
        booking_url: "https://tickets.example.test/event",
        start_date: "2026-08-02T20:00:00+02:00",
        registration_conditions: "Booking is recommended",
        nested: ["Food is available", "CHF", 25, true],
      },
    },
  };
}

test("normalizes source language aliases and mixed-language values", () => {
  assert.equal(normalizeSourceLocale("English"), "en");
  assert.equal(normalizeSourceLocale("fr-CH"), "fr");
  assert.equal(normalizeSourceLocale("en; zh"), null);
  assert.equal(normalizeSourceLocale("und"), null);
});

test("turns source HTML into readable text before translation", () => {
  assert.equal(
    plainTranslationText("<p>Hello&nbsp;<strong>world</strong></p><p>Next</p>"),
    "Hello world\nNext",
  );
});

test("skips identifiers, links and machine dates while retaining human scraped text", () => {
  assert.equal(isTranslatableScrapedText("booking_url", "https://example.test"), false);
  assert.equal(isTranslatableScrapedText("start_date", "2026-08-02T20:00:00+02:00"), false);
  assert.equal(isTranslatableScrapedText("currency", "CHF"), false);
  assert.equal(isTranslatableScrapedText("registration_conditions", "Booking is required"), true);
});

test("builds a complete structured overlay without altering non-text scraped values", () => {
  const draft = buildEventTranslationDraft(eventRow(), "full");
  assert.equal(draft.eventId, EVENT_ID);
  assert.equal(draft.sourceLocale, "en");
  assert.equal(draft.content.scraped_details?.booking_url, "https://tickets.example.test/event");
  assert.equal(draft.content.scraped_details?.nested?.[2], 25);
  assert.ok(draft.texts.some((item) => item.path.join(".") === "content.scraped_details.schedule"));
  assert.ok(
    !draft.texts.some((item) => item.path.join(".") === "content.scraped_details.booking_url"),
  );
  assert.ok(draft.texts.some((item) => item.path.join(".") === `content.offers.${OFFER_ID}.name`));
  assert.ok(
    draft.texts.some((item) => item.path.join(".") === `content.performers.${PERFORMER_ID}.bio`),
  );
});

test("applies provider results back to their exact structured fields", () => {
  const draft = buildEventTranslationDraft(eventRow(), "full");
  const translations = draft.texts.map((item) => `FR:${item.text}`);
  const translated = applyDraftTranslations(draft, translations);
  assert.equal(translated.title, "FR:Summer night");
  assert.equal(translated.content.venue?.name, "FR:Lake Hall");
  assert.equal(
    translated.content.scraped_details?.registration_conditions,
    "FR:Booking is recommended",
  );
  assert.equal(
    translated.content.scraped_details?.booking_url,
    "https://tickets.example.test/event",
  );
});

test("splits long provider inputs without losing characters", () => {
  const source = `${"A sentence with words. ".repeat(80)}Final sentence.`;
  const chunks = splitTranslationText(source, 300);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), source);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
});
