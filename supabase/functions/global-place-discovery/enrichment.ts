type JsonObject = Record<string, unknown>;
type CityTarget = { city_name: string; country_code: string | null };

type MediaWikiSearchResponse = {
  query?: { search?: Array<{ title?: string }> };
};
type MediaWikiPageResponse = {
  query?: {
    pages?: Record<string, {
      title?: string;
      extract?: string;
      fullurl?: string;
      thumbnail?: { source?: string };
      original?: { source?: string };
    }>;
  };
};

const ENRICHMENT_LIMIT = 80;
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_DESCRIPTION_LENGTH = 1_600;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function uniqueUrls(values: unknown[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value.trim());
      if (!["http:", "https:"].includes(url.protocol)) continue;
      url.hash = "";
      const normalized = url.toString();
      if (!output.includes(normalized)) output.push(normalized);
    } catch {
      // Ignore malformed optional source URLs.
    }
  }
  return output;
}

async function fetchJson(url: URL): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "GlobalParty-Place-Enrichment/1.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`source_http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function wikiLanguage(tags: JsonObject): string {
  const wikipedia = text(tags.wikipedia);
  const prefix = wikipedia?.split(":", 1)[0]?.toLowerCase();
  return prefix && /^[a-z-]{2,12}$/.test(prefix) ? prefix : "fr";
}

function wikipediaTitle(tags: JsonObject): string | null {
  const wikipedia = text(tags.wikipedia);
  if (!wikipedia) return null;
  const separator = wikipedia.indexOf(":");
  return separator >= 0 ? wikipedia.slice(separator + 1).trim() : wikipedia;
}

async function findMediaWikiPage(
  host: string,
  place: JsonObject,
  city: CityTarget,
  preferredTitle?: string | null,
): Promise<{ title: string; extract: string | null; url: string | null; images: string[] } | null> {
  const language = wikiLanguage(record(place.tags));
  const api = new URL(`https://${language}.${host}/w/api.php`);
  const title = preferredTitle ?? text(place.name);
  if (!title) return null;

  let resolvedTitle = title;
  if (!preferredTitle) {
    api.searchParams.set("action", "query");
    api.searchParams.set("list", "search");
    api.searchParams.set("srsearch", `\"${title}\" ${city.city_name}`);
    api.searchParams.set("srlimit", "1");
    api.searchParams.set("format", "json");
    api.searchParams.set("origin", "*");
    const search = await fetchJson(api) as MediaWikiSearchResponse;
    resolvedTitle = search.query?.search?.[0]?.title ?? "";
    if (!resolvedTitle) return null;
  }

  const detail = new URL(`https://${language}.${host}/w/api.php`);
  detail.searchParams.set("action", "query");
  detail.searchParams.set("prop", "extracts|info|pageimages");
  detail.searchParams.set("inprop", "url");
  detail.searchParams.set("exintro", "1");
  detail.searchParams.set("explaintext", "1");
  detail.searchParams.set("piprop", "thumbnail|original");
  detail.searchParams.set("pithumbsize", "1400");
  detail.searchParams.set("titles", resolvedTitle);
  detail.searchParams.set("format", "json");
  detail.searchParams.set("origin", "*");
  const payload = await fetchJson(detail) as MediaWikiPageResponse;
  const page = Object.values(payload.query?.pages ?? {})[0];
  if (!page || !page.title) return null;
  const extract = text(page.extract)?.slice(0, MAX_DESCRIPTION_LENGTH) ?? null;
  return {
    title: page.title,
    extract,
    url: text(page.fullurl),
    images: uniqueUrls([page.original?.source, page.thumbnail?.source]),
  };
}

async function wikidataEnrichment(tags: JsonObject): Promise<{ website: string | null; images: string[]; url: string | null } | null> {
  const id = text(tags.wikidata);
  if (!id || !/^Q\d+$/.test(id)) return null;
  const url = new URL(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`);
  const payload = record(await fetchJson(url));
  const entities = record(payload.entities);
  const entity = record(entities[id]);
  const claims = record(entity.claims);
  const claimValue = (property: string): string | null => {
    const list = claims[property];
    if (!Array.isArray(list)) return null;
    for (const claim of list) {
      const value = record(record(record(claim).mainsnak).datavalue).value;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };
  const imageName = claimValue("P18");
  const image = imageName
    ? `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(imageName.replaceAll(" ", "_"))}`
    : null;
  return {
    website: claimValue("P856"),
    images: uniqueUrls([image]),
    url: `https://www.wikidata.org/wiki/${id}`,
  };
}

export async function enrichPlacesFromPublicSources(
  places: JsonObject[],
  city: CityTarget,
  startedAt: number,
  executionBudgetMs: number,
): Promise<JsonObject[]> {
  const enriched: JsonObject[] = [];
  for (let index = 0; index < places.length; index += 1) {
    const place = places[index];
    if (index >= ENRICHMENT_LIMIT || Date.now() - startedAt > executionBudgetMs - 8_000) {
      enriched.push(place);
      continue;
    }

    const tags = record(place.tags);
    const currentImages = Array.isArray(place.image_urls) ? place.image_urls : [];
    const sources: JsonObject[] = Array.isArray(place.content_sources) ? place.content_sources as JsonObject[] : [];
    const sourceUrls = Array.isArray(place.source_urls) ? place.source_urls : [];
    let description = text(place.description);
    let website = text(place.website);
    const images: unknown[] = [...currentImages, place.image_url];

    try {
      const wiki = await findMediaWikiPage("wikipedia.org", place, city, wikipediaTitle(tags));
      if (wiki) {
        description ||= wiki.extract;
        images.push(...wiki.images);
        if (wiki.url) {
          sourceUrls.push(wiki.url);
          sources.push({ label: `Wikipedia — ${wiki.title}`, url: wiki.url, provider: "wikipedia" });
        }
      }
    } catch {
      // Enrichment is best effort; OSM discovery must remain available.
    }

    try {
      const travel = await findMediaWikiPage("wikivoyage.org", place, city);
      if (travel?.url) {
        description ||= travel.extract;
        images.push(...travel.images);
        sourceUrls.push(travel.url);
        sources.push({ label: `Wikivoyage — ${travel.title}`, url: travel.url, provider: "wikivoyage" });
      }
    } catch {
      // Continue with the other sources.
    }

    try {
      const wikidata = await wikidataEnrichment(tags);
      if (wikidata) {
        website ||= wikidata.website;
        images.push(...wikidata.images);
        if (wikidata.url) {
          sourceUrls.push(wikidata.url);
          sources.push({ label: "Wikidata", url: wikidata.url, provider: "wikidata" });
        }
      }
    } catch {
      // Continue with the normalized OSM data.
    }

    const imageUrls = uniqueUrls(images).slice(0, 12);
    const normalizedSourceUrls = uniqueUrls([place.source_url, website, ...sourceUrls]).slice(0, 12);
    enriched.push({
      ...place,
      description,
      website,
      image_url: imageUrls[0] ?? null,
      image_urls: imageUrls,
      source_urls: normalizedSourceUrls,
      content_sources: sources.filter((source, sourceIndex, all) => {
        const url = text(source.url);
        return Boolean(url) && all.findIndex((candidate) => text(candidate.url) === url) === sourceIndex;
      }).slice(0, 12),
      quality_score: Math.min(100, Number(place.quality_score ?? 0) + (description ? 6 : 0) + (imageUrls.length ? 5 : 0)),
    });
  }
  return enriched;
}
