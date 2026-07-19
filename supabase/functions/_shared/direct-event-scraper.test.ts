import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverDirectEventLinks,
  discoverDirectSourceLinks,
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

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

test("direct mode always follows JSON-LD detail pages even with several root candidates", async () => {
  const root = `
    <script type="application/ld+json">{
      "@graph":[
        {
          "@type":"MusicEvent",
          "@id":"root-show",
          "name":"Root Show",
          "startDate":"2026-08-20T20:00:00+02:00",
          "url":"/events/root-show"
        },
        {
          "@type":"Event",
          "@id":"second-show",
          "name":"Second Show",
          "startDate":"2026-08-21T21:30:00+02:00",
          "url":"/events/second-show"
        }
      ]
    }</script>
    <a href="/events/root-show?utm_source=list">Duplicate tracked detail</a>
    <a href="https://outside.invalid/events/invented">External</a>
    <a href="/media/poster.jpg">Poster</a>`;
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/events/root-show")) {
      return htmlResponse(
        `<script type="application/ld+json">{
          "@type":"MusicEvent","@id":"root-show","name":"Root Show",
          "description":"Description enrichie depuis la fiche.",
          "startDate":"2026-08-20T20:00:00+02:00","url":"/events/root-show"
        }</script>`,
        url,
      );
    }
    if (url.endsWith("/events/second-show")) {
      return htmlResponse(
        `<script type="application/ld+json">{
          "@type":"Event","@id":"second-show","name":"Second Show",
          "location":{"name":"Direct Hall"},
          "startDate":"2026-08-21T21:30:00+02:00","url":"/events/second-show"
        }</script>`,
        url,
      );
    }
    return htmlResponse(root, "https://events.example.ch/agenda");
  };

  const result = await scrapeDirectEventSource(
    { url: "https://events.example.ch/agenda", source: SOURCE },
    { fetcher, timeoutMs: 1_000 },
  );

  assert.equal(result.mode, "direct");
  assert.equal(result.metadata.detailPagesAttempted, 2);
  assert.equal(result.metadata.detailPagesFetched, 2);
  assert.equal(result.metadata.discoveredEventUrlCount, 2);
  assert.deepEqual(result.continuation, []);
  assert.deepEqual(
    result.candidates.map((event) => event.title),
    ["Root Show", "Second Show", "Root Show", "Second Show"],
  );
  assert.deepEqual(requests, [
    "https://events.example.ch/agenda",
    "https://events.example.ch/events/root-show",
    "https://events.example.ch/events/second-show",
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

test("link discovery recognizes opaque and non-Latin event links from their markup", () => {
  const links = discoverDirectEventLinks(
    `<a href="/12345" itemprop="url">夏祭りイベント</a>
     <a href="/календарь/событие-1">Событие</a>
     <a href="/about">About us</a>`,
    "https://events.example.ch/agenda",
    SOURCE,
  );
  assert.deepEqual(links, [
    "https://events.example.ch/12345",
    "https://events.example.ch/%D0%BA%D0%B0%D0%BB%D0%B5%D0%BD%D0%B4%D0%B0%D1%80%D1%8C/%D1%81%D0%BE%D0%B1%D1%8B%D1%82%D0%B8%D0%B5-1",
  ]);
});

test("link discovery returns every event URL and separates same-origin pagination", () => {
  const eventLinks = Array.from(
    { length: 27 },
    (_, index) => `<a href="/event/show-${index + 1}">Show ${index + 1}</a>`,
  ).join("\n");
  const links = discoverDirectSourceLinks(
    `${eventLinks}
     <a rel="next" href="/agenda?page=2">Suivant</a>
     <a rel="next" href="https://calendar.events.example.ch/agenda?page=2">External origin</a>`,
    "https://events.example.ch/agenda",
    SOURCE,
  );

  assert.equal(links.eventUrls.length, 27);
  assert.equal(links.eventUrls.at(-1), "https://events.example.ch/event/show-27");
  assert.deepEqual(links.paginationUrls, ["https://events.example.ch/agenda?page=2"]);
});

test("exact-host discovery never leaks www, apex or subdomain links into continuations", async () => {
  const exactSource = {
    ...SOURCE,
    domain: "www.events.example.ch",
    metadata: { ...SOURCE.metadata, direct_exact_host: true },
  };
  const result = await scrapeDirectEventSource(
    { url: "https://www.events.example.ch/agenda", source: exactSource },
    {
      pageFetchBudget: 0,
      fetcher: async (input) =>
        htmlResponse(
          `<a href="/event/same-host">Same host</a>
           <a href="https://events.example.ch/event/apex">Apex</a>
           <a href="https://calendar.www.events.example.ch/event/subdomain">Subdomain</a>`,
          String(input),
        ),
    },
  );

  assert.deepEqual(result.continuation, [
    { url: "https://www.events.example.ch/event/same-host", kind: "event" },
  ]);
  assert.equal(result.metadata.discoveredEventUrlCount, 1);
});

test("the explicit fetch budget returns every unprocessed URL as a continuation", async () => {
  const root = Array.from(
    { length: 12 },
    (_, index) => `<a href="/event/show-${index + 1}">Show ${index + 1}</a>`,
  ).join("\n");
  const requests: string[] = [];
  const result = await scrapeDirectEventSource(
    { url: "https://events.example.ch/agenda", source: SOURCE },
    {
      pageFetchBudget: 2,
      fetcher: async (input) => {
        const url = String(input);
        requests.push(url);
        return htmlResponse(
          url.endsWith("/agenda") ? root : "<html><body>Event detail</body></html>",
          url,
        );
      },
    },
  );

  assert.equal(result.metadata.pageFetchBudget, 2);
  assert.equal(result.metadata.pagesAttempted, 2);
  assert.equal(result.metadata.discoveredEventUrlCount, 12);
  assert.equal(result.metadata.continuationUrlCount, 10);
  assert.equal(result.metadata.budgetExhausted, true);
  assert.deepEqual(requests, [
    "https://events.example.ch/agenda",
    "https://events.example.ch/event/show-1",
    "https://events.example.ch/event/show-2",
  ]);
  assert.deepEqual(
    result.continuation,
    Array.from({ length: 10 }, (_, index) => ({
      url: `https://events.example.ch/event/show-${index + 3}`,
      kind: "event" as const,
    })),
  );
  assert.deepEqual(
    result.continuationUrls,
    result.continuation.map((entry) => entry.url),
  );
});

test("a failed detail fetch remains a durable continuation", async () => {
  const result = await scrapeDirectEventSource(
    { url: "https://events.example.ch/agenda", source: SOURCE },
    {
      pageFetchBudget: 1,
      fetcher: async (input) => {
        const url = String(input);
        if (url.endsWith("/agenda")) {
          return htmlResponse(`<a href="/event/one">One</a><a href="/event/two">Two</a>`, url);
        }
        throw new TypeError("temporary network error");
      },
    },
  );

  assert.equal(result.metadata.pagesAttempted, 1);
  assert.equal(result.metadata.pagesFetched, 0);
  assert.equal(result.metadata.detailPageErrors.length, 1);
  assert.deepEqual(result.continuation, [
    { url: "https://events.example.ch/event/one", kind: "event" },
    { url: "https://events.example.ch/event/two", kind: "event" },
  ]);
});

test("same-origin pagination is crawled within budget and discovers later event pages", async () => {
  const requests: string[] = [];
  const pages = new Map<string, string>([
    [
      "https://events.example.ch/agenda",
      `<a href="/event/one">One</a><a rel="next" href="/agenda?page=2">Next</a>`,
    ],
    [
      "https://events.example.ch/agenda?page=2",
      `<a href="/event/two">Two</a><a rel="next" href="/agenda?page=3">Next</a>`,
    ],
    ["https://events.example.ch/agenda?page=3", `<a href="/event/three">Three</a>`],
  ]);
  for (const [slug, title, date] of [
    ["one", "One", "2026-08-20T20:00:00+02:00"],
    ["two", "Two", "2026-08-21T20:00:00+02:00"],
    ["three", "Three", "2026-08-22T20:00:00+02:00"],
  ]) {
    pages.set(
      `https://events.example.ch/event/${slug}`,
      `<script type="application/ld+json">{
        "@type":"Event","name":"${title}","startDate":"${date}","url":"/event/${slug}"
      }</script>`,
    );
  }

  const result = await scrapeDirectEventSource(
    { url: "https://events.example.ch/agenda", source: SOURCE },
    {
      pageFetchBudget: 5,
      fetcher: async (input) => {
        const url = String(input);
        requests.push(url);
        return htmlResponse(pages.get(url) ?? "<html></html>", url);
      },
    },
  );

  assert.equal(result.metadata.detailPagesFetched, 3);
  assert.equal(result.metadata.paginationPagesFetched, 2);
  assert.equal(result.metadata.discoveredEventUrlCount, 3);
  assert.equal(result.metadata.discoveredPaginationUrlCount, 2);
  assert.deepEqual(result.continuation, []);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.title),
    ["One", "Two", "Three"],
  );
  assert.equal(requests.length, 6);
});

