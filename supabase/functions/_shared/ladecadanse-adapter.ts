import {
  cleanEventText,
  normalizeEventText,
  type EventCandidate,
  type EventSourceContext,
} from "./event-precision.ts";

export const LADECADANSE_HOST = "www.ladecadanse.ch";
export const LADECADANSE_ROOT_URL = `https://${LADECADANSE_HOST}/`;
export const LADECADANSE_VENUE_CATALOG_URL = `${LADECADANSE_ROOT_URL}lieu/lieux.php`;

export type LadecadanseQueueKind = "agenda" | "venue_catalog" | "venue" | "event";

export type LadecadanseDiscoveredLink = {
  kind: LadecadanseQueueKind;
  url: string;
  externalIdentifier: string | null;
  priority: number;
};

export type LadecadanseMedia = {
  url: string;
  mediaType: "image" | "logo";
  attribution: string | null;
  license: string | null;
  sourceUrl: string | null;
  provider: string;
  isPrimary: boolean;
  sortOrder: number;
};

export type LadecadanseVenue = {
  externalIdentifier: string;
  sourceUrl: string;
  name: string;
  types: string[];
  category: string;
  subcategory: string | null;
  description: string | null;
  address: string | null;
  postalCode: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  media: LadecadanseMedia[];
  eventLinks: LadecadanseDiscoveredLink[];
  qualityScore: number;
};

export type LadecadanseEvent = {
  candidate: EventCandidate;
  externalIdentifier: string;
  venueExternalIdentifier: string | null;
  venueSourceUrl: string | null;
  discoveredLinks: LadecadanseDiscoveredLink[];
};

type Anchor = {
  tag: string;
  href: string;
  label: string;
  absoluteUrl: string | null;
};

type CommonsSearchResponse = {
  query?: {
    pages?: Record<
      string,
      {
        title?: string;
        imageinfo?: Array<{
          url?: string;
          descriptionurl?: string;
          mime?: string;
          extmetadata?: Record<string, { value?: string }>;
        }>;
      }
    >;
  };
};

const MONTHS: Record<string, number> = {
  janvier: 1,
  fevrier: 2,
  février: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  août: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
  décembre: 12,
};

const FREE_TEXT =
  /\b(?:entree libre|entrée libre|gratuit|gratuite|free|prix libre|donation libre)\b/i;
const PRICE_TEXT = /\b(\d{1,4})(?:[.,](\d{1,2}))?\s*(CHF|EUR|€|fr\.?|chf|euros?)\b/i;
const DATE_TEXT = new RegExp(
  `\\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)?\\s*(\\d{1,2})(?:er)?\\s+(${Object.keys(MONTHS).join("|")})\\s+(20\\d{2})\\b`,
  "i",
);
const TIME_RANGE =
  /\b([01]?\d|2[0-3])\s*(?::|h)\s*([0-5]\d)\s*(?:–|—|-|a|à)\s*([01]?\d|2[0-3])\s*(?::|h)\s*([0-5]\d)\b/i;
