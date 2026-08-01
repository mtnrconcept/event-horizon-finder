import { readFile, writeFile } from "node:fs/promises";

const edgePath = new URL("../supabase/functions/global-place-discovery/index.ts", import.meta.url);
let source = await readFile(edgePath, "utf8");

function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`Expected ${label} fragment was not found`);
  source = source.replace(before, after);
}

if (!source.includes('from "./enrichment.ts"')) {
  replaceOnce(
    'import { createClient } from "npm:@supabase/supabase-js@2.110.2";',
    'import { createClient } from "npm:@supabase/supabase-js@2.110.2";\nimport { enrichPlacesFromPublicSources } from "./enrichment.ts";',
    "place enrichment import",
  );
}

if (!source.includes("booking_url:")) {
  replaceOnce(
    '    image_url: first(tags, "image"),\n    opening_hours: first(tags, "opening_hours"),',
    '    image_url: first(tags, "image", "wikimedia_commons"),\n    image_urls: [first(tags, "image", "wikimedia_commons")].filter(Boolean),\n    booking_url: first(tags, "booking", "reservation", "tickets", "contact:booking", "contact:reservation"),\n    source_urls: [\n      `https://www.openstreetmap.org/${element.type}/${element.id}`,\n      first(tags, "website", "contact:website"),\n      first(tags, "wikipedia"),\n      first(tags, "wikidata"),\n    ].filter(Boolean),\n    content_sources: [\n      {\n        label: "OpenStreetMap",\n        url: `https://www.openstreetmap.org/${element.type}/${element.id}`,\n        provider: "openstreetmap",\n      },\n    ],\n    opening_hours: first(tags, "opening_hours"),',
    "normalized place booking and media fields",
  );
}

if (!source.includes("enrichPlacesFromPublicSources(normalizedPlaces")) {
  replaceOnce(
    '  const places = allElements\n    .map((element) => normalizeElement(element, city))',
    '  const normalizedPlaces = allElements\n    .map((element) => normalizeElement(element, city))',
    "normalized place collection",
  );
  replaceOnce(
    '    .slice(0, MAX_PLACES_PER_CITY);\n\n  return { places, completedGroups, failedGroups };',
    '    .slice(0, MAX_PLACES_PER_CITY);\n\n  const places = await enrichPlacesFromPublicSources(\n    normalizedPlaces,\n    city,\n    startedAt,\n    CITY_EXECUTION_BUDGET_MS,\n  );\n\n  return { places, completedGroups, failedGroups };',
    "place source enrichment call",
  );
}

await writeFile(edgePath, source);
