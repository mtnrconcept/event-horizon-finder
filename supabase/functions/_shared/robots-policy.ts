import { canonicalizeHttpUrl } from "./global-discovery.ts";

export const MAX_ROBOTS_CACHE_AGE_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_ROBOTS_CACHE_AGE_MS = 6 * 60 * 60 * 1_000;
export const ERROR_ROBOTS_CACHE_AGE_MS = 15 * 60 * 1_000;
export const MAX_ROBOTS_TEXT_LENGTH = 512_000;

export type RobotsRule = {
  directive: "allow" | "disallow";
  pattern: string;
  specificity: number;
  line: number;
};

export type RobotsGroup = {
  userAgents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
};

export type ParsedRobotsTxt = {
  groups: RobotsGroup[];
  sitemaps: string[];
};

export type RobotsPolicyDecision = {
  allowed: boolean;
  matchedRule: RobotsRule | null;
  matchedUserAgent: string | null;
  crawlDelaySeconds: number | null;
};

export type RobotsCacheMetadataInput = {
  pageUrl: string;
  fetchedAt?: Date | string;
  httpStatus: number;
  cacheControl?: string | null;
  etag?: string | null;
  lastModified?: string | null;
};

export type RobotsCacheMetadata = {
  robotsUrl: string;
  fetchedAt: string;
  expiresAt: string;
  httpStatus: number;
  etag: string | null;
  lastModified: string | null;
};

export function robotsUrlFor(pageUrl: string): string | null {
  const canonicalUrl = canonicalizeHttpUrl(pageUrl);
  if (!canonicalUrl) return null;
  return new URL("/robots.txt", new URL(canonicalUrl).origin).toString();
}

export function parseRobotsTxt(text: string): ParsedRobotsTxt {
  const source = text.replace(/^\uFEFF/, "").slice(0, MAX_ROBOTS_TEXT_LENGTH);
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let hasDirective = false;

  const pushCurrent = () => {
    if (current?.userAgents.length) groups.push(current);
    current = null;
    hasDirective = false;
  };

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator < 0) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "sitemap") {
      if (value && !sitemaps.includes(value)) sitemaps.push(value);
      continue;
    }

    if (field === "user-agent") {
      const userAgent = value.toLowerCase();
      if (!userAgent) continue;
      if (current && hasDirective) pushCurrent();
      current ??= { userAgents: [], rules: [], crawlDelaySeconds: null };
      if (!current.userAgents.includes(userAgent)) current.userAgents.push(userAgent);
      continue;
    }

    if (!current?.userAgents.length) continue;

    if (field === "allow" || field === "disallow") {
      hasDirective = true;
      // RFC 9309 defines an empty rule as matching nothing. Ignoring it avoids
      // accidentally turning `Disallow:` into a site-wide block.
      if (!value) continue;
      const pattern = normalizeRobotsOctets(value);
      current.rules.push({
        directive: field,
        pattern,
        specificity: robotsRuleSpecificity(pattern),
        line: index + 1,
      });
      continue;
    }

    if (field === "crawl-delay") {
      hasDirective = true;
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400) {
        current.crawlDelaySeconds = seconds;
      }
    }
  }

  pushCurrent();
  return { groups, sitemaps };
}

export function evaluateRobotsPolicy(
  robots: ParsedRobotsTxt,
  pageUrl: string,
  userAgent: string,
): RobotsPolicyDecision {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return {
      allowed: false,
      matchedRule: null,
      matchedUserAgent: null,
      crawlDelaySeconds: null,
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      allowed: false,
      matchedRule: null,
      matchedUserAgent: null,
      crawlDelaySeconds: null,
    };
  }

  const selected = selectMatchingGroups(robots.groups, userAgent);
  if (!selected.length) {
    return {
      allowed: true,
      matchedRule: null,
      matchedUserAgent: null,
      crawlDelaySeconds: null,
    };
  }

  const target = normalizeRobotsOctets(`${url.pathname}${url.search}`);
  let matchedRule: RobotsRule | null = null;

  for (const match of selected) {
    for (const rule of match.group.rules) {
      if (!robotsRuleMatches(rule.pattern, target)) continue;
      if (
        !matchedRule ||
        rule.specificity > matchedRule.specificity ||
        (rule.specificity === matchedRule.specificity &&
          rule.directive === "allow" &&
          matchedRule.directive === "disallow")
      ) {
        matchedRule = rule;
      }
    }
  }

  const delays = selected
    .map(({ group }) => group.crawlDelaySeconds)
    .filter((delay): delay is number => typeof delay === "number");

  return {
    allowed: matchedRule?.directive !== "disallow",
    matchedRule,
    matchedUserAgent: selected[0].agent,
    crawlDelaySeconds: delays.length ? Math.max(...delays) : null,
  };
}

