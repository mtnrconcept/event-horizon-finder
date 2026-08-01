import {
  cleanEventText,
  normalizeEventText,
  type EventCandidate,
  type EventSourceContext,
} from "../_shared/event-precision.ts";

export type LaDecadanseJobKind =
  | "agenda"
  | "event"
  | "venue_directory"
  | "venue"
  | "rss";

export type LaDecadanseDiscoveredLink = {
  url: string;
  kind: LaDecadanseJobKind;
  priority: number;
  refreshAfterSeconds: number;
};

export type SourceVenueMedia = {
  url: string;
  thumbnailUrl: string | null;
  attribution: string | null;
  license: string | null;
  licenseUrl: string | null;
  creator: string | null;
  sourceUrl: string;
  sourceProvider: string;
  isFallback: boolean;
};

export type SourceVenueCandidate = {
  sourceProvider: "ladecadanse";
  externalId: string;
  sourceUrl: string;
  name: string;
  category: string;
  subcategory: string | null;
  description: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  website: string | null;
  openingHours: string | null;
  bookingUrl: string | null;
  imageUrls: string[];
  media: SourceVenueMedia[];
  sourceUrls: string[];
  contentSources: Array<{ label: string; url: string; provider: string }>;
  qualityScore: number;
};

export type ParsedLaDecadanseDocument = {
  events: EventCandidate[];
  venues: SourceVenueCandidate[];
  links: LaDecadanseDiscoveredLink[];
};