test("detail fetch concurrency stays bounded", async () => {
  const root = Array.from(
    { length: 8 },
    (_, index) => `<a href="/event/show-${index + 1}">Show ${index + 1}</a>`,
  ).join("\n");
  let active = 0;
  let maximumActive = 0;
  const result = await scrapeDirectEventSource(
    { url: "https://events.example.ch/agenda", source: SOURCE },
    {
      pageFetchBudget: 8,
      fetcher: async (input) => {
        const url = String(input);
        if (url.endsWith("/agenda")) return htmlResponse(root, url);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return htmlResponse("<html><body>Detail</body></html>", url);
      },
    },
  );

  assert.equal(result.metadata.pagesFetched, 8);
  assert.equal(maximumActive, 3);
  assert.deepEqual(result.continuation, []);
});

test("an unsafe page budget is rejected before fetching", async () => {
  let requested = false;
  await assert.rejects(
    scrapeDirectEventSource(
      { url: "https://events.example.ch/agenda", source: SOURCE },
      {
        pageFetchBudget: 101,
        fetcher: async () => {
          requested = true;
          return htmlResponse("<html></html>", "https://events.example.ch/agenda");
        },
      },
    ),
    /direct_page_fetch_budget_exceeds_max:100/,
  );
  assert.equal(requested, false);
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
    venueName: null,
    city: "Genève",
    countryCode: "CH",
    organizerName: null,
    organizerUrl: null,
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
        fetcher: async () => redirectResponse("https://evil.invalid/redirect"),
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

test("same-domain redirects are followed manually and private IPv6 is blocked", async () => {
  const requests: string[] = [];
  const result = await scrapeDirectEventSource(
    { url: "https://events.example.ch/old-agenda", source: SOURCE },
    {
      fetcher: async (input) => {
        requests.push(String(input));
        if (requests.length === 1) return redirectResponse("/agenda");
        return htmlResponse(
          `<script type="application/ld+json">{
            "@type":"Event","name":"Redirected event",
            "startDate":"2026-08-20T20:00:00+02:00","url":"/event/redirected"
          }</script>`,
          "https://events.example.ch/agenda",
        );
      },
    },
  );
  assert.equal(result.candidates[0]?.title, "Redirected event");
  assert.deepEqual(requests, [
    "https://events.example.ch/old-agenda",
    "https://events.example.ch/agenda",
    "https://events.example.ch/event/redirected",
  ]);

  const localIpv6Source = { ...SOURCE, domain: "[::1]" };
  await assert.rejects(
    scrapeDirectEventSource(
      { url: "http://[::1]/events", source: localIpv6Source },
      { fetcher: async () => htmlResponse("<html></html>", "http://[::1]/events") },
    ),
    /direct_private_host_blocked/,
  );
});