export function createRobotsCacheMetadata(
  input: RobotsCacheMetadataInput,
): RobotsCacheMetadata | null {
  const robotsUrl = robotsUrlFor(input.pageUrl);
  if (!robotsUrl) return null;

  const fetchedAt = parseDate(input.fetchedAt ?? new Date());
  if (!fetchedAt) return null;

  const status = Number.isInteger(input.httpStatus) ? input.httpStatus : 0;
  const defaultAge =
    status >= 500 || status === 0
      ? ERROR_ROBOTS_CACHE_AGE_MS
      : status === 404 || status === 410
        ? MAX_ROBOTS_CACHE_AGE_MS
        : DEFAULT_ROBOTS_CACHE_AGE_MS;
  const advertisedAge = parseMaxAge(input.cacheControl);
  const cacheAge = Math.min(MAX_ROBOTS_CACHE_AGE_MS, Math.max(0, advertisedAge ?? defaultAge));

  return {
    robotsUrl,
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: new Date(fetchedAt.getTime() + cacheAge).toISOString(),
    httpStatus: status,
    etag: cleanHeader(input.etag),
    lastModified: cleanHeader(input.lastModified),
  };
}

export function isRobotsCacheFresh(
  metadata: Pick<RobotsCacheMetadata, "expiresAt"> | null | undefined,
  now: Date | string = new Date(),
): boolean {
  if (!metadata) return false;
  const expiresAt = parseDate(metadata.expiresAt);
  const reference = parseDate(now);
  return Boolean(expiresAt && reference && expiresAt.getTime() > reference.getTime());
}

type SelectedGroup = {
  group: RobotsGroup;
  agent: string;
  specificity: number;
};

function selectMatchingGroups(groups: RobotsGroup[], userAgent: string): SelectedGroup[] {
  const normalizedUserAgent = userAgent.trim().toLowerCase();
  const matches: SelectedGroup[] = [];

  for (const group of groups) {
    let bestAgent: string | null = null;
    let specificity = -1;

    for (const candidate of group.userAgents) {
      const candidateSpecificity =
        candidate === "*" ? 0 : normalizedUserAgent.includes(candidate) ? candidate.length : -1;
      if (candidateSpecificity > specificity) {
        bestAgent = candidate;
        specificity = candidateSpecificity;
      }
    }

    if (bestAgent !== null) matches.push({ group, agent: bestAgent, specificity });
  }

  if (!matches.length) return [];
  const maximumSpecificity = Math.max(...matches.map((match) => match.specificity));
  return matches.filter((match) => match.specificity === maximumSpecificity);
}

function robotsRuleMatches(pattern: string, target: string): boolean {
  const endAnchored = pattern.endsWith("$");
  const body = endAnchored ? pattern.slice(0, -1) : pattern;
  const expression = body.split("*").map(escapeRegularExpression).join(".*");
  return new RegExp(`^${expression}${endAnchored ? "$" : ""}`).test(target);
}

function robotsRuleSpecificity(pattern: string): number {
  const body = (pattern.endsWith("$") ? pattern.slice(0, -1) : pattern).replace(/\*/g, "");
  let octets = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (/^[\da-f]{2}$/i.test(body.slice(index + 1, index + 3)) && body[index] === "%") {
      octets += 1;
      index += 2;
    } else {
      octets += 1;
    }
  }
  return octets;
}

function normalizeRobotsOctets(value: string): string {
  const encodedUnicode = [...value]
    .map((character) =>
      character.codePointAt(0)! > 0x7f ? encodeURIComponent(character) : character,
    )
    .join("");

  return encodedUnicode.replace(/%[\da-f]{2}/gi, (encoded) => {
    const byte = Number.parseInt(encoded.slice(1), 16);
    const character = String.fromCharCode(byte);
    return /^[A-Z\d._~-]$/i.test(character) ? character : encoded.toUpperCase();
  });
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseMaxAge(cacheControl: string | null | undefined): number | null {
  if (!cacheControl) return null;
  if (/(?:^|,)\s*(?:no-store|no-cache)\s*(?:,|$)/i.test(cacheControl)) return 0;
  const match = cacheControl.match(/(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*"?(\d+)"?/i);
  if (!match) return null;
  const seconds = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
}

function parseDate(value: Date | string): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function cleanHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\r\n]/g, "").trim();
  return cleaned || null;
}
