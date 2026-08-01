import { createClient } from "npm:@supabase/supabase-js@2.110.2";

type JsonObject = Record<string, unknown>;
type CityTarget = {
  city_id: string;
  city_name: string;
  country_id: string | null;
  country_code: string | null;
  latitude: number;
  longitude: number;
  population: number | null;
};

type OverpassElement = {
  type?: "node" | "way" | "relation";
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
};

const USER_AGENT = "GlobalParty-Place-Discovery/1.0 (+https://github.com/mtnrconcept/event-horizon-finder)";
const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 12_000_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.trunc(parsed))) : fallback;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function radiusForPopulation(population: number | null): number {
  if (!population || population < 50_000) return 8_000;
  if (population < 250_000) return 12_000;
  if (population < 1_000_000) return 18_000;
  if (population < 5_000_000) return 28_000;
  return 40_000;
}

function buildOverpassQuery(city: CityTarget): string {
  const radius = radiusForPopulation(city.population);
  const around = `(around:${radius},${city.latitude},${city.longitude})`;
  return `[out:json][timeout:40];(
    nwr["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park|artwork|information)$"]${around};
    nwr["historic"]${around};
    nwr["leisure"~"^(park|garden|nature_reserve|water_park|marina|sports_centre|stadium|pitch|playground|skate_park)$"]${around};
    nwr["natural"~"^(cave_entrance|waterfall|peak|beach|spring|cliff)$"]${around};
    nwr["amenity"~"^(arts_centre|theatre|cinema|library|marketplace|community_centre)$"]${around};
    nwr["man_made"~"^(tower|lighthouse|observatory|water_tower)$"]${around};
    nwr["place_of_worship"]${around};
  );out center tags;`;
}

function categoryFor(tags: Record<string, string>): { category: string; subcategory: string | null } {
  if (tags.leisure === "skate_park") return { category: "sports-outdoors", subcategory: "skate-park" };
  if (tags.leisure === "park" || tags.leisure === "garden") return { category: "nature", subcategory: tags.leisure };
  if (tags.leisure === "nature_reserve" || tags.natural) return { category: "nature", subcategory: tags.leisure ?? tags.natural };
  if (tags.tourism === "museum" || tags.tourism === "gallery") return { category: "culture", subcategory: tags.tourism };
  if (tags.historic) return { category: "culture", subcategory: `historic-${tags.historic}` };
  if (tags.amenity === "theatre" || tags.amenity === "cinema" || tags.amenity === "arts_centre") {
    return { category: "culture", subcategory: tags.amenity };
  }
  if (tags.tourism === "zoo" || tags.tourism === "aquarium" || tags.tourism === "theme_park") {
    return { category: "family", subcategory: tags.tourism };
  }
  if (tags.leisure === "playground" || tags.leisure === "water_park") return { category: "family", subcategory: tags.leisure };
  if (tags.leisure === "sports_centre" || tags.leisure === "stadium" || tags.leisure === "pitch") {
    return { category: "sports-outdoors", subcategory: tags.leisure };
  }
  if (tags.amenity === "marketplace") return { category: "food-drink", subcategory: "market" };
  if (tags.amenity === "place_of_worship" || tags.place_of_worship) return { category: "culture", subcategory: "religious-site" };
  return { category: "attraction", subcategory: tags.tourism ?? tags.man_made ?? null };
}

function first(tags: Record<string, string>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = tags[key]?.trim();
    if (value) return value;
  }
  return null;
}

function qualityScore(tags: Record<string, string>, name: string): number {
  let score = 35;
  if (name) score += 20;
  if (first(tags, "website", "contact:website", "wikipedia", "wikidata")) score += 15;
  if (first(tags, "opening_hours")) score += 10;
  if (first(tags, "description", "description:fr", "description:en")) score += 8;
  if (first(tags, "image", "wikimedia_commons")) score += 7;
  if (first(tags, "addr:street", "addr:full")) score += 5;
  return Math.min(100, score);
}