const SINGLE_TIME = /\b([01]?\d|2[0-3])\s*(?::|h)\s*([0-5]\d)\b/i;
const ALLOWED_COMMONS_LICENSE = /^(?:CC0|Public domain|PD|CC BY(?:-SA)?(?: \d(?:\.\d)?)?)$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&eacute;/gi, "é")
    .replace(/&egrave;/gi, "è")
    .replace(/&agrave;/gi, "à")
    .replace(/&ocirc;/gi, "ô")
    .replace(/&ucirc;/gi, "û")
    .replace(/&ccedil;/gi, "ç")
    .replace(/&#(\d+);/g, (_match, decimal: string) => {
      const code = Number.parseInt(decimal, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexadecimal: string) => {
      const code = Number.parseInt(hexadecimal, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

function htmlText(value: string, maximum = 8_000): string {
  return cleanEventText(
    decodeEntities(
      value
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ),
    maximum,
  );
}

function attribute(tag: string, name: string): string {
  const escaped = escapeRegExp(name);
  const match = new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(
    tag,
  );
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function firstTagText(html: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  const value = match ? htmlText(match[1], 500) : "";
  return value || null;
}

function metaContent(html: string, key: string, expectedValue: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (normalizeEventText(attribute(match[0], key)) === normalizeEventText(expectedValue)) {
      return attribute(match[0], "content") || null;
    }
  }
  return null;
}

function safeAbsoluteUrl(value: string, pageUrl: string): string | null {
  try {
    const url = new URL(value, pageUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function exactSourceUrl(value: string, pageUrl: string): string | null {
  const absolute = safeAbsoluteUrl(value, pageUrl);
  if (!absolute) return null;
  const parsed = new URL(absolute);
  if (parsed.hostname.toLowerCase().replace(/\.$/, "") !== LADECADANSE_HOST) return null;
  parsed.protocol = "https:";
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString();
}

function anchors(html: string, pageUrl: string): Anchor[] {
  const output: Anchor[] = [];
  for (const match of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = /^<a\b[^>]*>/i.exec(match[0])?.[0] ?? match[0];
    const href = attribute(tag, "href");
    if (!href) continue;
    output.push({
      tag,
      href,
      label: htmlText(match[0].replace(tag, "").replace(/<\/a>\s*$/i, ""), 300),
      absoluteUrl: exactSourceUrl(href, pageUrl) ?? safeAbsoluteUrl(href, pageUrl),
    });
  }
  return output;
}

function eventIdFromUrl(value: string): string | null {
  try {
    return new URL(value).searchParams.get("idE")?.match(/^\d+$/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function venueIdFromUrl(value: string): string | null {
  try {
    return new URL(value).searchParams.get("idL")?.match(/^\d+$/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function queueLink(
  kind: LadecadanseQueueKind,
  value: string,
  pageUrl: string,
  priority: number,
): LadecadanseDiscoveredLink | null {
  const url = exactSourceUrl(value, pageUrl);
  if (!url) return null;
  return {
    kind,
    url,
    externalIdentifier:
      kind === "event" ? eventIdFromUrl(url) : kind === "venue" ? venueIdFromUrl(url) : null,
    priority,
  };
}

function uniqueLinks(values: LadecadanseDiscoveredLink[]): LadecadanseDiscoveredLink[] {
  const byUrl = new Map<string, LadecadanseDiscoveredLink>();
  for (const value of values) {
    const current = byUrl.get(value.url);
    if (!current || value.priority < current.priority) byUrl.set(value.url, value);
  }
  return [...byUrl.values()];
}

export function discoverLadecadanseLinks(
  html: string,
  pageUrl: string,
): LadecadanseDiscoveredLink[] {
  const output: LadecadanseDiscoveredLink[] = [];
  for (const anchor of anchors(html, pageUrl)) {
    if (!anchor.absoluteUrl) continue;
    const url = exactSourceUrl(anchor.absoluteUrl, pageUrl);
    if (!url) continue;
    const parsed = new URL(url);
    if (parsed.pathname === "/event/evenement.php" && eventIdFromUrl(url)) {
      const link = queueLink("event", url, pageUrl, 20);
      if (link) output.push(link);
      continue;
    }
    if (parsed.pathname === "/lieu/lieu.php" && venueIdFromUrl(url)) {
      const link = queueLink("venue", url, pageUrl, 30);
      if (link) output.push(link);
      continue;
    }
    if (parsed.pathname === "/lieu/lieux.php") {
      const page = Number.parseInt(parsed.searchParams.get("page") ?? "1", 10);
      if (page >= 1 && page <= 8) {
        const link = queueLink("venue_catalog", url, pageUrl, 50 + page);
        if (link) output.push(link);
      }
      continue;
    }
    if (parsed.pathname === "/" || parsed.pathname.endsWith("/agenda.php")) {
      const hasDateSignal = [...parsed.searchParams.keys()].some((key) =>
        /^(?:courant|date|jour|mois|annee|region)$/i.test(key),
      );
      if (parsed.pathname === "/" || hasDateSignal) {
        const link = queueLink("agenda", url, pageUrl, 80);
        if (link) output.push(link);
      }
    }
  }
  return uniqueLinks(output).slice(0, 2_000);
}

function pageTextAfterHeading(html: string, heading: string, nextHeading?: string): string | null {
  const start = new RegExp(
    `<h[1-6]\\b[^>]*>[^<]*${escapeRegExp(heading)}[\\s\\S]*?<\\/h[1-6]>`,
    "i",
  ).exec(html);
  if (!start || start.index == null) return null;
  const rest = html.slice(start.index + start[0].length);
  const endIndex = nextHeading
    ? rest.search(new RegExp(`<h[1-6]\\b[^>]*>[^<]*${escapeRegExp(nextHeading)}`, "i"))
    : -1;
  const value = htmlText(endIndex >= 0 ? rest.slice(0, endIndex) : rest, 8_000);
  return value || null;
}

function candidateImages(html: string, pageUrl: string): string[] {
  const candidates: string[] = [];
  const metaImage =
    metaContent(html, "property", "og:image") ?? metaContent(html, "name", "twitter:image");
  if (metaImage) candidates.push(metaImage);
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const source = attribute(match[0], "data-src") || attribute(match[0], "src");
    if (source) candidates.push(source);
  }
  const output: string[] = [];
  for (const value of candidates) {
    const url = safeAbsoluteUrl(value, pageUrl);
    if (!url) continue;
    const normalized = url.toLowerCase();
    if (
      /(?:favicon|sprite|calendar|picto|icon|logo[_-]?decadanse|tools\.ladecadanse\.ch\/.*(?:logo|header))/.test(
        normalized,
      )
    ) {
      continue;
    }
    if (!output.includes(url)) output.push(url);
  }
  return output.slice(0, 12);
}

function coordinatesFromLinks(
  html: string,
  pageUrl: string,
): { latitude: number | null; longitude: number | null } {
  for (const anchor of anchors(html, pageUrl)) {
    if (!/(?:plan|map|itineraire|itinéraire)/i.test(anchor.label)) continue;
    const absolute = anchor.absoluteUrl;
    if (!absolute) continue;
    try {
      const url = new URL(absolute);
      const pairs = [
        [url.searchParams.get("mlat"), url.searchParams.get("mlon")],
        [url.searchParams.get("lat"), url.searchParams.get("lon")],
        [url.searchParams.get("latitude"), url.searchParams.get("longitude")],
      ];
      const query = url.searchParams.get("q") ?? url.searchParams.get("query");
      if (query) {
        const match = /(-?\d{1,2}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)/.exec(query);
        if (match) pairs.push([match[1], match[2]]);
      }
      for (const [rawLatitude, rawLongitude] of pairs) {
        const latitude = Number(rawLatitude);
        const longitude = Number(rawLongitude);
        if (
          Number.isFinite(latitude) &&
          Number.isFinite(longitude) &&
          latitude >= -90 &&
          latitude <= 90 &&
          longitude >= -180 &&
          longitude <= 180
        ) {
          return { latitude, longitude };
        }
      }
    } catch {
      // Continue with other map links.
    }
  }
  return { latitude: null, longitude: null };
}

function externalWebsites(html: string, pageUrl: string): string[] {
  const output: string[] = [];
  for (const anchor of anchors(html, pageUrl)) {
    const absolute = safeAbsoluteUrl(anchor.href, pageUrl);
    if (!absolute) continue;
    const url = new URL(absolute);
    if (url.hostname.endsWith("ladecadanse.ch")) continue;
    if (/^(?:calendar|outlook|yahoo|google)\./i.test(url.hostname)) continue;
    if (/openstreetmap|google\.[^/]+\/maps|maps\.apple/i.test(absolute)) continue;
    if (!output.includes(absolute)) output.push(absolute);
  }
  return output.slice(0, 12);
}

function postalCodeFromAddress(address: string | null): string | null {
  if (!address) return null;
  return /\b(?:CH-)?(\d{4})\b/.exec(address)?.[1] ?? /\b(\d{5})\b/.exec(address)?.[1] ?? null;
}

function normalizeVenueType(value: string): string {
  return normalizeEventText(value)
    .replace(/[^a-z0-9 -]/g, "")
    .trim();
}

function venueClassification(
  types: string[],
  name: string,
): { category: string; subcategory: string | null } {
  const text = normalizeEventText(`${types.join(" ")} ${name}`);
  if (/musee|museum|galerie|gallery|theatre|cinema|salle|culture|concert/.test(text)) {
    return { category: "culture", subcategory: types[0] ?? null };
  }
  if (/parc|jardin|nature|plage|lac|plein air/.test(text)) {
    return { category: "nature", subcategory: types[0] ?? null };
  }
  if (/restaurant|bistrot|bar|cafe|café|marche|marché|food/.test(text)) {
    return { category: "food-drink", subcategory: types[0] ?? null };
  }
  if (/club|discotheque|discothèque|boite|boîte|dancing/.test(text)) {
    return { category: "attraction", subcategory: "nightlife" };
  }
  if (/sport|skate|stade|piscine/.test(text)) {
    return { category: "sports-outdoors", subcategory: types[0] ?? null };
  }
  return { category: "attraction", subcategory: types[0] ?? null };
}

function venueHeaderSection(html: string): string {
  const h1 = /<h1\b[^>]*>[\s\S]*?<\/h1>/i.exec(html);
  if (!h1 || h1.index == null) return html.slice(0, 8_000);
  const following = html.slice(h1.index + h1[0].length);
  const end = following.search(/<h[2-6]\b/i);
  return following.slice(0, end >= 0 ? end : 8_000);
}

function venueAddressAndTypes(html: string): { address: string | null; types: string[] } {
  const section = venueHeaderSection(html);
  const listItems = [...section.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => htmlText(match[1], 500))
    .filter(Boolean);
  const address =
    listItems.find(
      (value) =>
        /(?:\d|rue|route|chemin|quai|place|avenue|boulevard|sentier|parc|geneve|genève)/i.test(
          value,
        ) && !/(?:voir sur le plan|horaire)/i.test(value),
    ) ?? null;
  const typeCandidate = listItems.find(
    (value) =>
      value !== address &&
      /(?:bistrot|salle|restaurant|cinema|cinéma|theatre|théâtre|galerie|boutique|musee|musée|autre|bar|club|association)/i.test(
        value,
      ),
  );
  const types = (typeCandidate ?? "")
    .split(/[,/]/)
    .map(normalizeVenueType)
    .filter(Boolean)
    .slice(0, 8);
  return { address, types };
}

export function parseLadecadanseVenuePage(html: string, pageUrl: string): LadecadanseVenue | null {
  const sourceUrl = exactSourceUrl(pageUrl, LADECADANSE_ROOT_URL);
  const externalIdentifier = sourceUrl ? venueIdFromUrl(sourceUrl) : null;
  const name = firstTagText(html, "h1");
  if (!sourceUrl || !externalIdentifier || !name) return null;

  const { address, types } = venueAddressAndTypes(html);
  const classification = venueClassification(types, name);
  const description = pageTextAfterHeading(html, "Le lieu se présente", "Événements");
  const websites = externalWebsites(html, pageUrl);
  const coordinates = coordinatesFromLinks(html, pageUrl);
  const images = candidateImages(html, pageUrl);
  const media = images.map<LadecadanseMedia>((url, index) => ({
    url,
    mediaType: /logo/i.test(url) ? "logo" : "image",
    attribution: `La Décadanse — ${name}`,
    license: null,
    sourceUrl,
    provider: "ladecadanse",
    isPrimary: index === 0,
    sortOrder: index,
  }));
  const eventLinks = discoverLadecadanseLinks(html, pageUrl).filter(
    (link) => link.kind === "event",
  );
  const futureUrl = new URL(sourceUrl);
  futureUrl.searchParams.set("periode", "futur");
  const futureLink = queueLink("venue", futureUrl.toString(), pageUrl, 25);
  const discovered =
    futureLink && futureLink.url !== sourceUrl ? [...eventLinks, futureLink] : eventLinks;

  return {
    externalIdentifier,
    sourceUrl,
    name,
    types,
    category: classification.category,
    subcategory: classification.subcategory,
    description,
    address,
    postalCode: postalCodeFromAddress(address),
    website:
      websites.find((url) => !/instagram\.com|facebook\.com/i.test(url)) ?? websites[0] ?? null,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    media,
    eventLinks: uniqueLinks(discovered),
    qualityScore: Math.min(
      100,
      55 +
        (description ? 12 : 0) +
        (address ? 10 : 0) +
        (coordinates.latitude != null ? 10 : 0) +
        (media.length ? 8 : 0) +
        (websites.length ? 5 : 0),
    ),
  };
}

function parseDate(text: string): { year: number; month: number; day: number } | null {
  const match = DATE_TEXT.exec(text);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  const year = Number(match[3]);
  const day = Number(match[1]);
  if (!month || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null;
  return { year, month, day };
}

function isoLocalDateTime(
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  addDay = false,
): string {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + (addDay ? 1 : 0)));
  return `${shifted.getUTCFullYear().toString().padStart(4, "0")}-${(shifted.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}-${shifted.getUTCDate().toString().padStart(2, "0")}T${hour
    .toString()
    .padStart(2, "0")}:${minute.toString().padStart(2, "0")}:00`;
}

function eventTimes(
  text: string,
  date: { year: number; month: number; day: number },
): {
  startDate: string;
  endDate: string | null;
  allDay: boolean;
} {
  const range = TIME_RANGE.exec(text);
  if (range) {
    const startHour = Number(range[1]);
    const startMinute = Number(range[2]);
    const endHour = Number(range[3]);
    const endMinute = Number(range[4]);
    const rollsOver = endHour < startHour || (endHour === startHour && endMinute <= startMinute);
    return {
      startDate: isoLocalDateTime(date, startHour, startMinute),
      endDate: isoLocalDateTime(date, endHour, endMinute, rollsOver),
      allDay: false,
    };
  }
  const single = SINGLE_TIME.exec(text);
  if (single) {
    return {
      startDate: isoLocalDateTime(date, Number(single[1]), Number(single[2])),
      endDate: null,
      allDay: false,
    };
  }
  const dateOnly = `${date.year.toString().padStart(4, "0")}-${date.month.toString().padStart(2, "0")}-${date.day.toString().padStart(2, "0")}`;
  return { startDate: dateOnly, endDate: null, allDay: true };
}

function eventCategory(pageText: string): string | null {
  const normalized = normalizeEventText(pageText.slice(0, 1_200));
  if (/\bfetes?\b|\bsoirees?\b/.test(normalized)) return "soirees";
  if (/\bconcerts?\b/.test(normalized)) return "concerts";
  if (/\bfestivals?\b/.test(normalized)) return "festivals";
  if (/\btheatre\b|\bspectacle\b/.test(normalized)) return "theatre";
  if (/\bcine\b|\bcinema\b|\bfilm\b/.test(normalized)) return "cinema";
  if (/\bexpo\b|\bexposition\b|\bvernissage\b/.test(normalized)) return "expositions";
  return null;
}

function eventDescription(html: string, title: string, venueName: string | null): string | null {
  const h1 = /<h1\b[^>]*>[\s\S]*?<\/h1>/i.exec(html);
  if (!h1 || h1.index == null) return metaContent(html, "property", "og:description");
  let section = html.slice(h1.index + h1[0].length);
  const end = section.search(
    /(?:Signaler une erreur|Ajouter à un agenda|<form\b|<table\b[^>]*class=["'][^"']*calendrier)/i,
  );
  if (end >= 0) section = section.slice(0, end);
  const paragraphs = [...section.matchAll(/<(?:p|div)\b[^>]*>([\s\S]*?)<\/(?:p|div)>/gi)]
    .map((match) => htmlText(match[1], 2_000))
    .filter((value) => value.length >= 25)
    .filter(
      (value) =>
        !/(?:voir sur le plan|ajouter a un agenda|google calendar|outlook|signaler une erreur)/i.test(
          normalizeEventText(value),
        ),
    )
    .filter((value) => normalizeEventText(value) !== normalizeEventText(title))
    .filter((value) => !venueName || normalizeEventText(value) !== normalizeEventText(venueName));
  const unique = [...new Set(paragraphs)];
  const description = unique.join("\n\n").slice(0, 8_000).trim();
  return description || metaContent(html, "property", "og:description");
}

function venueAnchor(
  html: string,
  pageUrl: string,
): { id: string; url: string; name: string } | null {
  for (const anchor of anchors(html, pageUrl)) {
    if (!anchor.absoluteUrl) continue;
    const id = venueIdFromUrl(anchor.absoluteUrl);
    if (!id || !new URL(anchor.absoluteUrl).pathname.endsWith("/lieu/lieu.php")) continue;
    return { id, url: exactSourceUrl(anchor.absoluteUrl, pageUrl)!, name: anchor.label };
  }
  return null;
}

function eventAddressCandidateScore(value: string, venue: { name: string } | null): number {
  const normalized = normalizeEventText(value);
  if (!normalized) return -1;
  if (venue && normalized === normalizeEventText(venue.name)) return -1;
  if (
    /(?:voir sur le plan|www\.|https?:|ajouter a un agenda)/i.test(normalized) ||
    DATE_TEXT.test(value) ||
    TIME_RANGE.test(value) ||
    SINGLE_TIME.test(value) ||
    PRICE_TEXT.test(value) ||
    FREE_TEXT.test(value)
  ) {
    return -1;
  }

  let score = 0;
  if (
    /\b(?:rue|route|rte|chemin|ch|quai|place|pl|avenue|av|boulevard|bd|sentier|parc|impasse|passage|promenade|esplanade|allee|cours|square|faubourg|voie|montee)\b/.test(
      normalized,
    )
  ) {
    score += 6;
  }
  if (postalCodeFromAddress(value)) score += 4;
  if (
    /\b(?:geneve|carouge|lancy|meyrin|vernier|thonex|chene|vaud|france|suisse|switzerland)\b/.test(
      normalized,
    )
  ) {
    score += 2;
  }
  if (/\b\d{1,4}[a-z]?\b/.test(normalized)) score += 1;
  if (/\s[-–—]\s/.test(value)) score += 1;
  return score;
}

function eventAddress(html: string, venue: { name: string } | null): string | null {
  const h1 = /<h1\b[^>]*>[\s\S]*?<\/h1>/i.exec(html);
  const section =
    h1 && h1.index != null
      ? html.slice(h1.index + h1[0].length, h1.index + h1[0].length + 6_000)
      : html;
  const candidates = [...section.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => htmlText(match[1], 500))
    .filter(Boolean)
    .map((value) => ({ value, score: eventAddressCandidateScore(value, venue) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.value ?? null;
}

function eventPrice(text: string): {
  isFree: boolean;
  min: number | null;
  max: number | null;
  currency: string | null;
} {
  const isFree = FREE_TEXT.test(text);
  const prices = [...text.matchAll(new RegExp(PRICE_TEXT.source, "gi"))]
    .map((match) => Number(`${match[1]}.${match[2] ?? "0"}`))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100_000);
  const currencyMatch = PRICE_TEXT.exec(text)?.[3]?.toUpperCase() ?? null;
  const currency =
    currencyMatch?.includes("EUR") || currencyMatch === "€" ? "EUR" : currencyMatch ? "CHF" : null;
  return {
    isFree,
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
    currency,
  };
}

function ticketUrl(html: string, pageUrl: string): string | null {
  for (const anchor of anchors(html, pageUrl)) {
    if (!/(?:billet|ticket|reservation|réservation|reserver|réserver)/i.test(anchor.label))
      continue;
    const absolute = safeAbsoluteUrl(anchor.href, pageUrl);
    if (absolute) return absolute;
  }
  return null;
}

export function parseLadecadanseEventPage(
  html: string,
  pageUrl: string,
  source: EventSourceContext,
): LadecadanseEvent | null {
  const sourceUrl = exactSourceUrl(pageUrl, LADECADANSE_ROOT_URL);
  const externalIdentifier = sourceUrl ? eventIdFromUrl(sourceUrl) : null;
  const title = firstTagText(html, "h1");
  const text = htmlText(html, 30_000);
  const date = parseDate(text);
  if (!sourceUrl || !externalIdentifier || !title || !date) return null;

  const venue = venueAnchor(html, pageUrl);
  const address = eventAddress(html, venue);
  const coordinates = coordinatesFromLinks(html, pageUrl);
  const timing = eventTimes(text, date);
  const price = eventPrice(text);
  const images = candidateImages(html, pageUrl);
  const websites = externalWebsites(html, pageUrl);
  const category = eventCategory(text) ?? source.category_slug;
  const discoveredLinks = discoverLadecadanseLinks(html, pageUrl);
  const officialUrl = websites.find((url) => !/instagram\.com|facebook\.com/i.test(url)) ?? null;

  return {
    externalIdentifier,
    venueExternalIdentifier: venue?.id ?? null,
    venueSourceUrl: venue?.url ?? null,
    discoveredLinks,
    candidate: {
      externalId: externalIdentifier,
      title,
      description: eventDescription(html, title, venue?.name ?? null),
      startDate: timing.startDate,
      endDate: timing.endDate,
      timezone: source.city?.timezone ?? "Europe/Zurich",
      timePrecision: timing.allDay ? "date" : "exact",
      allDay: timing.allDay,
      venueName: venue?.name ?? null,
      venueUrl: venue?.url ?? officialUrl,
      address,
      postalCode: postalCodeFromAddress(address),
      city: source.city?.name ?? "Genève",
      countryCode: source.city?.country?.code ?? "CH",
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      organizerName: null,
      organizerUrl: null,
      language: "fr",
      category,
      genres: [],
      priceMin: price.min,
      priceMax: price.max,
      currency: price.currency ?? (source.city?.country?.code === "CH" ? "CHF" : null),
      ticketUrl: ticketUrl(html, pageUrl),
      imageUrl: images[0] ?? null,
      imageUrls: images,
      isFree: price.isFree,
      sourceUrl,
      extractionMethod: "html",
    },
  };
}

function commonsText(
  metadata: Record<string, { value?: string }> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key]?.value;
  return typeof value === "string" && value.trim() ? htmlText(value, 500) : null;
}

export async function findLicensedCommonsVenueMedia(
  venueName: string,
  cityName: string,
  fetcher: typeof fetch = fetch,
): Promise<LadecadanseMedia[]> {
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  api.searchParams.set("action", "query");
  api.searchParams.set("generator", "search");
  api.searchParams.set("gsrsearch", `"${venueName}" ${cityName} filetype:bitmap`);
  api.searchParams.set("gsrnamespace", "6");
  api.searchParams.set("gsrlimit", "8");
  api.searchParams.set("prop", "imageinfo");
  api.searchParams.set("iiprop", "url|mime|extmetadata");
  api.searchParams.set("format", "json");
  api.searchParams.set("origin", "*");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  try {
    const response = await fetcher(api, {
      headers: { accept: "application/json", "user-agent": "GlobalParty-Venue-Media/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as CommonsSearchResponse;
    const output: LadecadanseMedia[] = [];
    for (const page of Object.values(payload.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      if (!info?.url || !info.mime?.startsWith("image/")) continue;
      const license =
        commonsText(info.extmetadata, "LicenseShortName") ??
        commonsText(info.extmetadata, "UsageTerms");
      if (!license || !ALLOWED_COMMONS_LICENSE.test(license)) continue;
      const artist = commonsText(info.extmetadata, "Artist");
      const credit = commonsText(info.extmetadata, "Credit");
      output.push({
        url: info.url,
        mediaType: "image",
        attribution: artist ?? credit ?? "Wikimedia Commons",
        license,
        sourceUrl: info.descriptionurl ?? null,
        provider: "wikimedia_commons",
        isPrimary: output.length === 0,
        sortOrder: output.length,
      });
      if (output.length >= 4) break;
    }
    return output;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export function venuePayload(venue: LadecadanseVenue): Record<string, unknown> {
  return {
    external_identifier: venue.externalIdentifier,
    source_url: venue.sourceUrl,
    name: venue.name,
    types: venue.types,
    category: venue.category,
    subcategory: venue.subcategory,
    description: venue.description,
    address: venue.address,
    postal_code: venue.postalCode,
    website: venue.website,
    latitude: venue.latitude,
    longitude: venue.longitude,
    image_url: venue.media[0]?.url ?? null,
    media: venue.media.map((media) => ({
      url: media.url,
      media_type: media.mediaType,
      attribution: media.attribution,
      license: media.license,
      source_url: media.sourceUrl,
      provider: media.provider,
      is_primary: media.isPrimary,
      sort_order: media.sortOrder,
    })),
    quality_score: venue.qualityScore,
    tags: {
      source: "ladecadanse",
      venue_types: venue.types,
      exact_source_identity: true,
    },
    source_metadata: {
      adapter: "ladecadanse-v1",
      events_discovered: venue.eventLinks.length,
    },
  };
}
