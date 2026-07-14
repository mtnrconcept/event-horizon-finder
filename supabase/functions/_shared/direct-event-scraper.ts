import {
  cleanEventText,
  extractJsonLdCandidates,
  normalizeEventText,
  type EventCandidate,
  type EventSourceContext,
} from "./event-precision.ts";

export type DirectScrapeTask = {
  url: string;
  source: EventSourceContext;
};

export type DirectScrapeResult = {
  mode: "direct";
  rootHtml: string;
  candidates: EventCandidate[];
  metadata: {
    rootUrl: string;
    rootStatus: number;
    detailPagesAttempted: number;
    detailPagesFetched: number;
    detailPageErrors: string[];
    jsonLdCandidateCount: number;
    htmlCandidateCount: number;
  };
};

export type DirectScrapeOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  rootMaxBytes?: number;
  detailMaxBytes?: number;
  detailPageLimit?: number;
};

const EVENT_PATH_HINT =
  /(?:agenda|event|evenement|événement|programme|program|concert|festival|soiree|soirée|party|club|show|gig|spectacle|exposition|expo)/i;
const SKIP_PATH = /\.(?:avif|css|csv|gif|ico|jpe?g|js|json|pdf|png|svg|webp|xml|zip)(?:$|[?#])/i;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ROOT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_DETAIL_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_DETAIL_LIMIT = 10;

const MONTHS: Record<string, number> = {
  january: 1,
  janvier: 1,
  januar: 1,
  gennaio: 1,
  enero: 1,
  february: 2,
  fevrier: 2,
  februar: 2,
  febbraio: 2,
  febrero: 2,
  march: 3,
  mars: 3,
  marz: 3,
  marzo: 3,
  april: 4,
  avril: 4,
  aprile: 4,
  abril: 4,
  may: 5,
  mai: 5,
  maggio: 5,
  mayo: 5,
  june: 6,
  juin: 6,
  juni: 6,
  giugno: 6,
  junio: 6,
  july: 7,
  juillet: 7,
  juli: 7,
  luglio: 7,
  julio: 7,
  august: 8,
  aout: 8,
  agosto: 8,
  september: 9,
  septembre: 9,
  settembre: 9,
  septiembre: 9,
  october: 10,
  octobre: 10,
  oktober: 10,
  ottobre: 10,
  octubre: 10,
  november: 11,
  novembre: 11,
  noviembre: 11,
  december: 12,
  decembre: 12,
  dezember: 12,
  dicembre: 12,
  diciembre: 12,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagAttribute(tag: string, attribute: string): string {
  const name = escapeRegExp(attribute);
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return cleanEventText(match?.[1] ?? match?.[2] ?? match?.[3] ?? "", 2_000);
}

function metaContent(html: string, key: string, value: string): string {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (normalizeEventText(tagAttribute(match[0], key)) === normalizeEventText(value)) {
      return tagAttribute(match[0], "content");
    }
  }
  return "";
}

function firstTagText(html: string, tag: string, className?: string): string {
  const classExpression = className
    ? `(?=[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'])`
    : "";
  const match = new RegExp(`<${tag}\\b${classExpression}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(
    html,
  );
  return cleanEventText(match?.[1] ?? "", 500);
}

function labelledHtmlValue(html: string, labels: string[]): string {
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const strong = new RegExp(
      `<strong\\b[^>]*>\\s*${escaped}\\s*<\\/strong>\\s*(?::|&nbsp;|&#160;)*\\s*([^<]{1,240})`,
      "i",
    ).exec(html);
    if (strong?.[1]) return cleanEventText(strong[1], 240);

    const definition = new RegExp(
      `<(?:dt|th)\\b[^>]*>\\s*${escaped}\\s*<\\/(?:dt|th)>\\s*<(?:dd|td)\\b[^>]*>([\\s\\S]*?)<\\/(?:dd|td)>`,
      "i",
    ).exec(html);
    if (definition?.[1]) return cleanEventText(definition[1], 240);
  }
  return "";
}

function localizedDate(value: string): { year: number; month: number; day: number } | null {
  const normalized = normalizeEventText(value);
  const monthWords = Object.keys(MONTHS).join("|");
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:er|st|nd|rd|th)? (${monthWords}) (\\d{4})\\b`).exec(
    normalized,
  );
  const monthFirst = new RegExp(`\\b(${monthWords}) (\\d{1,2})(?:st|nd|rd|th)? (\\d{4})\\b`).exec(
    normalized,
  );
  const match = dayFirst ?? monthFirst;
  if (!match) return null;
  const day = Number(dayFirst ? match[1] : match[2]);
  const month = MONTHS[dayFirst ? match[2] : match[1]];
  const year = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 2000 ||
    year > 2100 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function isoCalendarDate(date: { year: number; month: number; day: number }): string {
  return `${date.year.toString().padStart(4, "0")}-${date.month
    .toString()
    .padStart(2, "0")}-${date.day.toString().padStart(2, "0")}`;
}

function clockRange(value: string): Array<{ hour: number; minute: number }> {
  const clocks: Array<{ hour: number; minute: number }> = [];
  for (const match of value.matchAll(/(?:^|[^\d])([01]?\d|2[0-3])\s*(?:h|:|\.)\s*([0-5]\d)?/gi)) {
    clocks.push({ hour: Number(match[1]), minute: Number(match[2] ?? 0) });
    if (clocks.length === 2) break;
  }
  return clocks;
}

function isoLocalDateTime(
  date: { year: number; month: number; day: number },
  clock: { hour: number; minute: number },
  addDay = false,
): string {
  const local = new Date(
    Date.UTC(date.year, date.month - 1, date.day + (addDay ? 1 : 0), clock.hour, clock.minute),
  );
  return `${local.getUTCFullYear().toString().padStart(4, "0")}-${(local.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}-${local.getUTCDate().toString().padStart(2, "0")}T${clock.hour
    .toString()
    .padStart(2, "0")}:${clock.minute.toString().padStart(2, "0")}:00`;
}

function extractedPrices(value: string): number[] {
  const prices: number[] = [];
  for (const match of value.matchAll(/\b(\d{1,5})(?:[.,](\d{1,2}))?\s*(?:chf|eur|€|\.-|,-)/gi)) {
    const amount = Number(`${match[1]}.${match[2] ?? "0"}`);
    if (Number.isFinite(amount) && amount >= 0 && amount <= 100_000) prices.push(amount);
  }
  return prices;
}

function ticketLink(html: string, pageUrl: string): string | null {
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const label = normalizeEventText(match[2]);
    if (!/(?:ticket|billet|billetterie|reserver|reservation|booking|buy tickets)/.test(label)) {
      continue;
    }
    const href = tagAttribute(match[0], "href");
    try {
      const url = new URL(href, pageUrl);
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
    } catch {
      // Ignore malformed ticket links.
    }
  }
  return null;
}

/**
 * Extract one event detail page without running arbitrary scripts or using an AI model.
 * A full calendar date is required so generic navigation cards cannot become events.
 */
export function extractHtmlEventCandidates(
  html: string,
  pageUrl: string,
  source: EventSourceContext,
): EventCandidate[] {
  const article = /<article\b[\s\S]*?<\/article>/i.exec(html)?.[0] ?? html;
  const title =
    firstTagText(article, "h1", "entry-title") ||
    firstTagText(article, "h1") ||
    metaContent(html, "property", "og:title");
  const rawDate = labelledHtmlValue(article, ["Date", "Datum", "Data", "Fecha"]);
  const date = localizedDate(rawDate);
  if (!title || !date) return [];

  const rawHours = labelledHtmlValue(article, [
    "Horaires",
    "Horaire",
    "Hours",
    "Hour",
    "Time",
    "Uhrzeit",
    "Orario",
    "Horario",
  ]);
  const clocks = clockRange(rawHours);
  const dateOnly = isoCalendarDate(date);
  const startDate = clocks[0] ? isoLocalDateTime(date, clocks[0]) : dateOnly;
  let endDate: string | null = null;
  if (clocks[0] && clocks[1]) {
    const rollsOver =
      clocks[1].hour < clocks[0].hour ||
      (clocks[1].hour === clocks[0].hour && clocks[1].minute <= clocks[0].minute);
    endDate = isoLocalDateTime(date, clocks[1], rollsOver);
  }

  const openingTag = /<article\b[^>]*>/i.exec(article)?.[0] ?? "";
  const externalId = /\bid\s*=\s*["']post-(\d+)["']/i.exec(openingTag)?.[1] ?? null;
  const className = tagAttribute(openingTag, "class");
  const genres = [...className.matchAll(/(?:^|\s)genre-([a-z0-9-]+)/gi)]
    .map((match) => match[1].replace(/-/g, " "))
    .filter((genre) => !/^(?:music|event|evenement)$/.test(genre));
  const rawTariffs = labelledHtmlValue(article, [
    "Tarifs",
    "Tarif",
    "Prices",
    "Price",
    "Preise",
    "Preis",
    "Prezzi",
    "Prezzo",
    "Precios",
    "Precio",
  ]);
  const prices = extractedPrices(rawTariffs);
  const freeForEveryone =
    /(?:entree gratuite|free entry|admission free|eintritt frei|ingresso gratuito|entrada gratuita)/i.test(
      normalizeEventText(rawTariffs),
    ) && !/(?:membre|member|mitglied|socio)/i.test(normalizeEventText(rawTariffs));
  const canonical =
    metaContent(html, "property", "og:url") ||
    tagAttribute(
      /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i.exec(html)?.[0] ?? "",
      "href",
    ) ||
    pageUrl;
  const language = tagAttribute(/<html\b[^>]*>/i.exec(html)?.[0] ?? "", "lang").slice(0, 2);
  const description = metaContent(html, "property", "og:description") || null;
  const imageUrl = metaContent(html, "property", "og:image") || null;
  const organizerUrl = new URL("/", pageUrl).toString();

  return [
    {
      externalId,
      title,
      description,
      startDate,
      endDate,
      timezone: source.city?.timezone ?? null,
      timePrecision: clocks[0] ? "exact" : "date",
      allDay: false,
      venueName: source.name,
      city: source.city?.name ?? null,
      countryCode: source.city?.country?.code ?? null,
      organizerName: source.name,
      organizerUrl,
      language: language || null,
      category: source.category_slug,
      genres,
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
      currency: source.city?.country?.code === "CH" ? "CHF" : null,
      ticketUrl: ticketLink(article, pageUrl),
      imageUrl,
      isFree: freeForEveryone,
      sourceUrl: canonical,
      extractionMethod: "html",
    },
  ];
}

function normalizedHost(value: string): string {
  return value
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

function sourceHost(source: EventSourceContext, fallbackUrl: string): string {
  const configured = normalizedHost(source.domain || "");
  if (configured) return configured;
  try {
    return normalizedHost(new URL(fallbackUrl).hostname);
  } catch {
    return "";
  }
}

function hostMatches(candidate: string, source: EventSourceContext, fallbackUrl: string): boolean {
  try {
    const host = normalizedHost(new URL(candidate).hostname);
    const expected = sourceHost(source, fallbackUrl);
    return Boolean(
      host &&
      expected &&
      (host === expected || host.endsWith(`.${expected}`) || expected.endsWith(`.${host}`)),
    );
  } catch {
    return false;
  }
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function assertPublicSourceUrl(
  value: string,
  source: EventSourceContext,
  fallbackUrl: string,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value, fallbackUrl);
  } catch {
    throw new Error("direct_invalid_url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("direct_invalid_protocol");
  }
  const host = normalizedHost(parsed.hostname);
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1" ||
    host === "[::1]" ||
    isPrivateIpv4(host)
  ) {
    throw new Error("direct_private_host_blocked");
  }
  if (!hostMatches(parsed.toString(), source, fallbackUrl)) {
    throw new Error("direct_off_domain_url");
  }
  parsed.hash = "";
  return parsed;
}

async function limitedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel("response_too_large");
      throw new Error("direct_response_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function fetchHtml(
  value: string,
  source: EventSourceContext,
  fallbackUrl: string,
  fetcher: typeof fetch,
  timeoutMs: number,
  maximumBytes: number,
): Promise<{ html: string; url: string; status: number }> {
  const url = assertPublicSourceUrl(value, source, fallbackUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5",
        "Accept-Language": "fr,en;q=0.8",
        "User-Agent":
          "EVENTA-Direct-Event-Collector/2.0 (+https://github.com/mtnrconcept/event-horizon-finder)",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`direct_http_${response.status}`);
    const finalUrl = response.url || url.toString();
    assertPublicSourceUrl(finalUrl, source, fallbackUrl);
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml") &&
      !contentType.includes("text/plain")
    ) {
      throw new Error(`direct_unsupported_content_type:${contentType.slice(0, 80)}`);
    }
    const html = await limitedText(response, maximumBytes);
    if (!html.trim()) throw new Error("direct_empty_response");
    return { html, url: finalUrl, status: response.status };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("direct_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function discoverDirectEventLinks(
  html: string,
  pageUrl: string,
  source: EventSourceContext,
  limit = DEFAULT_DETAIL_LIMIT,
): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const links = html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi);
  for (const match of links) {
    const href = (match[1] ?? match[2] ?? match[3] ?? "").replace(/&amp;/gi, "&").trim();
    if (!href || href.startsWith("#") || /^(?:mailto|tel|javascript):/i.test(href)) continue;
    try {
      const candidate = assertPublicSourceUrl(href, source, pageUrl);
      const canonical = candidate.toString();
      if (
        canonical === pageUrl ||
        seen.has(canonical) ||
        SKIP_PATH.test(candidate.pathname) ||
        !EVENT_PATH_HINT.test(candidate.pathname)
      ) {
        continue;
      }
      seen.add(canonical);
      output.push(canonical);
      if (output.length >= Math.max(0, Math.min(limit, 20))) break;
    } catch {
      // Ignore malformed, private and off-domain links discovered in page markup.
    }
  }
  return output;
}

function configuredDetailLimit(source: EventSourceContext, override?: number): number {
  const metadataValue = source.metadata?.direct_detail_limit;
  const parsedOverride = Number.isFinite(override) ? Math.trunc(override as number) : null;
  const parsedMetadata = Number.parseInt(String(metadataValue ?? ""), 10);
  const selected =
    parsedOverride ?? (Number.isFinite(parsedMetadata) ? parsedMetadata : DEFAULT_DETAIL_LIMIT);
  return Math.max(0, Math.min(selected, 20));
}

export async function scrapeDirectEventSource(
  task: DirectScrapeTask,
  options: DirectScrapeOptions = {},
): Promise<DirectScrapeResult> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const root = await fetchHtml(
    task.url,
    task.source,
    task.url,
    fetcher,
    timeoutMs,
    options.rootMaxBytes ?? DEFAULT_ROOT_MAX_BYTES,
  );
  const rootJsonLd = extractJsonLdCandidates(root.html, root.url, task.source);
  const rootHtmlCandidates = extractHtmlEventCandidates(root.html, root.url, task.source);
  const candidates = [...rootJsonLd, ...rootHtmlCandidates];
  let jsonLdCandidateCount = rootJsonLd.length;
  let htmlCandidateCount = rootHtmlCandidates.length;
  const detailErrors: string[] = [];
  let fetched = 0;
  const detailLinks =
    candidates.length >= 2
      ? []
      : discoverDirectEventLinks(
          root.html,
          root.url,
          task.source,
          configuredDetailLimit(task.source, options.detailPageLimit),
        );

  for (let offset = 0; offset < detailLinks.length; offset += 3) {
    const group = detailLinks.slice(offset, offset + 3);
    const results = await Promise.allSettled(
      group.map((url) =>
        fetchHtml(
          url,
          task.source,
          root.url,
          fetcher,
          timeoutMs,
          options.detailMaxBytes ?? DEFAULT_DETAIL_MAX_BYTES,
        ),
      ),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        fetched += 1;
        const jsonLd = extractJsonLdCandidates(result.value.html, result.value.url, task.source);
        const htmlEvents = extractHtmlEventCandidates(
          result.value.html,
          result.value.url,
          task.source,
        );
        jsonLdCandidateCount += jsonLd.length;
        htmlCandidateCount += htmlEvents.length;
        candidates.push(...jsonLd, ...htmlEvents);
      } else if (detailErrors.length < 8) {
        const message =
          result.reason instanceof Error ? result.reason.message : "direct_detail_failed";
        detailErrors.push(`${group[index]}: ${message}`.slice(0, 500));
      }
    });
  }

  return {
    mode: "direct",
    rootHtml: root.html,
    candidates,
    metadata: {
      rootUrl: root.url,
      rootStatus: root.status,
      detailPagesAttempted: detailLinks.length,
      detailPagesFetched: fetched,
      detailPageErrors: detailErrors,
      jsonLdCandidateCount,
      htmlCandidateCount,
    },
  };
}
