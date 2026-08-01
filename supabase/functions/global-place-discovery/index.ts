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
type QueryGroup = {
  key: string;
  selectors: string[];
};
type GroupResult = {
  key: string;
  endpoint: string;
  elements: OverpassElement[];
};

const DEFAULT_OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
] as const;
const USER_AGENT =
  "GlobalParty-Place-Discovery/2.0 (+https://github.com/mtnrconcept/event-horizon-finder)";
const REQUEST_TIMEOUT_MS = 26_000;
const CITY_EXECUTION_BUDGET_MS = 92_000;
const MAX_RESPONSE_BYTES = 8_000_000;
const MAX_PLACES_PER_CITY = 2_500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const QUERY_GROUPS: QueryGroup[] = [
  {
    key: "landmarks",
    selectors: [
      '["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park|artwork|information)$"]',
      '["historic"]',
      '["man_made"~"^(tower|lighthouse|observatory|water_tower)$"]',
      '["amenity"="place_of_worship"]',
    ],
  },
  {
    key: "leisure",
    selectors: [
      '["leisure"~"^(park|garden|nature_reserve|water_park|marina|sports_centre|stadium|pitch|playground|skate_park)$"]',
      '["amenity"~"^(arts_centre|theatre|cinema|library|marketplace|community_centre)$"]',
    ],
  },
  {
    key: "nature",
    selectors: [
      '["natural"~"^(cave_entrance|waterfall|peak|beach|spring|cliff)$"]',
      '["waterway"="waterfall"]',
    ],
  },
];

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
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
    : fallback;
}

function parseCityIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && UUID_PATTERN.test(item)))].slice(0, 10);
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
  if (population < 250_000) return 10_000;
  if (population < 1_000_000) return 12_000;
  if (population < 5_000_000) return 15_000;
  return 18_000;
}

function buildOverpassQuery(city: CityTarget, group: QueryGroup): string {
  const around = `(around:${radiusForPopulation(city.population)},${city.latitude},${city.longitude})`;
  const statements = group.selectors.map((selector) => `nwr${selector}${around};`).join("\n");
  return `[out:json][timeout:24][maxsize:536870912];(\n${statements}\n);out center tags;`;
}

function overpassEndpoints(): string[] {
  const configured = [
    ...(Deno.env.get("OVERPASS_API_URLS") ?? "").split(","),
    Deno.env.get("OVERPASS_API_URL") ?? "",
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  const candidates = configured.length ? configured : [...DEFAULT_OVERPASS_URLS];
  const valid: string[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:") continue;
      parsed.hash = "";
      if (!valid.includes(parsed.toString())) valid.push(parsed.toString());
    } catch {
      // Ignore malformed optional endpoints.
    }
  }
  return valid.length ? valid : [...DEFAULT_OVERPASS_URLS];
}

function first(tags: Record<string, string>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = tags[key]?.trim();
    if (value) return value;
  }
  return null;
}

function categoryFor(tags: Record<string, string>): { category: string; subcategory: string | null } {
  if (tags.leisure === "skate_park") {
    return { category: "sports-outdoors", subcategory: "skate-park" };
  }
  if (["park", "garden", "nature_reserve"].includes(tags.leisure)) {
    return { category: "nature", subcategory: tags.leisure };
  }
  if (tags.natural || tags.waterway === "waterfall") {
    return { category: "nature", subcategory: tags.natural ?? tags.waterway };
  }
  if (["museum", "gallery"].includes(tags.tourism)) {
    return { category: "culture", subcategory: tags.tourism };
  }
  if (tags.historic) {
    return { category: "culture", subcategory: `historic-${tags.historic}` };
  }
  if (["theatre", "cinema", "arts_centre", "library"].includes(tags.amenity)) {
    return { category: "culture", subcategory: tags.amenity };
  }
  if (["zoo", "aquarium", "theme_park"].includes(tags.tourism)) {
    return { category: "family", subcategory: tags.tourism };
  }
  if (["playground", "water_park"].includes(tags.leisure)) {
    return { category: "family", subcategory: tags.leisure };
  }
  if (["sports_centre", "stadium", "pitch"].includes(tags.leisure)) {
    return { category: "sports-outdoors", subcategory: tags.leisure };
  }
  if (tags.amenity === "marketplace") {
    return { category: "food-drink", subcategory: "market" };
  }
  if (tags.amenity === "place_of_worship") {
    return { category: "culture", subcategory: "religious-site" };
  }
  return { category: "attraction", subcategory: tags.tourism ?? tags.man_made ?? null };
}

function qualityScore(tags: Record<string, string>): number {
  let score = 55;
  if (first(tags, "website", "contact:website", "wikipedia", "wikidata")) score += 15;
  if (tags.opening_hours) score += 10;
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
  if (
    !name ||
    !element.type ||
    !Number.isFinite(element.id) ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }

  const addressParts = [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:postcode"],
    tags["addr:city"],
  ]
    .filter(Boolean)
    .join(" ");
  const address = first(tags, "addr:full") ?? (addressParts || null);
  const classification = categoryFor(tags);

  return {
    source_type: element.type,
    source_id: element.id,
    source_url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
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
    quality_score: qualityScore(tags),
    tags: { ...tags, discovery_city: city.city_name, country_code: city.country_code },
  };
}

