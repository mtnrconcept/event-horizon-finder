import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverLadecadanseLinks,
  findLicensedCommonsVenueMedia,
  parseLadecadanseEventPage,
  parseLadecadanseVenuePage,
} from "./ladecadanse-adapter.ts";
import type { EventSourceContext } from "./event-precision.ts";

const source: EventSourceContext = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "La Décadanse Genève",
  domain: "www.ladecadanse.ch",
  category_slug: null,
  metadata: { adapter: "ladecadanse-v1" },
  city: {
    name: "Genève",
    timezone: "Europe/Zurich",
    latitude: 46.2044,
    longitude: 6.1432,
    country: { code: "CH" },
  },
};

test("agenda and directory discovery keeps every exact-host event and venue link", () => {
  const html = `
    <a href="/event/evenement.php?idE=1001">Concert test</a>
    <a href="https://www.ladecadanse.ch/event/evenement.php?idE=1002&utm_source=x">Soirée test</a>
    <a href="/lieu/lieu.php?idL=88">Salle test</a>
    <a href="/lieu/lieux.php?page=2">Page suivante</a>
    <a href="https://example.org/event/evenement.php?idE=999">Hors domaine</a>
  `;
  const links = discoverLadecadanseLinks(html, "https://www.ladecadanse.ch/");
  assert.deepEqual(
    links.map((link) => [link.kind, link.externalIdentifier]),
    [
      ["event", "1001"],
      ["event", "1002"],
      ["venue", "88"],
      ["venue_catalog", null],
    ],
  );
  assert.ok(links.every((link) => new URL(link.url).hostname === "www.ladecadanse.ch"));
});

test("venue pages preserve address, presentation, media, official website and event links", () => {
  const html = `
    <html><head><meta property="og:image" content="/media/salle-test.jpg"></head><body>
      <h1>Salle test</h1>
      <ul>
        <li>Théâtre, salle de concert</li>
        <li>12 rue des Tests, 1205 Genève</li>
        <li><a href="https://www.openstreetmap.org/?mlat=46.199&mlon=6.145">Voir sur le plan</a></li>
        <li><a href="https://salle-test.example.org">Site officiel</a></li>
      </ul>
      <h2>Le lieu se présente</h2>
      <p>Une scène culturelle indépendante avec une programmation quotidienne.</p>
      <h2>Événements</h2>
      <a href="/event/evenement.php?idE=2001">Premier spectacle</a>
      <a href="/event/evenement.php?idE=2002">Deuxième spectacle</a>
    </body></html>
  `;
  const venue = parseLadecadanseVenuePage(html, "https://www.ladecadanse.ch/lieu/lieu.php?idL=321");
  assert.ok(venue);
  assert.equal(venue.externalIdentifier, "321");
  assert.equal(venue.name, "Salle test");
  assert.equal(venue.address, "12 rue des Tests, 1205 Genève");
  assert.equal(venue.postalCode, "1205");
  assert.equal(venue.latitude, 46.199);
  assert.equal(venue.longitude, 6.145);
  assert.equal(venue.website, "https://salle-test.example.org/");
  assert.match(venue.description ?? "", /scène culturelle indépendante/i);
  assert.equal(venue.media[0]?.url, "https://www.ladecadanse.ch/media/salle-test.jpg");
  assert.deepEqual(
    venue.eventLinks.filter((link) => link.kind === "event").map((link) => link.externalIdentifier),
    ["2001", "2002"],
  );
});

test("event pages keep precise overnight times, venue identity, address, price and image", () => {
  const html = `
    <html><head><meta property="og:image" content="/media/night-test.jpg"></head><body>
      <div>Fêtes</div>
      <h1>Nuit de test</h1>
      <ul>
        <li>vendredi 7 août 2026</li>
        <li>23h30 à 05h00</li>
        <li><a href="/lieu/lieu.php?idL=321">Salle test</a></li>
        <li>12 rue des Tests, 1205 Genève</li>
        <li><a href="https://www.openstreetmap.org/?mlat=46.199&mlon=6.145">Voir sur le plan</a></li>
      </ul>
      <p>Une nuit entière de musique et de rencontres.</p>
      <p>Entrée 25 CHF</p>
      <a href="https://tickets.example.org/night-test">Réserver des billets</a>
    </body></html>
  `;
  const parsed = parseLadecadanseEventPage(
    html,
    "https://www.ladecadanse.ch/event/evenement.php?idE=4001",
    source,
  );
  assert.ok(parsed);
  assert.equal(parsed.externalIdentifier, "4001");
  assert.equal(parsed.venueExternalIdentifier, "321");
  assert.equal(parsed.candidate.venueName, "Salle test");
  assert.equal(parsed.candidate.address, "12 rue des Tests, 1205 Genève");
  assert.equal(parsed.candidate.startDate, "2026-08-07T23:30:00");
  assert.equal(parsed.candidate.endDate, "2026-08-08T05:00:00");
  assert.equal(parsed.candidate.priceMin, 25);
  assert.equal(parsed.candidate.priceMax, 25);
  assert.equal(parsed.candidate.currency, "CHF");
  assert.equal(parsed.candidate.imageUrl, "https://www.ladecadanse.ch/media/night-test.jpg");
  assert.equal(parsed.candidate.ticketUrl, "https://tickets.example.org/night-test");
  assert.match(parsed.candidate.description ?? "", /nuit entière de musique/i);
});

test("Commons fallback accepts only explicitly reusable image licenses", async () => {
  const fetcher = async () =>
    new Response(
      JSON.stringify({
        query: {
          pages: {
            "1": {
              title: "File:Salle test.jpg",
              imageinfo: [
                {
                  url: "https://upload.wikimedia.org/salle-test.jpg",
                  descriptionurl: "https://commons.wikimedia.org/wiki/File:Salle_test.jpg",
                  mime: "image/jpeg",
                  extmetadata: {
                    LicenseShortName: { value: "CC BY-SA 4.0" },
                    Artist: { value: "Photographe test" },
                  },
                },
              ],
            },
            "2": {
              title: "File:Restricted.jpg",
              imageinfo: [
                {
                  url: "https://upload.wikimedia.org/restricted.jpg",
                  descriptionurl: "https://commons.wikimedia.org/wiki/File:Restricted.jpg",
                  mime: "image/jpeg",
                  extmetadata: {
                    LicenseShortName: { value: "All rights reserved" },
                    Artist: { value: "Auteur privé" },
                  },
                },
              ],
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const media = await findLicensedCommonsVenueMedia(
    "Salle test",
    "Genève",
    fetcher as typeof fetch,
  );
  assert.equal(media.length, 1);
  assert.equal(media[0].license, "CC BY-SA 4.0");
  assert.equal(media[0].attribution, "Photographe test");
  assert.equal(media[0].provider, "wikimedia_commons");
});
