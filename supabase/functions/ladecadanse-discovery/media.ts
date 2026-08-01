import type { SourceVenueCandidate, SourceVenueMedia } from "./parser.ts";

type JsonObject = Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 7_000;
const ALLOWED_LICENSES = new Set(["cc0", "pdm", "by", "by-sa"]);

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stripHtml(value: string | null): string | null {
  if (!value) return null;
  const stripped = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return stripped || null;
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function distinctiveTokens(value: string): string[] {
  return [...new Set(normalized(value).split(" ").filter((token) => token.length >= 4))];
}

function relevant(candidate: SourceVenueCandidate, title: string, description = ""): boolean {
  const haystack = normalized(`${title} ${description}`);
  const name = normalized(candidate.name);
  if (name.length >= 5 && haystack.includes(name)) return true;
  const tokens = distinctiveTokens(candidate.name);
  const nameMatches = tokens.filter((token) => haystack.includes(token)).length;
  const city = candidate.city ? normalized(candidate.city) : "";
  return nameMatches >= Math.min(2, Math.max(1, tokens.length)) && (!city || haystack.includes(city));
}

async function fetchJson(url: URL): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "GlobalParty-LaDecadanse-Media/1.0 (+https://github.com/mtnrconcept/event-horizon-finder)",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`media_source_http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function commonsLicenseAllowed(value: string | null): boolean {
  const license = normalized(value ?? "");
  if (!license) return false;
  if (license.includes("public domain") || license.includes("cc0")) return true;
  if (license.includes("cc by sa") || license.includes("creative commons attribution share alike")) {
    return true;
  }
  return license.includes("cc by") || license.includes("creative commons attribution");
}

async function searchWikimediaCommons(candidate: SourceVenueCandidate): Promise<SourceVenueMedia[]> {
  const query = `intitle:"${candidate.name.replaceAll('"', "")}" ${candidate.city ?? ""}`.trim();
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", query);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", "8");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata");
  url.searchParams.set("iiurlwidth", "1600");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  const payload = record(await fetchJson(url));
  const pages = Object.values(record(record(payload.query).pages));
  const output: SourceVenueMedia[] = [];
  for (const pageValue of pages) {
    const page = record(pageValue);
    const title = text(page.title) ?? "";
    const imageInfo = Array.isArray(page.imageinfo) ? record(page.imageinfo[0]) : {};
    const metadata = record(imageInfo.extmetadata);
    const metadataValue = (key: string): string | null => text(record(metadata[key]).value);
    const description = stripHtml(metadataValue("ImageDescription")) ?? "";
    if (!relevant(candidate, title, description)) continue;
    const license = stripHtml(metadataValue("LicenseShortName"));
    if (!commonsLicenseAllowed(license)) continue;
    const original = text(imageInfo.url);
    const thumbnail = text(imageInfo.thumburl);
    const sourceUrl = text(imageInfo.descriptionurl);
    if (!original || !sourceUrl) continue;
    output.push({
      url: original,
      thumbnailUrl: thumbnail,
      attribution: stripHtml(metadataValue("Credit")) ?? stripHtml(metadataValue("Attribution")),
      license,
      licenseUrl: text(metadataValue("LicenseUrl")),
      creator: stripHtml(metadataValue("Artist")),
      sourceUrl,
      sourceProvider: "wikimedia_commons",
      isFallback: true,
    });
    if (output.length >= 4) break;
  }
  return output;
}

async function searchOpenverse(candidate: SourceVenueCandidate): Promise<SourceVenueMedia[]> {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", `${candidate.name} ${candidate.city ?? ""}`.trim());
  url.searchParams.set("license", "cc0,pdm,by,by-sa");
  url.searchParams.set("page_size", "10");
  const payload = record(await fetchJson(url));
  const results = Array.isArray(payload.results) ? payload.results : [];
  const output: SourceVenueMedia[] = [];
  for (const value of results) {
    const result = record(value);
    const title = text(result.title) ?? "";
    const tags = Array.isArray(result.tags)
      ? result.tags.map((tag) => text(record(tag).name)).filter(Boolean).join(" ")
      : "";
    if (!relevant(candidate, title, tags)) continue;
    const license = (text(result.license) ?? "").toLowerCase();
    if (!ALLOWED_LICENSES.has(license)) continue;
    const original = text(result.url);
    const thumbnail = text(result.thumbnail);
    const sourceUrl = text(result.foreign_landing_url);
    if (!original || !sourceUrl) continue;
    output.push({
      url: original,
      thumbnailUrl: thumbnail,
      attribution: text(result.attribution),
      license: license.toUpperCase(),
      licenseUrl: text(result.license_url),
      creator: text(result.creator),
      sourceUrl,
      sourceProvider: "openverse",
      isFallback: true,
    });
    if (output.length >= 4) break;
  }
  return output;
}

export async function enrichVenueWithOpenLicenseMedia(
  candidate: SourceVenueCandidate,
): Promise<SourceVenueCandidate> {
  if (candidate.media.length || candidate.imageUrls.length) return candidate;

  let media: SourceVenueMedia[] = [];
  try {
    media = await searchWikimediaCommons(candidate);
  } catch {
    // Wikimedia is best effort. A missing fallback must never block venue ingestion.
  }
  if (!media.length) {
    try {
      media = await searchOpenverse(candidate);
    } catch {
      // Leave the venue without an image rather than attaching an uncertain result.
    }
  }
  if (!media.length) return candidate;

  const sourceUrls = [...new Set([...candidate.sourceUrls, ...media.map((item) => item.sourceUrl)])];
  const contentSources = [
    ...candidate.contentSources,
    ...media.map((item) => ({
      label: [item.sourceProvider === "openverse" ? "Openverse" : "Wikimedia Commons", item.license, item.creator]
        .filter(Boolean)
        .join(" — "),
      url: item.sourceUrl,
      provider: item.sourceProvider,
    })),
  ];
  return {
    ...candidate,
    imageUrls: media.map((item) => item.url),
    media,
    sourceUrls: sourceUrls.slice(0, 12),
    contentSources: contentSources.slice(0, 12),
    qualityScore: Math.min(100, candidate.qualityScore + 5),
  };
}
