import assert from "node:assert/strict";
import test from "node:test";
import type { EventSourceContext } from "../_shared/event-precision.ts";
import {
  discoverLaDecadanseLinks,
  parseLaDecadanseDocument,
  parseLaDecadanseEventPage,
  parseLaDecadanseVenuePage,
} from "./parser.ts";

const source: EventSourceContext = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "La Décadanse Genève",
  domain: "www.ladecadanse.ch",
  category_slug: null,
  metadata: { locale: "fr" },
  city: {
    name: "Genève",
    timezone: "Europe/Zurich",
    latitude: 46.2044,
    longitude: 6.1432,
    country: { code: "CH" },
  },
};

const eventUrl = "https://www.ladecadanse.ch/event/evenement.php?idE=12345";
const eventHtml = `
<!doctype html>
<html>
  <head>
    <meta property="og:title" content="Nuit électronique">
    <meta property="og:image" content="https://cdn.example.test/event-night.webp">
  </head>
  <body>
    <article class="vevent">
      <h1 class="summary">Nuit électronique</h1>
      <span class="dtstart" title="2026-08-08"></span>
      <span class="category">fête</span>
      <p class="description">Une longue nuit avec plusieurs artistes locaux.</p>
      <a href="/lieu/lieu.php?idL=42">Motel Campo</a>
      <li class="adr">Route des Acacias 45, 1227 Genève</li>
      <div id="evenement-map" data-lat="46.1901" data-lng="6.1324"></div>
      <div id="pratique">
        <p>23h30 - 05h00</p>
        <p>CHF 20</p>
        <a href="https://tickets.example.test/night-12345">Réserver les billets</a>
      </div>
    </article>
  </body>
</html>`;

const venueUrl = "https://www.ladecadanse.ch/lieu/lieu.php?idL=42";
const venueHtml = `
<!doctype html>
<html>
  <head><meta name="description" content="Motel Campo, salle culturelle genevoise."></head>
  <body>
    <h1 class="fn org">Motel Campo</h1>
    <div id="medias">
      <a href="https://cdn.example.test/motel-campo-front.jpg"><img src="https://cdn.example.test/motel-campo-front.jpg"></a>
      <a href="https://cdn.example.test/motel-campo-stage.webp"><img src="https://cdn.example.test/motel-campo-stage.webp"></a>
    </div>
    <div id="pratique">
      <ul>
        <li>Club, salle de concert, association</li>
        <li class="adr">Route des Acacias 45, 1227 Genève</li>
        <li>Jeudi à samedi, 18h00 - 05h00</li>
        <li class="sitelieu"><a href="https://motelcampo.example.test">motelcampo.example.test</a></li>
      </ul>
    </div>
    <div id="lieu-map" data-lat="46.1901" data-lng="6.1324"></div>
    <div id="descriptions"><p>Un espace culturel indépendant avec concerts et soirées.</p></div>
    <a href="/event/evenement.php?idE=12345">Nuit électronique</a>
    <a href="?page=2">Page suivante</a>
  </body>
</html>`;

test("La Décadanse event pages preserve venue identity, overnight time, media and booking", () => {
  const parsed = parseLaDecadanseEventPage(eventHtml, eventUrl, source);
  assert.ok(parsed.event);
  assert.equal(parsed.event.externalId, "12345");
  assert.equal(parsed.event.title, "Nuit électronique");
  assert.equal(parsed.event.startDate, "2026-08-08T23:30:00");
  assert.equal(parsed.event.endDate, "2026-08-09T05:00:00");
  assert.equal(parsed.event.venueName, "Motel Campo");
  assert.equal(parsed.event.venueUrl, venueUrl);
  assert.equal(parsed.event.address, "Route des Acacias 45, 1227 Genève");
  assert.equal(parsed.event.latitude, 46.1901);
  assert.equal(parsed.event.longitude, 6.1324);
  assert.equal(parsed.event.currency, "CHF");
  assert.equal(parsed.event.priceMin, 20);
  assert.equal(parsed.event.ticketUrl, "https://tickets.example.test/night-12345");
  assert.equal(parsed.event.imageUrl, "https://cdn.example.test/event-night.webp");
  assert.ok(parsed.venue);
  assert.equal(parsed.venue.externalId, "42");
  assert.deepEqual(parsed.venue.imageUrls, []);
});

test("La Décadanse venue pages produce canonical rich place records", () => {
  const venue = parseLaDecadanseVenuePage(venueHtml, venueUrl, source);
  assert.ok(venue);
  assert.equal(venue.externalId, "42");
  assert.equal(venue.name, "Motel Campo");
  assert.equal(venue.address, "Route des Acacias 45, 1227 Genève");
  assert.equal(venue.postalCode, "1227");
  assert.equal(venue.website, "https://motelcampo.example.test/");
  assert.equal(venue.latitude, 46.1901);
  assert.equal(venue.longitude, 6.1324);
  assert.match(venue.openingHours ?? "", /18h00 - 05h00/);
  assert.match(venue.description ?? "", /espace culturel indépendant/i);
  assert.deepEqual(venue.imageUrls, [
    "https://cdn.example.test/motel-campo-front.jpg",
    "https://cdn.example.test/motel-campo-stage.webp",
  ]);
});

test("venue pages enqueue every linked event and the dedicated venue RSS feed", () => {
  const links = discoverLaDecadanseLinks(venueHtml, venueUrl);
  assert.ok(links.some((link) => link.url === eventUrl && link.kind === "event"));
  assert.ok(
    links.some(
      (link) =>
        link.url ===
          "https://www.ladecadanse.ch/event/rss.php?type=lieu_evenements&id=42" &&
        link.kind === "rss",
    ),
  );
});

test("venue directory pagination remains inside the venue directory", () => {
  const links = discoverLaDecadanseLinks(
    '<a href="?page=2">Suivante</a><a href="/lieu/lieu.php?idL=42">Motel Campo</a>',
    "https://www.ladecadanse.ch/lieu/",
  );
  assert.ok(
    links.some(
      (link) =>
        link.url === "https://www.ladecadanse.ch/lieu/?page=2" &&
        link.kind === "venue_directory",
    ),
  );
  assert.ok(links.some((link) => link.url === venueUrl && link.kind === "venue"));
});

test("RSS item links become durable event jobs", () => {
  const rssUrl = "https://www.ladecadanse.ch/event/rss.php?type=evenements_ajoutes";
  const rss = `<?xml version="1.0"?><rss><channel><item><title>Test</title><link>${eventUrl}</link><guid>12345</guid></item></channel></rss>`;
  const parsed = parseLaDecadanseDocument(rss, rssUrl, source);
  assert.equal(parsed.events.length, 0);
  assert.ok(parsed.links.some((link) => link.url === eventUrl && link.kind === "event"));
});