async function responseJsonLimited(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error("overpass_response_too_large");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("overpass_response_too_large");
  }
  return JSON.parse(text);
}

function endpointStartIndex(cityId: string, groupIndex: number, endpointCount: number): number {
  let hash = groupIndex;
  for (const character of cityId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return endpointCount ? hash % endpointCount : 0;
}

async function fetchGroup(
  city: CityTarget,
  group: QueryGroup,
  groupIndex: number,
  startedAt: number,
): Promise<GroupResult> {
  const endpoints = overpassEndpoints();
  const startIndex = endpointStartIndex(city.city_id, groupIndex, endpoints.length);
  const errors: string[] = [];

  for (let attempt = 0; attempt < endpoints.length; attempt += 1) {
    const remaining = CITY_EXECUTION_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < 6_000) break;
    const endpoint = endpoints[(startIndex + attempt) % endpoints.length];
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(5_000, Math.min(REQUEST_TIMEOUT_MS, remaining - 1_000)),
    );
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
        body: new URLSearchParams({ data: buildOverpassQuery(city, group) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        errors.push(`${new URL(endpoint).hostname}:${response.status}`);
        if ([408, 425, 429, 500, 502, 503, 504].includes(response.status)) continue;
        throw new Error(`overpass_http_${response.status}`);
      }
      const payload = (await responseJsonLimited(response)) as { elements?: OverpassElement[] };
      return { key: group.key, endpoint, elements: payload.elements ?? [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${new URL(endpoint).hostname}:${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`overpass_${group.key}_failed:${errors.join("|").slice(0, 400)}`);
}

async function fetchPlaces(city: CityTarget): Promise<{
  places: JsonObject[];
  completedGroups: string[];
  failedGroups: Array<{ key: string; error: string }>;
}> {
  const startedAt = Date.now();
  const completedGroups: string[] = [];
  const failedGroups: Array<{ key: string; error: string }> = [];
  const allElements: OverpassElement[] = [];

  for (let index = 0; index < QUERY_GROUPS.length; index += 1) {
    const group = QUERY_GROUPS[index];
    try {
      const result = await fetchGroup(city, group, index, startedAt);
      completedGroups.push(result.key);
      allElements.push(...result.elements);
    } catch (error) {
      failedGroups.push({
        key: group.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!completedGroups.length) {
    throw new Error(
      `overpass_all_groups_failed:${failedGroups.map((item) => item.error).join(";").slice(0, 900)}`,
    );
  }

  const seen = new Set<string>();
  const places = allElements
    .map((element) => normalizeElement(element, city))
    .filter((place): place is JsonObject => {
      if (!place) return false;
      const key = `${place.source_type}:${place.source_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => Number(right.quality_score ?? 0) - Number(left.quality_score ?? 0))
    .slice(0, MAX_PLACES_PER_CITY);

  return { places, completedGroups, failedGroups };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const secret = Deno.env.get("GLOBAL_SCRAPER_SECRET")?.trim();
  const provided = req.headers.get("x-global-scraper-secret")?.trim();
  if (!secret || secret.length < 32 || provided !== secret) return json({ error: "unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ??
    Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (!supabaseUrl || !serviceKey) return json({ error: "server_not_configured" }, 500);
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: JsonObject = {};
  try {
    body = (await req.json()) as JsonObject;
  } catch {
    body = {};
  }
  const cityIds = parseCityIds(body.city_ids);
  const limit = boundedInteger(body.limit, cityIds.length || 1, 1, 10);
  const { data: cities, error: claimError } = await admin.rpc(
    "claim_cities_for_place_discovery_v2",
    {
      _limit: limit,
      _city_ids: cityIds.length ? cityIds : null,
    },
  );
  if (claimError) return json({ error: "city_claim_failed", detail: claimError.message }, 500);

  const results: JsonObject[] = [];
  for (const city of (cities ?? []) as CityTarget[]) {
    try {
      const discovery = await fetchPlaces(city);
      const { data: persisted, error } = await admin.rpc("upsert_places_of_interest", {
        _city_id: city.city_id,
        _country_id: city.country_id,
        _places: discovery.places,
      });
      if (error) throw error;

      const partial = discovery.failedGroups.length > 0;
      if (partial) {
        await admin.rpc("mark_place_discovery_failure", {
          _city_id: city.city_id,
          _error: discovery.failedGroups.map((item) => `${item.key}:${item.error}`).join(" | "),
          _retry_after_seconds: 21_600,
        });
      } else {
        await admin.rpc("mark_place_discovery_success", { _city_id: city.city_id });
      }

      results.push({
        cityId: city.city_id,
        city: city.city_name,
        discovered: discovery.places.length,
        persisted: Number(persisted ?? 0),
        completedGroups: discovery.completedGroups,
        failedGroups: discovery.failedGroups,
        partial,
        ok: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await admin.rpc("mark_place_discovery_failure", {
        _city_id: city.city_id,
        _error: message,
        _retry_after_seconds: 3_600,
      });
      results.push({ cityId: city.city_id, city: city.city_name, ok: false, error: message });
    }
  }

  return json({
    ok: true,
    claimed: results.length,
    completed: results.filter((item) => item.ok).length,
    results,
  });
});
