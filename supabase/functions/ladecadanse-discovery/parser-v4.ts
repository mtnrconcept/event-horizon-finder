import type { EventSourceContext } from "../_shared/event-precision.ts";
import {
  discoverLaDecadanseLinks,
  parseLaDecadanseEventPage as parseEventPageV3,
  parseLaDecadanseVenuePage,
  type ParsedLaDecadanseDocument,
} from "./parser-v3.ts";

export type {
  LaDecadanseJobKind,
  LaDecadanseDiscoveredLink,
  SourceVenueCandidate,
  SourceVenueMedia,
  ParsedLaDecadanseDocument,
} from "./parser-v3.ts";
export { discoverLaDecadanseLinks, parseLaDecadanseVenuePage } from "./parser-v3.ts";

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function anchorText(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function reservationUrl(document: string, pageUrl: string): string | null {
  for (const match of document.matchAll(
    /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const label = anchorText(match[4] ?? "");
    if (!/billet|ticket|pr[ée]location|r[ée]server|reservation|inscription/i.test(label)) continue;
    try {
      const url = new URL(decodeEntities(match[1] ?? match[2] ?? match[3] ?? ""), pageUrl);
      if (!/^https?:$/.test(url.protocol)) continue;
      url.hash = "";
      return url.toString();
    } catch {
      // Ignore malformed optional reservation links.
    }
  }
  return null;
}

export function parseLaDecadanseEventPage(
  document: string,
  pageUrl: string,
  source: EventSourceContext,
): ReturnType<typeof parseEventPageV3> {
  const parsed = parseEventPageV3(document, pageUrl, source);
  if (parsed.event && !parsed.event.ticketUrl) {
    parsed.event.ticketUrl = reservationUrl(document, pageUrl);
  }
  return parsed;
}

export function parseLaDecadanseDocument(
  document: string,
  pageUrl: string,
  source: EventSourceContext,
): ParsedLaDecadanseDocument {
  const parsed: ParsedLaDecadanseDocument = {
    events: [],
    venues: [],
    links: discoverLaDecadanseLinks(document, pageUrl),
  };
  const path = `${new URL(pageUrl).pathname}${new URL(pageUrl).search}`;
  if (/^\/event\/evenement\.php\?idE=\d+$/i.test(path)) {
    const eventPage = parseLaDecadanseEventPage(document, pageUrl, source);
    if (eventPage.event) parsed.events.push(eventPage.event);
    if (eventPage.venue) parsed.venues.push(eventPage.venue);
  } else if (/^\/lieu\/lieu\.php\?idL=\d+$/i.test(path)) {
    const venue = parseLaDecadanseVenuePage(document, pageUrl, source);
    if (venue) parsed.venues.push(venue);
  }
  return parsed;
}