function normalizeElement(element: OverpassElement, city: CityTarget): JsonObject | null {
  const tags = element.tags ?? {};
  const name = first(tags, "name", "name:fr", "name:en", "official_name");
  const latitude = element.lat ?? element.center?.lat;
  const longitude = element.lon ?? element.center?.lon;
  if (!name || !element.type || !Number.isFinite(element.id) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const classification = categoryFor(tags);
  const address = first(tags, "addr:full") ?? [tags["addr:housenumber"], tags["addr:street"], tags["addr:postcode"], tags["addr:city"]].filter(Boolean).join(" ") || null;
  const sourceUrl = `https://www.openstreetmap.org/${element.type}/${element.id}`;
  return {
    source_type: element.type,
    source_id: element.id,
    source_url: sourceUrl,
    name,
    slug: `${slugify(name)}-${element.type}-${element.id}`,
    category: classification.category,
    subcategory: classification.subcategory,
    description: first(tags, "description:fr", "description", "description:en"),
    address,
    website: first(tags, "website", "contact:website"),
    phone: first(tags, "phone", "contact:phone"),
    image_url: first(tags, "image"),
    opening_hours: first(tags, "opening_hours"),
    fee: first(tags, "fee"),
    wheelchair: first(tags, "wheelchair"),
    latitude,
    longitude,
    quality_score: qualityScore(tags, name),
    tags: { ...tags, discovery_city: city.city_name, country_code: city.country_code },
  };
}

async function responseJsonLimited(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_RESPONSE_BYTES) throw new Error("overpass_response_too_large");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("overpass_response_too_large");
  return JSON.parse(text);
}

async function fetchPlaces(city: CityTarget): Promise<JsonObject[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const endpoint = Deno.env.get("OVERPASS_API_URL")?.trim() || DEFAULT_OVERPASS_URL;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams({ data: buildOverpassQuery(city) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`overpass_http_${response.status}`);
    const payload = (await responseJsonLimited(response)) as { elements?: OverpassElement[] };
    const seen = new Set<string>();
    return (payload.elements ?? [])
      .map((element) => normalizeElement(element, city))
      .filter((place): place is JsonObject => {
        if (!place) return false;
        const key = `${place.source_type}:${place.source_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Number(b.quality_score ?? 0) - Number(a.quality_score ?? 0))
      .slice(0, 2_500);
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const secret = Deno.env.get("GLOBAL_SCRAPER_SECRET")?.trim();
  const provided = req.headers.get("x-global-scraper-secret")?.trim();
  if (!secret || secret.length < 32 || provided !== secret) return json({ error: "unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (!supabaseUrl || !serviceKey) return json({ error: "server_not_configured" }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: JsonObject = {};
  try { body = (await req.json()) as JsonObject; } catch { body = {}; }
  const limit = boundedInteger(body.limit, 3, 1, 10);
  const { data: cities, error: claimError } = await admin.rpc("claim_cities_for_place_discovery", { _limit: limit });
  if (claimError) return json({ error: "city_claim_failed", detail: claimError.message }, 500);

  const results: JsonObject[] = [];
  for (const city of (cities ?? []) as CityTarget[]) {
    try {
      const places = await fetchPlaces(city);
      const { data: persisted, error } = await admin.rpc("upsert_places_of_interest", {
        _city_id: city.city_id,
        _country_id: city.country_id,
        _places: places,
      });
      if (error) throw error;
      results.push({ cityId: city.city_id, city: city.city_name, discovered: places.length, persisted: Number(persisted ?? 0), ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await admin.from("cities").update({ places_discovery_error: message.slice(0, 500) }).eq("id", city.city_id);
      results.push({ cityId: city.city_id, city: city.city_name, ok: false, error: message });
    }
  }

  return json({ ok: true, claimed: results.length, completed: results.filter((item) => item.ok).length, results });
});
