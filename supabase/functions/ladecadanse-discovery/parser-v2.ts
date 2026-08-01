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

const ORIGIN = "https://www.ladecadanse.ch";
const EVENT_PATH = /^\/event\/evenement\.php\?idE=(\d+)$/i;
const VENUE_PATH = /^\/lieu\/lieu\.php\?idL=(\d+)$/i;
const IMAGE_PATH = /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i;

function sourceCity(source: EventSourceContext) {
  return {
    name: source.city?.name ?? "Genève",
    timezone: source.city?.timezone ?? "Europe/Zurich",
    countryCode: source.city?.country?.code ?? "CH",
  };
}

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
    .replace(/&#x([0-9a-f]+);/gi, (_, hexadecimal: string) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function text(value: string, maximum = 4_000): string {
  return cleanEventText(
    decodeEntities(
      value
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<\/(?:p|li|div|section)>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ),
    maximum,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(
    `\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function absoluteUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(decodeEntities(value.trim()), baseUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (url.hostname === "ladecadanse.ch") url.hostname = "www.ladecadanse.ch";
    if (url.hostname !== "www.ladecadanse.ch") return null;
    url.protocol = "https:";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function externalUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(decodeEntities(value.trim()), baseUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function pathAndSearch(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function blockByClass(html: string, tag: string, className: string): string {
  const match = new RegExp(
    `<${tag}\\b(?=[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'])[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "i",
  ).exec(html);
  return match?.[1] ?? "";
}

function blockById(html: string, tag: string, id: string): string {
  const match = new RegExp(
    `<${tag}\\b(?=[^>]*\\bid\\s*=\\s*["']${escapeRegExp(id)}["'])[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "i",
  ).exec(html);
  return match?.[1] ?? "";
}

function meta(html: string, key: string, expected: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (normalizeEventText(attribute(match[0], key)) !== normalizeEventText(expected)) continue;
    return attribute(match[0], "content") || null;
  }
  return null;
}

function anchors(html: string, baseUrl: string): Array<{ url: string; label: string }> {
  const output: Array<{ url: string; label: string }> = [];
  for (const match of html.matchAll(
    /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const url = absoluteUrl(match[1] ?? match[2] ?? match[3] ?? "", baseUrl);
    if (!url) continue;
    output.push({ url, label: text(match[4] ?? "", 500) });
  }
  return output;
}

function kind(url: string): LaDecadanseJobKind | null {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (EVENT_PATH.test(pathAndSearch(url))) return "event";
  if (VENUE_PATH.test(pathAndSearch(url))) return "venue";
  if (/\/event\/rss\.php$/i.test(path)) return "rss";
  if (/^\/lieu\/?(?:index\.php)?$/i.test(path)) return "venue_directory";
  if (/^\/(?:index\.php)?$/i.test(path)) return "agenda";
  return null;
}

function linkPolicy(jobKind: LaDecadanseJobKind) {
  switch (jobKind) {
    case "event":
      return { priority: 90, refreshAfterSeconds: 43_200 };
    case "venue":
      return { priority: 80, refreshAfterSeconds: 604_800 };
    case "rss":
      return { priority: 75, refreshAfterSeconds: 7_200 };
    case "venue_directory":
      return { priority: 60, refreshAfterSeconds: 86_400 };
    case "agenda":
      return { priority: 50, refreshAfterSeconds: 43_200 };
  }
}

export function discoverLaDecadanseLinks(
  html: string,
  pageUrl: string,
): LaDecadanseDiscoveredLink[] {
  const output = new Map<string, LaDecadanseDiscoveredLink>();
  const add = (url: string | null) => {
    if (!url) return;
    const jobKind = kind(url);
    if (!jobKind) return;
    output.set(url, { url, kind: jobKind, ...linkPolicy(jobKind) });
  };
  for (const anchor of anchors(html, pageUrl)) add(anchor.url);
  const venueId = VENUE_PATH.exec(pathAndSearch(pageUrl))?.[1];
  if (venueId) add(`${ORIGIN}/event/rss.php?type=lieu_evenements&id=${venueId}`);
  const current = new URL(pageUrl);
  if (/^\/(?:index\.php)?$/i.test(current.pathname)) {
    add(`${ORIGIN}/lieu/`);
    add(`${ORIGIN}/event/rss.php?type=evenements_ajoutes`);
  }
  return [...output.values()];
}

function number(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function coordinates(html: string) {
  const mapTag =
    /<[^>]+\bid\s*=\s*["'](?:lieu-map|evenement-map)["'][^>]*>/i.exec(html)?.[0] ?? "";
  let latitude = number(attribute(mapTag, "data-lat"));
  let longitude = number(attribute(mapTag, "data-lng"));
  if (latitude == null || longitude == null) {
    latitude = number(
      /class\s*=\s*["'][^"']*latitude[^"']*["'][\s\S]{0,240}?title\s*=\s*["'](-?\d+(?:\.\d+)?)["']/i.exec(
        html,
      )?.[1],
    );
    longitude = number(
      /class\s*=\s*["'][^"']*longitude[^"']*["'][\s\S]{0,240}?title\s*=\s*["'](-?\d+(?:\.\d+)?)["']/i.exec(
        html,
      )?.[1],
    );
  }
  return {
    latitude: latitude != null && latitude >= -90 && latitude <= 90 ? latitude : null,
    longitude: longitude != null && longitude >= -180 && longitude <= 180 ? longitude : null,
  };
}

function address(html: string): string | null {
  return text(blockByClass(html, "li", "adr") || blockByClass(html, "span", "adr"), 500) || null;
}

function postalCode(value: string | null): string | null {
  return value ? /\b\d{4,5}\b/.exec(value)?.[0] ?? null : null;
}

function venueLink(html: string, pageUrl: string): { id: string; url: string; name: string } | null {
  for (const anchor of anchors(html, pageUrl)) {
    const id = VENUE_PATH.exec(pathAndSearch(anchor.url))?.[1];
    if (id && anchor.label) return { id, url: anchor.url, name: anchor.label };
  }
  return null;
}

function dateValue(html: string): string | null {
  const scope = blockByClass(html, "span", "dtstart") || blockByClass(html, "time", "dtstart");
  for (const candidate of [scope, html]) {
    const value = /\b(?:title|datetime)\s*=\s*["'](20\d{2}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?)["']/i.exec(
      candidate,
    )?.[1];
    if (value) return value;
  }
  return null;
}

function timeRange(html: string) {
  const practical = text(blockById(html, "div", "pratique") || html, 5_000);
  const range = /\b([01]?\d|2[0-3])\s*(?:h|:)\s*(\d{2})?\s*(?:-|–|—|à)\s*([01]?\d|2[0-3])\s*(?:h|:)\s*(\d{2})?\b/i.exec(
    practical,
  );
  if (range) {
    return {
      startHour: Number(range[1]),
      startMinute: Number(range[2] ?? 0),
      endHour: Number(range[3]),
      endMinute: Number(range[4] ?? 0),
    };
  }
  const single = /\b([01]?\d|2[0-3])\s*(?:h|:)\s*(\d{2})?\b/i.exec(practical);
  return single
    ? {
        startHour: Number(single[1]),
        startMinute: Number(single[2] ?? 0),
        endHour: null,
        endMinute: null,
      }
    : null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function tomorrow(day: string): string {
  const parsed = new Date(`${day}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function eventSchedule(html: string) {
  const raw = dateValue(html);
  if (!raw) return null;
  const day = raw.slice(0, 10);
  const range = timeRange(html);
  let startDate: string;
  if (raw.includes("T")) startDate = raw.length === 16 ? `${raw}:00` : raw;
  else if (range) startDate = `${day}T${pad(range.startHour)}:${pad(range.startMinute)}:00`;
  else return { startDate: day, endDate: null, timePrecision: "date" as const, allDay: true };

  let endDate: string | null = null;
  if (range?.endHour != null) {
    const startHour = Number(startDate.slice(11, 13));
    const startMinute = Number(startDate.slice(14, 16));
    const endDay =
      range.endHour < startHour ||
      (range.endHour === startHour && range.endMinute <= startMinute)
        ? tomorrow(day)
        : day;
    endDate = `${endDay}T${pad(range.endHour)}:${pad(range.endMinute)}:00`;
  }
  return { startDate, endDate, timePrecision: "exact" as const, allDay: false };
}

function category(html: string): string | null {
  return text(blockByClass(html, "span", "category"), 160) || null;
}

function image(html: string, pageUrl: string): string | null {
  const metaImage = meta(html, "property", "og:image") ?? meta(html, "name", "twitter:image");
  const resolvedMeta = metaImage ? externalUrl(metaImage, pageUrl) : null;
  if (resolvedMeta && IMAGE_PATH.test(resolvedMeta)) return resolvedMeta;
  const illustration = blockById(html, "div", "illustrations") || blockById(html, "figure", "illustrations");
  const raw = /<(?:img|a)\b[^>]*(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/i.exec(
    illustration,
  );
  const resolved = externalUrl(raw?.[1] ?? raw?.[2] ?? "", pageUrl);
  return resolved && IMAGE_PATH.test(resolved) ? resolved : null;
}

function price(html: string) {
  const practical = text(blockById(html, "div", "pratique") || html, 5_000);
  const label =
    /\b(?:gratuit|entrée libre|prix libre|chapeau)\b/i.exec(practical)?.[0] ??
    /(?:CHF|Fr\.?|€)\s*\d+(?:[.,]\d+)?(?:\s*(?:-|à)\s*(?:CHF|Fr\.?|€)?\s*\d+(?:[.,]\d+)?)?/i.exec(
      practical,
    )?.[0] ??
    null;
  if (!label) return { priceMin: null, priceMax: null, currency: null, isFree: false };
  const isFree = /gratuit|entrée libre|prix libre|chapeau/i.test(label);
  const amounts = [...label.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) =>
    Number(match[0].replace(",", ".")),
  );
  return {
    priceMin: isFree ? 0 : amounts[0] ?? null,
    priceMax: isFree ? 0 : amounts.at(-1) ?? null,
    currency: /CHF|Fr\.?/i.test(label) ? "CHF" : label.includes("€") ? "EUR" : null,
    isFree,
  };
}

function booking(html: string, pageUrl: string): string | null {
  for (const anchor of anchors(html, pageUrl)) {
    if (/billet|ticket|pr[ée]location|r[ée]server|inscription/i.test(anchor.label)) return anchor.url;
  }
  return null;
}

function venueClassification(value: string) {
  const normalized = normalizeEventText(value);
  if (/bar|cafe|restaurant|bistrot|brasserie/.test(normalized)) {
    return { category: "food-drink", subcategory: "bar-cafe-restaurant" };
  }
  if (/parc|jardin|nature|plein air/.test(normalized)) {
    return { category: "nature", subcategory: "park-garden" };
  }
  if (/club|discotheque|dancing|concert|musique/.test(normalized)) {
    return { category: "culture", subcategory: "nightlife-venue" };
  }
  if (/cinema|theatre|musee|galerie|art|culture/.test(normalized)) {
    return { category: "culture", subcategory: "cultural-venue" };
  }
  return { category: "culture", subcategory: "community-event-venue" };
}

function minimalVenue(
  html: string,
  pageUrl: string,
  source: EventSourceContext,
): SourceVenueCandidate | null {
  const linked = venueLink(html, pageUrl);
  const venueAddress = address(html);
  if (!linked || !venueAddress) return null;
  const point = coordinates(html);
  const classification = venueClassification(`${linked.name} ${category(html) ?? ""}`);
  const city = sourceCity(source);
  return {
    sourceProvider: "ladecadanse",
    externalId: linked.id,
    sourceUrl: linked.url,
    name: linked.name,
    category: classification.category,
    subcategory: classification.subcategory,
    description: null,
    address: venueAddress,
    postalCode: postalCode(venueAddress),
    city: city.name,
    countryCode: city.countryCode,
    latitude: point.latitude,
    longitude: point.longitude,
    website: null,
    openingHours: null,
    bookingUrl: null,
    imageUrls: [],
    media: [],
    sourceUrls: [linked.url],
    contentSources: [
      { label: "La Décadanse — fiche du lieu", url: linked.url, provider: "ladecadanse" },
    ],
    qualityScore: point.latitude == null ? 70 : 78,
  };
}

export function parseLaDecadanseEventPage(
  html: string,
  pageUrl: string,
  source: EventSourceContext,
): { event: EventCandidate | null; venue: SourceVenueCandidate | null } {
  const eventId = EVENT_PATH.exec(pathAndSearch(pageUrl))?.[1] ?? null;
  if (!eventId) return { event: null, venue: null };
  const title =
    text(blockByClass(html, "h1", "summary") || blockByClass(html, "h1", "titre"), 240) ||
    text(meta(html, "property", "og:title") ?? "", 240);
  const schedule = eventSchedule(html);
  const linkedVenue = venueLink(html, pageUrl);
  const venueAddress = address(html);
  const point = coordinates(html);
  const priceInfo = price(html);
  const city = sourceCity(source);
  if (!title || !schedule) return { event: null, venue: minimalVenue(html, pageUrl, source) };

  const candidate: EventCandidate = {
    sourceUrl: absoluteUrl(pageUrl, ORIGIN) ?? pageUrl,
    externalId: eventId,
    title,
    description: text(blockByClass(html, "p", "description"), 8_000) || null,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    timezone: city.timezone,
    timePrecision: schedule.timePrecision,
    allDay: schedule.allDay,
    venueName: linkedVenue?.name ?? null,
    venueUrl: linkedVenue?.url ?? null,
    address: venueAddress,
    postalCode: postalCode(venueAddress),
    city: city.name,
    region: null,
    countryCode: city.countryCode,
    latitude: point.latitude,
    longitude: point.longitude,
    organizerName: null,
    organizerUrl: null,
    status: /annul[ée]|cancelled/i.test(text(html, 4_000)) ? "cancelled" : "scheduled",
    language: "fr",
    category: category(html),
    genres: [],
    performers: [],
    ageRestriction: null,
    accessibility: null,
    capacity: null,
    priceMin: priceInfo.priceMin,
    priceMax: priceInfo.priceMax,
    currency: priceInfo.currency,
    ticketUrl: booking(html, pageUrl),
    imageUrl: image(html, pageUrl),
    isFree: priceInfo.isFree,
    extractionMethod: "html",
  };
  return { event: candidate, venue: minimalVenue(html, pageUrl, source) };
}

function venueMedia(html: string, pageUrl: string): SourceVenueMedia[] {
  const block = blockById(html, "div", "medias") || html;
  const seen = new Set<string>();
  const output: SourceVenueMedia[] = [];
  for (const match of block.matchAll(
    /<(?:a|img)\b[^>]*(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi,
  )) {
    const url = externalUrl(match[1] ?? match[2] ?? "", pageUrl);
    if (!url || !IMAGE_PATH.test(url) || seen.has(url)) continue;
    if (/\/(?:s_|thumb|mini)[^/]*$/i.test(new URL(url).pathname)) continue;
    seen.add(url);
    output.push({
      url,
      thumbnailUrl: null,
      attribution: "La Décadanse — fiche publique du lieu",
      license: null,
      licenseUrl: null,
      creator: null,
      sourceUrl: pageUrl,
      sourceProvider: "ladecadanse",
      isFallback: false,
    });
    if (output.length >= 12) break;
  }
  return output;
}

function website(html: string, pageUrl: string): string | null {
  const block = blockByClass(html, "li", "sitelieu");
  for (const match of block.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)) {
    const url = externalUrl(match[1] ?? match[2] ?? "", pageUrl);
    if (url && new URL(url).hostname !== "www.ladecadanse.ch") return url;
  }
  return null;
}

function openingHours(html: string): string | null {
  const practical = blockById(html, "div", "pratique");
  for (const match of practical.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const value = text(match[1], 500);
    if (
      /\b(?:lu|ma|me|je|ve|sa|di|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/i.test(
        value,
      ) && /\d{1,2}\s*(?:h|:)/i.test(value)
    ) {
      return value;
    }
  }
  return null;
}

export function parseLaDecadanseVenuePage(
  html: string,
  pageUrl: string,
  source: EventSourceContext,
): SourceVenueCandidate | null {
  const venueId = VENUE_PATH.exec(pathAndSearch(pageUrl))?.[1] ?? null;
  if (!venueId) return null;
  const name = text(blockByClass(html, "h1", "fn") || blockByClass(html, "h1", "org"), 240);
  const venueAddress = address(html);
  if (!name || !venueAddress) return null;
  const point = coordinates(html);
  const practical = blockById(html, "div", "pratique");
  const categoryLabel = text(/<li\b[^>]*>([\s\S]*?)<\/li>/i.exec(practical)?.[1] ?? "", 500);
  const classification = venueClassification(`${categoryLabel} ${name}`);
  const media = venueMedia(html, pageUrl);
  const officialWebsite = website(html, pageUrl);
  const sourceUrl = absoluteUrl(pageUrl, ORIGIN) ?? pageUrl;
  const descriptionBlock = blockById(html, "div", "descriptions");
  const description =
    text(descriptionBlock, 4_000) || text(meta(html, "name", "description") ?? "", 2_000) || null;
  const city = sourceCity(source);
  const hours = openingHours(html);
  const sourceUrls = [...new Set([sourceUrl, officialWebsite].filter((item): item is string => Boolean(item)))];
  return {
    sourceProvider: "ladecadanse",
    externalId: venueId,
    sourceUrl,
    name,
    category: classification.category,
    subcategory: classification.subcategory,
    description,
    address: venueAddress,
    postalCode: postalCode(venueAddress),
    city: city.name,
    countryCode: city.countryCode,
    latitude: point.latitude,
    longitude: point.longitude,
    website: officialWebsite,
    openingHours: hours,
    bookingUrl: null,
    imageUrls: media.map((item) => item.url),
    media,
    sourceUrls,
    contentSources: [
      { label: `La Décadanse — ${name}`, url: sourceUrl, provider: "ladecadanse" },
      ...(officialWebsite
        ? [{ label: `Site officiel — ${name}`, url: officialWebsite, provider: "official_website" }]
        : []),
    ],
    qualityScore: Math.min(
      100,
      65 +
        (description ? 8 : 0) +
        (officialWebsite ? 8 : 0) +
        (media.length ? 8 : 0) +
        (point.latitude == null ? 0 : 6) +
        (hours ? 5 : 0),
    ),
  };
}

export function parseLaDecadanseDocument(
  html: string,
  pageUrl: string,
  source: EventSourceContext,
): ParsedLaDecadanseDocument {
  const jobKind = kind(pageUrl);
  const events: EventCandidate[] = [];
  const venues: SourceVenueCandidate[] = [];
  if (jobKind === "event") {
    const parsed = parseLaDecadanseEventPage(html, pageUrl, source);
    if (parsed.event) events.push(parsed.event);
    if (parsed.venue) venues.push(parsed.venue);
  } else if (jobKind === "venue") {
    const venue = parseLaDecadanseVenuePage(html, pageUrl, source);
    if (venue) venues.push(venue);
  }
  return { events, venues, links: discoverLaDecadanseLinks(html, pageUrl) };
}
