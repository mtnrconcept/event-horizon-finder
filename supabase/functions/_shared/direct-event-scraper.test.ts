import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverDirectEventLinks,
  extractHtmlEventCandidates,
  scrapeDirectEventSource,
} from "./direct-event-scraper.ts";
import type { EventSourceContext } from "./event-precision.ts";

const SOURCE: EventSourceContext = {
  id: "source-direct",
  name: "Agenda officiel",
  domain: "events.example.ch",
  category_slug: "concerts",
  metadata: { direct_detail_limit: 5 },
  city: {
    name: "Genève",
    timezone: "Europe/Zurich",
    latitude: 46.2044,
    longitude: 6.1432,
    country: { code: "CH" },
  },
};

function htmlResponse(html: string, url: string, status = 200): Response {
  const response = new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("direct mode extracts list JSON-LD and follows only same-domain event pages", async () => {
  const root = `
    <script type="application/ld+json">{
      "@type":"MusicEvent",
      "@id":"root-show",
      "name":"Root Show",
      "startDate":"2026-08-20T20:00:00+02:00",
      "url":"/events/root-show"
    }</script>
    <a href="/events/detail-show?utm_source=list">Detail</a>
    <a href="https://outside.invalid/events/invented">External</a>
    <a href="/media/poster.jpg">Poster</a>`;
  const detail = `
    <script type="application/ld+json">{
      "@type":"Event",
      "@id":"detail-show",
      "name":"Detail Show",
      "startDate":"2026-08-21T21:30:00+02:00",
      "location":{"name":"Direct Hall"},
      "url":"/events/detail-show"
    }</script>`;
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("detail-show")) {
      return htmlResponse(detail, "https://events.example.ch/events/detail-show");
    }
    return htmlResponse(root, "https://events.example.ch/agenda");
  };

  const result = await scrapeDirectEventSource(
    { url: "https://events.example.ch/agenda", source: SOURCE },
    { fetcher, timeoutMs: 1_000 },
  );

  assert.equal(result.mode, "direct");
  assert.equal(result.metadata.detailPagesAttempted, 1);
  assert.equal(result.metadata.detailPagesFetched, 1);
  assert.deepEqual(
    result.candidates.map((event) => event.title),
    ["Root Show", "Detail Show"],
  );
  assert.deepEqual(requests, [
    "https://events.example.ch/agenda",
    "https://events.example.ch/events/detail-show?utm_source=list",
  ]);
});

test("link discovery rejects external and non-event resources", () => {
  const links = discoverDirectEventLinks(
    `<a href="/concert/one">One</a>
     <a href="https://other.invalid/event/two">Two</a>
     <a href="/event/poster.png">Image</a>
     <a href="mailto:test@example.ch">Mail</a>`,
    "https://events.example.ch/agenda",
    SOURCE,
  );
  assert.deepEqual(links, ["https://events.example.ch/concert/one"]);
});

test("direct HTML detail extraction preserves local time, overnight end, genres and prices", () => {
  const html = `<!doctype html>
    <html lang="fr-FR"><head>
      <meta property="og:title" content="808RAVE - La Gravière">
      <meta property="og:description" content="Une nouvelle édition avec plusieurs artistes internationaux.">
      <meta property="og:url" content="https://events.example.ch/evenement/808rave/">
      <meta property="og:image" content="https://events.example.ch/media/808rave.png">
    </head><body>
      <article id="post-4999" class="evenement genre-club-music genre-latincore genre-techno genre-trance">
        <h1 class="entry-title">808RAVE</h1>
        <p><strong>Date </strong>: Vendredi 17 juillet 2026<br>
        <strong>Horaires </strong>: 23h59-06h<br>
        <strong>Tarifs </strong>: 15.- / 10.- avant 1h / Entrée gratuite membres</p>
      </article>
    </body></html>`;

  const candidates = extractHtmlEventCandidates(
    html,
    "https://events.example.ch/evenement/808rave/",
    SOURCE,
  );

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    externalId: "4999",
    title: "808RAVE",
    description: "Une nouvelle édition avec plusieurs artistes internationaux.",
    startDate: "2026-07-17T23:59:00",
    endDate: "2026-07-18T06:00:00",
    timezone: "Europe/Zurich",
    timePrecision: "exact",
    allDay: false,
    venueName: "Agenda officiel",
    city: "Genève",
    countryCode: "CH",
    organizerName: "Agenda officiel",
    organizerUrl: "https://events.example.ch/",
    language: "fr",
    category: "concerts",
    genres: ["club music", "latincore", "techno", "trance"],
    priceMin: 10,
    priceMax: 15,
    currency: "CHF",
    ticketUrl: null,
    imageUrl: "https://events.example.ch/media/808rave.png",
    isFree: false,
    sourceUrl: "https://events.example.ch/evenement/808rave/",
    extractionMethod: "html",
  });
});

test("direct HTML extraction requires a complete event date", () => {
  assert.deepEqual(
    extractHtmlEventCandidates(
      `<article><h1>Navigation card</h1><strong>Date</strong>: vendredi 17 juillet</article>`,
      "https://events.example.ch/agenda",
      SOURCE,
    ),
    [],
  );
});

test("private source hosts are blocked before the network request", async () => {
  let requested = false;
  const localSource = { ...SOURCE, domain: "127.0.0.1" };
  await assert.rejects(
    scrapeDirectEventSource(
      { url: "http://127.0.0.1/events", source: localSource },
      {
        fetcher: async () => {
          requested = true;
          return htmlResponse("<html></html>", "http://127.0.0.1/events");
        },
      },
    ),
    /direct_private_host_blocked/,
  );
  assert.equal(requested, false);
});

test("off-domain redirects and oversized responses are rejected", async () => {
  await assert.rejects(
    scrapeDirectEventSource(
      { url: "https://events.example.ch/agenda", source: SOURCE },
      {
        fetcher: async () => htmlResponse("<html></html>", "https://evil.invalid/redirect"),
      },
    ),
    /direct_off_domain_url/,
  );

  await assert.rejects(
    scrapeDirectEventSource(
      { url: "https://events.example.ch/agenda", source: SOURCE },
      {
        rootMaxBytes: 10,
        fetcher: async () =>
          htmlResponse(
            "<html><body>far too large</body></html>",
            "https://events.example.ch/agenda",
          ),
      },
    ),
    /direct_response_too_large/,
  );
});
