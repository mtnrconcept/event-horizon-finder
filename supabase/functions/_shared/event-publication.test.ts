import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicEventSummary, publicScrapedImageUrl } from "./event-publication.ts";

test("buildPublicEventSummary uses facts without copying source prose", () => {
  const summary = buildPublicEventSummary({
    title: "Porte-ouverte et enquêtes au musée",
    category: "Exposition",
    venueName: "Musée archéologique d’Izernore",
    city: "Izernore",
    language: "fr",
  });

  assert.equal(
    summary,
    "« Porte-ouverte et enquêtes au musée » est un événement de type Exposition proposé à Musée archéologique d’Izernore, Izernore. Retrouvez ici les dates, horaires, tarifs et modalités de réservation disponibles.",
  );
  assert.equal(summary.includes("objets gallo-romains"), false);
  assert.equal(summary.includes("livret-jeux"), false);
});

test("scraped images are quarantined until licensed", () => {
  assert.equal(publicScrapedImageUrl(), null);
});