const CANONICAL_ORIGIN = "https://www.ladecadanse.ch";
const EVENT_URL_PATTERN = /^\/event\/evenement\.php\?idE=(\d+)$/i;
const VENUE_URL_PATTERN = /^\/lieu\/lieu\.php\?idL=(\d+)$/i;
const ALLOWED_IMAGE_EXTENSIONS = /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i;

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    eacute: "é",
    egrave: "è",
    ecirc: "ê",
    agrave: "à",
    auml: "ä",
    ccedil: "ç",
    nbsp: " ",
    quot: '"',
    lt: "<",
    gt: ">",
    ndash: "–",
    mdash: "—",
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function plainText(value: string, maximum = 4_000): string {
  return cleanEventText(
    decodeEntities(
      value
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<\/p\s*>/gi, "\n")
        .replace(/<\/li\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ),
    maximum,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attribute(tag: string, name: string): string {
  const expression = new RegExp(
    `\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = expression.exec(tag);
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function absoluteUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(decodeEntities(value.trim()), baseUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    if (url.hostname === "ladecadanse.ch") url.hostname = "www.ladecadanse.ch";
    return url.toString();
  } catch {
    return null;
  }
}

function canonicalSourceUrl(value: string): string | null {
  const url = absoluteUrl(value, CANONICAL_ORIGIN);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.hostname !== "www.ladecadanse.ch") return null;
  return parsed.toString();
}

function allAnchors(html: string, baseUrl: string): Array<{ url: string; text: string; tag: string }> {
  const output: Array<{ url: string; text: string; tag: string }> = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = canonicalSourceUrl(match[1] ?? match[2] ?? match[3] ?? "");
    if (!url) continue;
    output.push({ url, text: plainText(match[4] ?? "", 500), tag: match[0] });
  }
  return output;
}

function firstClassBlock(html: string, tag: string, className: string): string {
  const pattern = new RegExp(
    `<${tag}\\b(?=[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'])[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "i",
  );
  return pattern.exec(html)?.[1] ?? "";
}

function firstIdBlock(html: string, tag: string, id: string): string {
  const pattern = new RegExp(
    `<${tag}\\b(?=[^>]*\\bid\\s*=\\s*["']${escapeRegExp(id)}["'])[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "i",
  );
  return pattern.exec(html)?.[1] ?? "";
}

function metaContent(html: string, key: string, expected: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (normalizeEventText(attribute(match[0], key)) !== normalizeEventText(expected)) continue;
    const content = attribute(match[0], "content");
    if (content) return content;
  }
  return null;
}

function finiteNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function pathAndSearch(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function kindForUrl(url: string): LaDecadanseJobKind | null {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (EVENT_URL_PATTERN.test(pathAndSearch(url))) return "event";
  if (VENUE_URL_PATTERN.test(pathAndSearch(url))) return "venue";
  if (/\/event\/rss\.php$/i.test(path)) return "rss";
  if (/^\/lieu\/?(?:index\.php)?$/i.test(path)) return "venue_directory";
  if (/^\/(?:index\.php)?$/i.test(path)) return "agenda";
  return null;
}

function priorityForKind(kind: LaDecadanseJobKind): number {
  switch (kind) {
    case "event":
      return 90;
    case "venue":
      return 80;
    case "rss":
      return 75;
    case "venue_directory":
      return 60;
    case "agenda":
      return 50;
  }
}

function refreshForKind(kind: LaDecadanseJobKind): number {
  switch (kind) {
    case "rss":
      return 2 * 60 * 60;
    case "event":
      return 12 * 60 * 60;
    case "agenda":
      return 12 * 60 * 60;
    case "venue_directory":
      return 24 * 60 * 60;
    case "venue":
      return 7 * 24 * 60 * 60;
  }
}

export function discoverLaDecadanseLinks(
  html: string,
  pageUrl: string,
): LaDecadanseDiscoveredLink[] {
  const discovered = new Map<string, LaDecadanseDiscoveredLink>();
  const add = (candidate: string | null) => {
    if (!candidate) return;
    const kind = kindForUrl(candidate);
    if (!kind) return;
    const canonical = canonicalSourceUrl(candidate);
    if (!canonical) return;
    discovered.set(canonical, {
      url: canonical,
      kind,
      priority: priorityForKind(kind),
      refreshAfterSeconds: refreshForKind(kind),
    });
  };

  for (const anchor of allAnchors(html, pageUrl)) add(anchor.url);

  const current = new URL(pageUrl);
  const venueId = VENUE_URL_PATTERN.exec(pathAndSearch(current.toString()))?.[1];
  if (venueId) {
    add(`${CANONICAL_ORIGIN}/event/rss.php?type=lieu_evenements&id=${venueId}`);
  }

  if (/^\/(?:index\.php)?$/i.test(current.pathname)) {
    add(`${CANONICAL_ORIGIN}/lieu/`);
    add(`${CANONICAL_ORIGIN}/event/rss.php?type=evenements_ajoutes`);
  }

  return [...discovered.values()];
}

function dateValueFromPage(html: string): string | null {
  const dtStart = firstClassBlock(html, "span", "dtstart") || firstClassBlock(html, "time", "dtstart");
  for (const scope of [dtStart, html]) {
    const titleMatch = /\btitle\s*=\s*["'](20\d{2}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?)["']/i.exec(
      scope,
    );
    if (titleMatch?.[1]) return titleMatch[1];
    const datetimeMatch = /\bdatetime\s*=\s*["'](20\d{2}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?)["']/i.exec(
      scope,
    );
    if (datetimeMatch?.[1]) return datetimeMatch[1];
  }
  return null;
}

function scheduleRange(html: string): { startHour: number; startMinute: number; endHour: number | null; endMinute: number | null } | null {
  const practical = firstIdBlock(html, "div", "pratique") || html;
  const normalized = plainText(practical, 5_000).replace(/\s+/g, " ");
  const range = /\b([01]?\d|2[0-3])\s*(?:h|:)\s*(\d{2})?\s*(?:-|–|—|à)\s*([01]?\d|2[0-3])\s*(?:h|:)\s*(\d{2})?\b/i.exec(
    normalized,
  );
  if (range) {
    return {
      startHour: Number(range[1]),
      startMinute: Number(range[2] ?? 0),
      endHour: Number(range[3]),
      endMinute: Number(range[4] ?? 0),
    };
  }
  const single = /\b([01]?\d|2[0-3])\s*(?:h|:)\s*(\d{2})?\b/i.exec(normalized);
  return single
    ? {
        startHour: Number(single[1]),
        startMinute: Number(single[2] ?? 0),
        endHour: null,
        endMinute: null,
      }
    : null;
}

function padded(value: number): string {
  return String(value).padStart(2, "0");
}

function addDay(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function eventTimes(html: string): {
  startDate: string;
  endDate: string | null;
  timePrecision: "exact" | "date";
  allDay: boolean;
} | null {
  const rawDate = dateValueFromPage(html);
  if (!rawDate) return null;
  const day = rawDate.slice(0, 10);
  const range = scheduleRange(html);
  if (rawDate.includes("T")) {
    const startDate = rawDate.length === 16 ? `${rawDate}:00` : rawDate;
    if (!range?.endHour && range?.endHour !== 0) {
      return { startDate, endDate: null, timePrecision: "exact", allDay: false };
    }
    const startHour = Number(startDate.slice(11, 13));
    const startMinute = Number(startDate.slice(14, 16));
    const endDay =
      range.endHour! < startHour ||
      (range.endHour === startHour && (range.endMinute ?? 0) <= startMinute)
        ? addDay(day)
        : day;
    return {
      startDate,
      endDate: `${endDay}T${padded(range.endHour!)}:${padded(range.endMinute ?? 0)}:00`,
      timePrecision: "exact",
      allDay: false,
    };
  }
  if (!range) return { startDate: day, endDate: null, timePrecision: "date", allDay: true };
  const startDate = `${day}T${padded(range.startHour)}:${padded(range.startMinute)}:00`;
  let endDate: string | null = null;
  if (range.endHour != null) {
    const endDay =
      range.endHour < range.startHour ||
      (range.endHour === range.startHour && (range.endMinute ?? 0) <= range.startMinute)
        ? addDay(day)
        : day;
    endDate = `${endDay}T${padded(range.endHour)}:${padded(range.endMinute ?? 0)}:00`;
  }
  return { startDate, endDate, timePrecision: "exact", allDay: false };
}

function firstImage(html: string, pageUrl: string): string | null {
  const metaImage = metaContent(html, "property", "og:image") ?? metaContent(html, "name", "twitter:image");
  const resolvedMeta = metaImage ? absoluteUrl(metaImage, pageUrl) : null;
  if (resolvedMeta && ALLOWED_IMAGE_EXTENSIONS.test(resolvedMeta)) return resolvedMeta;
  const illustrations = firstIdBlock(html, "div", "illustrations") || firstIdBlock(html, "figure", "illustrations");
  const imageMatch = /<(?:img|a)\b[^>]*(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/i.exec(
    illustrations,
  );
  const resolved = absoluteUrl(imageMatch?.[1] ?? imageMatch?.[2] ?? "", pageUrl);
  return resolved && ALLOWED_IMAGE_EXTENSIONS.test(resolved) ? resolved : null;
}

function venueAnchor(html: string, pageUrl: string): { id: string; url: string; name: string } | null {
  for (const anchor of allAnchors(html, pageUrl)) {
    const id = VENUE_URL_PATTERN.exec(pathAndSearch(anchor.url))?.[1];
    if (id && anchor.text) return { id, url: anchor.url, name: anchor.text };
  }
  return null;
}

function eventAddress(html: string): string | null {
  const value = firstClassBlock(html, "li", "adr") || firstClassBlock(html, "span", "adr");
  return plainText(value, 500) || null;
}

function pageCoordinates(html: string): { latitude: number | null; longitude: number | null } {
  const mapTag = /<[^>]+\bid\s*=\s*["'](?:lieu-map|evenement-map)["'][^>]*>/i.exec(html)?.[0] ?? "";
  const latitude = finiteNumber(attribute(mapTag, "data-lat"));
  const longitude = finiteNumber(attribute(mapTag, "data-lng"));
  if (latitude != null && longitude != null) return { latitude, longitude };
  const latTitle = /class\s*=\s*["'][^"']*latitude[^"']*["'][\s\S]{0,240}?title\s*=\s*["'](-?\d+(?:\.\d+)?)["']/i.exec(
    html,
  )?.[1];
  const lngTitle = /class\s*=\s*["'][^"']*longitude[^"']*["'][\s\S]{0,240}?title\s*=\s*["'](-?\d+(?:\.\d+)?)["']/i.exec(
    html,
  )?.[1];
  return { latitude: finiteNumber(latTitle), longitude: finiteNumber(lngTitle) };
}

function categoryText(html: string): string | null {
  const category = firstClassBlock(html, "span", "category");
  return plainText(category, 160) || null;
}

function priceText(html: string): string | null {
  const practical = plainText(firstIdBlock(html, "div", "pratique") || html, 5_000);
  const free = /\b(?:gratuit|entrée libre|prix libre|chapeau)\b/i.exec(practical)?.[0];
  if (free) return free;
  const currency = /(?:CHF|Fr\.?|€)\s*\d+(?:[.,]\d+)?(?:\s*(?:-|à)\s*(?:CHF|Fr\.?|€)?\s*\d+(?:[.,]\d+)?)?/i.exec(
    practical,
  )?.[0];
  return currency ? plainText(currency, 120) : null;
}

function parsePrices(value: string | null): {
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  isFree: boolean;
} {
  if (!value) return { priceMin: null, priceMax: null, currency: null, isFree: false };
  const isFree = /gratuit|entrée libre|prix libre|chapeau/i.test(value);
  const numbers = [...value.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => Number(match[0].replace(",", ".")));
  const currency = /CHF|Fr\.?/i.test(value) ? "CHF" : value.includes("€") ? "EUR" : null;
  return {
    priceMin: isFree ? 0 : numbers[0] ?? null,
    priceMax: isFree ? 0 : numbers.length > 1 ? numbers[numbers.length - 1] : numbers[0] ?? null,
    currency,
    isFree,
  };
}

function bookingLink(html: string, pageUrl: string): string | null {
  for (const anchor of allAnchors(html, pageUrl)) {
    if (/billet|ticket|pr[ée]location|r[ée]server|inscription/i.test(anchor.text)) return anchor.url;
  }
  return null;
}

function postalCodeFromAddress(address: string | null): string | null {
  return address ? /\b\d{4,5}\b/.exec(address)?.[0] ?? null : null;
}

function venueClassification(value: string): { category: string; subcategory: string | null } {
  const normalized = normalizeEventText(value);
  if (/bar|cafe|restaurant|bistrot|brasserie/.test(normalized)) {
    return { category: "food-drink", subcategory: "bar-cafe-restaurant" };
  }
  if (/parc|jardin|nature|plein air/.test(normalized)) {
    return { category: "nature", subcategory: "park-garden" };
  }
  if (/cinema|theatre|musee|galerie|art|culture/.test(normalized)) {
    return { category: "culture", subcategory: "cultural-venue" };
  }
  if (/club|discotheque|dancing|concert|musique|salle|usine|association|centre|espace/.test(normalized)) {
    return { category: "culture", subcategory: "nightlife-community-venue" };
  }
  return { category: "culture", subcategory: "event-venue" };
}

function minimalVenueFromEvent(
  html: string,
  pageUrl: string,
  source: EventSourceContext,
): SourceVenueCandidate | null {
  const anchor = venueAnchor(html, pageUrl);
  const address = eventAddress(html);
  if (!anchor || !address) return null;
  const coordinates = pageCoordinates(html);
  const classification = venueClassification(`${anchor.name} ${categoryText(html) ?? ""}`);
  return {
    sourceProvider: "ladecadanse",
    externalId: anchor.id,
    sourceUrl: anchor.url,
    name: anchor.name,
    category: classification.category,
    subcategory: classification.subcategory,
    description: null,
    address,
    postalCode: postalCodeFromAddress(address),
    city: source.city.name,
    countryCode: source.city.country?.code ?? "CH",
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    website: null,
    openingHours: null,
    bookingUrl: null,
    imageUrls: [],
    media: [],
    sourceUrls: [anchor.url],
    contentSources: [{ label: "La Décadanse — fiche du lieu", url: anchor.url, provider: "ladecadanse" }],
    qualityScore: coordinates.latitude != null ? 78 : 70,
  };
}

export function parseLaDecadanseEventPage(
  html: string,
  pageUrl: string,
  source: EventSourceContext,
): { event: EventCandidate | null; venue: SourceVenueCandidate | null } {
  const eventId = EVENT_URL_PATTERN.exec(pathAndSearch(pageUrl))?.[1] ?? null;
  if (!eventId) return { event: null, venue: null };
  const titleBlock = firstClassBlock(html, "h1", "summary") || firstClassBlock(html, "h1", "titre");
  const title = plainText(titleBlock, 240) || plainText(metaContent(html, "property", "og:title") ?? "", 240);
  const times = eventTimes(html);
  if (!title || !times) return { event: null, venue: minimalVenueFromEvent(html, pageUrl, source) };

  const anchor = venueAnchor(html, pageUrl);
  const address = eventAddress(html);
  const coordinates = pageCoordinates(html);
  const description = plainText(firstClassBlock(html, "p", "description"), 8_000) || null;
  const price = parsePrices(priceText(html));
  const category = categoryText(html);
  const imageUrl = firstImage(html, pageUrl);
  const venueName = anchor?.name ?? null;
  const venueUrl = anchor?.url ?? null;

  return {
    event: {
      sourceUrl: canonicalSourceUrl(pageUrl) ?? pageUrl,
      externalId: eventId,
      title,
      description,
      startDate: times.startDate,
      endDate: times.endDate,
      timezone: source.city.timezone || "Europe/Zurich",
      timePrecision: times.timePrecision,
      allDay: times.allDay,
      venueName,
      venueUrl,
      address,
      postalCode: postalCodeFromAddress(address),
      city: source.city.name,
      region: null,
      countryCode: source.city.country?.code ?? "CH",
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      organizerName: null,
      organizerUrl: null,
      status: /annul[ée]|cancelled/i.test(plainText(html, 4_000)) ? "cancelled" : "scheduled",
      language: "fr",
      category,
      genres: [],
      capacity: null,
      ageRestriction: null,
      priceMin: price.priceMin,
      priceMax: price.priceMax,
      currency: price.currency,
      ticketUrl: bookingLink(html, pageUrl),
      imageUrl,
      isFree: price.isFree,
      performers: [],
      accessibility: null,
      extractionMethod: "ladecadanse_microformat_v1",
      warnings: [],
    },
    venue: minimalVenueFromEvent(html, pageUrl, source),
  };
}

function allVenueImages(html: string, pageUrl: string): SourceVenueMedia[] {
  const mediaBlock = firstIdBlock(html, "div", "medias") || html;
  const urls: string[] = [];
  for (const match of mediaBlock.matchAll(/<(?:a|img)\b[^>]*(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)) {
    const url = absoluteUrl(match[1] ?? match[2] ?? "", pageUrl);
    if (!url || !ALLOWED_IMAGE_EXTENSIONS.test(url)) continue;
    if (/\/(?:s_|mini|thumb)[^/]*$/i.test(new URL(url).pathname)) continue;
    urls.push(url);
  }
  return unique(urls).slice(0, 12).map((url) => ({
    url,
    thumbnailUrl: null,
    attribution: "La Décadanse — fiche publique du lieu",
    license: null,
    licenseUrl: null,
    creator: null,
    sourceUrl: pageUrl,
    sourceProvider: "ladecadanse",
    isFallback: false,
  }));
}

function venueOpeningHours(html: string): string | null {
  const practical = firstIdBlock(html, "div", "pratique");
  for (const match of practical.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const value = plainText(match[1], 500);
    if (/\b(?:lu|ma|me|je|ve|sa|di|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/i.test(value) && /\d{1,2}\s*(?:h|:)/i.test(value)) {
      return value;
    }
  }
  return null;
}

function venueWebsite(html: string, pageUrl: string): string | null {
  const siteItem = firstClassBlock(html, "li", "sitelieu");
  for (const match of siteItem.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)) {
    const url = absoluteUrl(match[1] ?? match[2] ?? "", pageUrl);
    if (!url) continue;
    if (new URL(url).hostname !== "www.ladecadanse.ch") return url;
  }
  return null;
}

function venueDescription(html: string): string | null {
  const descriptions = firstIdBlock(html, "div", "descriptions");
  const value = plainText(descriptions, 4_000);
  if (value.length >= 30) return value;
  const meta = metaContent(html, "name", "description");
  return meta ? plainText(meta, 2_000) || null : null;
}

function venueCategoryText(html: string): string {
  const practical = firstIdBlock(html, "div", "pratique");
  const firstItem = /<li\b[^>]*>([\s\S]*?)<\/li>/i.exec(practical)?.[1] ?? "";
  return plainText(firstItem, 500);
}

export function parseLaDecadanseVenuePage(
  html: string,
  pageUrl: string,
  source: EventSourceContext,
): SourceVenueCandidate | null {
  const venueId = VENUE_URL_PATTERN.exec(pathAndSearch(pageUrl))?.[1] ?? null;
  if (!venueId) return null;
  const name = plainText(firstClassBlock(html, "h1", "fn") || firstClassBlock(html, "h1", "org"), 240);
  const address = eventAddress(html);
  if (!name || !address) return null;
  const coordinates = pageCoordinates(html);
  const categoryLabel = venueCategoryText(html);
  const classification = venueClassification(`${categoryLabel} ${name}`);
  const media = allVenueImages(html, pageUrl);
  const website = venueWebsite(html, pageUrl);
  const sourceUrl = canonicalSourceUrl(pageUrl) ?? pageUrl;
  const sourceUrls = unique([sourceUrl, website].filter((value): value is string => Boolean(value)));
  const description = venueDescription(html);
  return {
    sourceProvider: "ladecadanse",
    externalId: venueId,
    sourceUrl,
    name,
    category: classification.category,
    subcategory: classification.subcategory,
    description,
    address,
    postalCode: postalCodeFromAddress(address),
    city: source.city.name,
    countryCode: source.city.country?.code ?? "CH",
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    website,
    openingHours: venueOpeningHours(html),
    bookingUrl: null,
    imageUrls: media.map((item) => item.url),
    media,
    sourceUrls,
    contentSources: [
      { label: `La Décadanse — ${name}`, url: sourceUrl, provider: "ladecadanse" },
      ...(website
        ? [{ label: `Site officiel — ${name}`, url: website, provider: "official_website" }]
        : []),
    ],
    qualityScore: Math.min(
      100,
      65 +
        (description ? 8 : 0) +
        (website ? 8 : 0) +
        (media.length ? 8 : 0) +
        (coordinates.latitude != null ? 6 : 0) +
        (venueOpeningHours(html) ? 5 : 0),
    ),
  };
}

export function parseLaDecadanseDocument(
  html: string,
  pageUrl: string,
  source: EventSourceContext,
): ParsedLaDecadanseDocument {
  const kind = kindForUrl(pageUrl);
  const events: EventCandidate[] = [];
  const venues: SourceVenueCandidate[] = [];
  if (kind === "event") {
    const parsed = parseLaDecadanseEventPage(html, pageUrl, source);
    if (parsed.event) events.push(parsed.event);
    if (parsed.venue) venues.push(parsed.venue);
  } else if (kind === "venue") {
    const venue = parseLaDecadanseVenuePage(html, pageUrl, source);
    if (venue) venues.push(venue);
  }
  return {
    events,
    venues,
    links: discoverLaDecadanseLinks(html, pageUrl),
  };
}
