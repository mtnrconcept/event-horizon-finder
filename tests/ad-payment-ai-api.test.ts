import assert from "node:assert/strict";
import test from "node:test";
import { fallbackDraft, normalizeAdDraft } from "../supabase/functions/_shared/ad-draft.ts";
import {
  parseStripeSignature,
  verifyStripeSignature,
} from "../supabase/functions/_shared/stripe-signature.ts";

const insight = {
  event_id: "5becc052-b9a0-4b82-b155-1071719d10a9",
  title: "Festival test",
  short_description: "Une soirée",
  genres: ["house"],
  city_id: "456df60a-5474-44dd-9a67-b5162073745d",
  cover_image_url: "https://trusted.test/cover.jpg",
  official_url: "https://trusted.test/tickets",
  view_count: 12,
  like_count: 3,
  comment_count: 1,
};

test("Stripe signature accepts any valid v1 during secret rotation", async () => {
  const payload = '{"id":"evt_test"}';
  const secret = "whsec_test";
  const timestamp = 1_700_000_000;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const valid = Buffer.from(digest).toString("hex");
  const header = `t=${timestamp},v1=old_signature,v1=${valid}`;
  assert.deepEqual(parseStripeSignature(header), {
    timestamp,
    signatures: ["old_signature", valid],
  });
  assert.equal(await verifyStripeSignature(payload, header, secret, timestamp), true);
  assert.equal(await verifyStripeSignature(`${payload} `, header, secret, timestamp), false);
  assert.equal(await verifyStripeSignature(payload, header, secret, timestamp + 301), false);
});

test("AI draft keeps database URLs and targeting identifiers authoritative", () => {
  const draft = normalizeAdDraft(
    {
      name: "Ma campagne",
      objective: "ticket_sales",
      promotedEventId: insight.event_id,
      headline: "Réserve maintenant",
      body: "Places limitées",
      imageUrl: "https://attacker.test/image.jpg",
      ctaUrl: "https://attacker.test/phishing",
      genres: ["house", "invented"],
      cityIds: ["attacker-city"],
      rationale: "Bon engagement",
    },
    [insight],
  );
  assert.equal(draft.imageUrl, insight.cover_image_url);
  assert.equal(draft.ctaUrl, insight.official_url);
  assert.deepEqual(draft.genres, ["house"]);
  assert.deepEqual(draft.cityIds, [insight.city_id]);
});

test("AI cannot promote an event outside the organizer insights", () => {
  assert.throws(
    () =>
      normalizeAdDraft(
        {
          ...fallbackDraft(insight),
          promotedEventId: "a4412ee7-4da9-478b-8498-9c99285e7cac",
        },
        [insight],
      ),
    /non autorisé/,
  );
});
