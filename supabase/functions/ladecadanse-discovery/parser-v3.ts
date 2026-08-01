import type { EventSourceContext } from "../_shared/event-precision.ts";
import {
  discoverLaDecadanseLinks as discoverHtmlLinks,
  parseLaDecadanseEventPage,
  parseLaDecadanseVenuePage,
  type LaDecadanseDiscoveredLink,
  type ParsedLaDecadanseDocument,
} from "./parser-v2.ts";

export type {
  LaDecadanseJobKind,
  LaDecadanseDiscoveredLink,
  SourceVenueCandidate,
  SourceVenueMedia,
  ParsedLaDecadanseDocument,
} from "./parser-v2.ts";
export { parseLaDecadanseEventPage, parseLaDecadanseVenuePage } from "./parser-v2.ts";

function canonicalEventUrl(value: string, pageUrl: string): string | null {
  try {
    const url = new URL(value.replaceAll("&amp;", "&").trim(), pageUrl);
    if (url.hostname === "ladecadanse.ch") url.hostname = "www.ladecadanse.ch";
    if (url.hostname !== "www.ladecadanse.ch" || url.protocol !== "https:") return null;
    url.hash = "";
    return /^\/event\/evenement\.php\?idE=\d+$/i.test(`${url.pathname}${url.search}`)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function discoverLaDecadanseLinks(
  document: string,
  pageUrl: string,
): LaDecadanseDiscoveredLink[] {
  const output = new Map(
    discoverHtmlLinks(document, pageUrl).map((link) => [link.url, link] as const),
  );
  for (const match of document.matchAll(/<link\b[^>]*>([\s\S]*?)<\/link>/gi)) {
    const url = canonicalEventUrl(match[1] ?? "", pageUrl);
    if (!url) continue;
    output.set(url, {
      url,
      kind: "event",
      priority: 90,
      refreshAfterSeconds: 43_200,
    });
  }
  for (const match of document.matchAll(/\bhttps:\/\/www\.ladecadanse\.ch\/event\/evenement\.php\?idE=\d+/gi)) {
    const url = canonicalEventUrl(match[0], pageUrl);
    if (!url) continue;
    output.set(url, {
      url,
      kind: "event",
      priority: 90,
      refreshAfterSeconds: 43_200,
    });
  }
  return [...output.values()];
}

export function parseLaDecadanseDocument(
  document: string,
  pageUrl: string,
  source: EventSourceContext,
): ParsedLaDecadanseDocument {
  const path = `${new URL(pageUrl).pathname}${new URL(pageUrl).search}`;
  const events: ParsedLaDecadanseDocument["events"] = [];
  const venues: ParsedLaDecadanseDocument["venues"] = [];
  if (/^\/event\/evenement\.php\?idE=\d+$/i.test(path)) {
    const parsed = parseLaDecadanseEventPage(document, pageUrl, source);
    if (parsed.event) events.push(parsed.event);
    if (parsed.venue) venues.push(parsed.venue);
  } else if (/^\/lieu\/lieu\.php\?idL=\d+$/i.test(path)) {
    const venue = parseLaDecadanseVenuePage(document, pageUrl, source);
    if (venue) venues.push(venue);
  }
  return { events, venues, links: discoverLaDecadanseLinks(document, pageUrl) };
}
