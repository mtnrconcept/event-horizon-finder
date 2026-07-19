export const MAX_SEARCH_RESULTS_PER_QUERY = 10;

export type DiscoveryQueryFamily = "nightlife" | "family" | "outdoor" | "culture";

export type DiscoveryQuery = {
  family: DiscoveryQueryFamily;
  query: string;
  locale: string;
  dateScope: "day" | "month";
  dateKey: string;
  monthKey: string;
};

export type BuildDiscoveryQueriesInput = {
  cityName: string;
  countryName?: string | null;
  date: Date | string;
  locale?: string | null;
  /** Number of consecutive daily nightlife searches, starting at `date`. */
  nightlifeDays?: number;
};

export type BuildMultilingualDiscoveryQueriesInput = Omit<
  BuildDiscoveryQueriesInput,
  "locale" | "nightlifeDays"
> & {
  locales: Array<string | null | undefined>;
  primaryNightlifeDays?: number;
  maxQueries?: number;
};

export type PopulationCity = {
  name: string;
  population?: number | null;
};

export type SearxngResult = {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  engine?: unknown;
  engines?: unknown;
  score?: unknown;
  publishedDate?: unknown;
  published_date?: unknown;
  thumbnail?: unknown;
  img_src?: unknown;
};

export type NormalizedSearchResult = {
  rank: number;
  sourceRank: number;
  url: string;
  domain: string;
  title: string | null;
  snippet: string | null;
  engines: string[];
  score: number | null;
  publishedAt: string | null;
  thumbnailUrl: string | null;
};

export type NormalizeSearxngOptions = {
  limit?: number;
};

/**
 * National-population tiers intentionally grow sub-linearly. Even very large
 * countries are capped at 50 cities per discovery cycle, while microstates
 * still receive one target city.
 */
export const CITY_LIMIT_TIERS = Object.freeze([
  { minimumPopulation: 0, cityLimit: 1 },
  { minimumPopulation: 100_000, cityLimit: 3 },
  { minimumPopulation: 1_000_000, cityLimit: 8 },
  { minimumPopulation: 5_000_000, cityLimit: 15 },
  { minimumPopulation: 20_000_000, cityLimit: 25 },
  { minimumPopulation: 50_000_000, cityLimit: 40 },
  { minimumPopulation: 100_000_000, cityLimit: 50 },
] as const);

const TRACKING_PARAMETERS = new Set([
  "_ga",
  "dclid",
  "fbclid",
  "gbraid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "wbraid",
  "yclid",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".home",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".onion",
  ".test",
];

type QueryDateContext = {
  place: string;
  day: number;
  month: string;
  year: number;
};

type QueryTemplateSet = Record<DiscoveryQueryFamily, (context: QueryDateContext) => string>;

const QUERY_TEMPLATES: Record<string, QueryTemplateSet> = {
  fr: {
    nightlife: ({ place, day, month, year }) => `Agenda soirées ${place} ${day} ${month} ${year}`,
    family: ({ place, month, year }) => `Agenda sorties en famille à ${place} ${month} ${year}`,
    outdoor: ({ place, month, year }) => `Activités de plein air à ${place} ${month} ${year}`,
    culture: ({ place, month, year }) => `Agenda culturel ${place} ${month} ${year}`,
  },
  en: {
    nightlife: ({ place, day, month, year }) => `Nightlife events ${place} ${month} ${day} ${year}`,
    family: ({ place, month, year }) => `Family events ${place} ${month} ${year}`,
    outdoor: ({ place, month, year }) => `Outdoor activities ${place} ${month} ${year}`,
    culture: ({ place, month, year }) => `Cultural events ${place} ${month} ${year}`,
  },
  de: {
    nightlife: ({ place, day, month, year }) =>
      `Veranstaltungskalender Nachtleben ${place} ${day}. ${month} ${year}`,
    family: ({ place, month, year }) => `Familienveranstaltungen ${place} ${month} ${year}`,
    outdoor: ({ place, month, year }) => `Outdoor-Aktivitäten ${place} ${month} ${year}`,
    culture: ({ place, month, year }) => `Kulturveranstaltungen ${place} ${month} ${year}`,
  },
  es: {
    nightlife: ({ place, day, month, year }) => `Agenda nocturna ${place} ${day} ${month} ${year}`,
    family: ({ place, month, year }) => `Agenda familiar ${place} ${month} ${year}`,
    outdoor: ({ place, month, year }) => `Actividades al aire libre ${place} ${month} ${year}`,
    culture: ({ place, month, year }) => `Agenda cultural ${place} ${month} ${year}`,
  },
  it: {
    nightlife: ({ place, day, month, year }) => `Agenda serate ${place} ${day} ${month} ${year}`,
    family: ({ place, month, year }) => `Eventi per famiglie ${place} ${month} ${year}`,
    outdoor: ({ place, month, year }) => `Attività all'aperto ${place} ${month} ${year}`,
    culture: ({ place, month, year }) => `Agenda culturale ${place} ${month} ${year}`,
  },
  pt: {
    nightlife: ({ place, day, month, year }) => `Agenda noturna ${place} ${day} ${month} ${year}`,
    family: ({ place, month, year }) => `Eventos para famílias ${place} ${month} ${year}`,
    outdoor: ({ place, month, year }) => `Atividades ao ar livre ${place} ${month} ${year}`,
    culture: ({ place, month, year }) => `Agenda cultural ${place} ${month} ${year}`,
  },
  nl: {
    nightlife: ({ place, day, month, year }) => `Uitgaansagenda ${place} ${day} ${month} ${year}`,
    family: ({ place, month, year }) => `Familie-uitjes ${place} ${month} ${year}`,
    outdoor: ({ place, month, year }) => `Buitenactiviteiten ${place} ${month} ${year}`,
    culture: ({ place, month, year }) => `Culturele agenda ${place} ${month} ${year}`,
  },
  pl: {
    nightlife: ({ place, day, month, year }) => `Kalendarz imprez ${place} ${day} ${month} ${year}`,
    family: ({ place, month, year }) => `Wydarzenia rodzinne ${place} ${month} ${year}`,
    outdoor: ({ place, month, year }) => `Atrakcje na świeżym powietrzu ${place} ${month} ${year}`,
    culture: ({ place, month, year }) => `Kalendarz kulturalny ${place} ${month} ${year}`,
  },
  ru: {
    nightlife: ({ place, day, month, year }) => `Афиша вечеринок ${place} ${day} ${month} ${year}`,
    family: ({ place, month, year }) => `Семейные мероприятия ${place} ${month} ${year}`,
    outdoor: ({ place, month, year }) => `Активный отдых ${place} ${month} ${year}`,
    culture: ({ place, month, year }) => `Культурная афиша ${place} ${month} ${year}`,
  },
  tr: {
    nightlife: ({ place, day, month, year }) =>
      `${place} gece hayatı etkinlikleri ${day} ${month} ${year}`,
    family: ({ place, month, year }) => `${place} aile etkinlikleri ${month} ${year}`,
    outdoor: ({ place, month, year }) => `${place} açık hava etkinlikleri ${month} ${year}`,
    culture: ({ place, month, year }) => `${place} kültür sanat etkinlikleri ${month} ${year}`,
  },
  id: {
    nightlife: ({ place, day, month, year }) =>
      `Agenda hiburan malam ${place} ${day} ${month} ${year}`,
    family: ({ place, month, year }) => `Acara keluarga ${place} ${month} ${year}`,
    outdoor: ({ place, month, year }) => `Aktivitas luar ruangan ${place} ${month} ${year}`,
    culture: ({ place, month, year }) => `Agenda budaya ${place} ${month} ${year}`,
  },
  ar: {
    nightlife: ({ place, day, month, year }) => `فعاليات ليلية ${place} ${day} ${month} ${year}`,
    family: ({ place, month, year }) => `فعاليات عائلية ${place} ${month} ${year}`,
    outdoor: ({ place, month, year }) => `أنشطة في الهواء الطلق ${place} ${month} ${year}`,
    culture: ({ place, month, year }) => `الأجندة الثقافية ${place} ${month} ${year}`,
  },
  hi: {
    nightlife: ({ place, day, month, year }) =>
      `${place} नाइटलाइफ कार्यक्रम ${day} ${month} ${year}`,
    family: ({ place, month, year }) => `${place} पारिवारिक कार्यक्रम ${month} ${year}`,
    outdoor: ({ place, month, year }) => `${place} आउटडोर गतिविधियाँ ${month} ${year}`,
    culture: ({ place, month, year }) => `${place} सांस्कृतिक कार्यक्रम ${month} ${year}`,
  },
  ja: {
    nightlife: ({ place, day, month, year }) =>
      `${place} ナイトライフ イベント ${year}年${month}${day}日`,
    family: ({ place, month, year }) => `${place} 家族向けイベント ${year}年${month}`,
    outdoor: ({ place, month, year }) => `${place} アウトドア イベント ${year}年${month}`,
    culture: ({ place, month, year }) => `${place} 文化イベント ${year}年${month}`,
  },
  ko: {
    nightlife: ({ place, day, month, year }) =>
      `${place} 나이트라이프 행사 ${year}년 ${month} ${day}일`,
    family: ({ place, month, year }) => `${place} 가족 행사 ${year}년 ${month}`,
    outdoor: ({ place, month, year }) => `${place} 야외 활동 ${year}년 ${month}`,
    culture: ({ place, month, year }) => `${place} 문화 행사 ${year}년 ${month}`,
  },
  zh: {
    nightlife: ({ place, day, month, year }) => `${place} 夜生活活动 ${year}年${month}${day}日`,
    family: ({ place, month, year }) => `${place} 亲子活动 ${year}年${month}`,
    outdoor: ({ place, month, year }) => `${place} 户外活动 ${year}年${month}`,
    culture: ({ place, month, year }) => `${place} 文化活动 ${year}年${month}`,
  },
};

const MONTHLY_QUERY_FAMILIES: DiscoveryQueryFamily[] = ["family", "outdoor", "culture"];

export function selectAdaptiveCityLimit(
  countryPopulation: number | null | undefined,
  availableCityCount?: number | null,
): number {
  const population =
    typeof countryPopulation === "number" && Number.isFinite(countryPopulation)
      ? Math.max(0, Math.floor(countryPopulation))
      : 0;

  let target: number = CITY_LIMIT_TIERS[0].cityLimit;
  for (const tier of CITY_LIMIT_TIERS) {
    if (population < tier.minimumPopulation) break;
    target = tier.cityLimit;
  }

  if (typeof availableCityCount !== "number" || !Number.isFinite(availableCityCount)) {
    return target;
  }

  return Math.min(target, Math.max(0, Math.floor(availableCityCount)));
}

export function selectLargestCities<T extends PopulationCity>(
  cities: readonly T[],
  countryPopulation: number | null | undefined,
): T[] {
  const target = selectAdaptiveCityLimit(countryPopulation, cities.length);

  return cities
    .map((city, index) => ({ city, index }))
    .sort((left, right) => {
      const leftPopulation = validPopulation(left.city.population);
      const rightPopulation = validPopulation(right.city.population);
      if (leftPopulation !== rightPopulation) return rightPopulation - leftPopulation;

      const byName = left.city.name.localeCompare(right.city.name, "en", {
        sensitivity: "base",
      });
      return byName || left.index - right.index;
    })
    .slice(0, target)
    .map(({ city }) => city);
}

export function buildLocalizedDiscoveryQueries(
  input: BuildDiscoveryQueriesInput,
): DiscoveryQuery[] {
  const cityName = cleanInlineText(input.cityName);
  if (!cityName) throw new TypeError("discovery_city_required");

  const countryName = cleanInlineText(input.countryName ?? "");
  const place = countryName ? `${cityName}, ${countryName}` : cityName;
  const date = parseDiscoveryDate(input.date);
  const requestedLocale = normalizeLocale(input.locale);
  const language = requestedLocale.split("-")[0];
  const templateLanguage = QUERY_TEMPLATES[language] ? language : "en";
  const locale = templateLanguage === language ? requestedLocale : "en";
  const templates = QUERY_TEMPLATES[templateLanguage];
  const requestedNightlifeDays = input.nightlifeDays ?? 1;
  if (
    !Number.isInteger(requestedNightlifeDays) ||
    requestedNightlifeDays < 1 ||
    requestedNightlifeDays > 31
  ) {
    throw new TypeError("discovery_nightlife_days_invalid");
  }

  const dailyDates = Array.from({ length: requestedNightlifeDays }, (_, offset) =>
    addUtcDays(date, offset),
  );
  const dailyQueries = dailyDates.map((dailyDate): DiscoveryQuery => {
    const { context, dateKey, monthKey } = queryDateContext(dailyDate, locale, place);
    return {
      family: "nightlife",
      query: templates.nightlife(context),
      locale,
      dateScope: "day",
      dateKey,
      monthKey,
    };
  });

  // A seven-day window can cross a month boundary. Generate the three broad
  // monthly families for every month touched so no family/outdoor/culture gap
  // is introduced around the last days of a month.
  const monthlyDates = new Map<string, Date>();
  for (const dailyDate of dailyDates) {
    const monthKey = dailyDate.toISOString().slice(0, 7);
    if (!monthlyDates.has(monthKey)) monthlyDates.set(monthKey, dailyDate);
  }
  const monthlyQueries = [...monthlyDates.values()].flatMap((monthlyDate) => {
    const { context, dateKey, monthKey } = queryDateContext(monthlyDate, locale, place);
    return MONTHLY_QUERY_FAMILIES.map((family): DiscoveryQuery => ({
      family,
      query: templates[family](context),
      locale,
      dateScope: "month",
      dateKey,
      monthKey,
    }));
  });

  return [...dailyQueries, ...monthlyQueries];
}

export function buildMultilingualDiscoveryQueries(
  input: BuildMultilingualDiscoveryQueriesInput,
): DiscoveryQuery[] {
  const maximum = input.maxQueries ?? 16;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 64) {
    throw new TypeError("discovery_query_budget_invalid");
  }
  const locales = [...new Set(input.locales.map(normalizeLocale))];
  if (!locales.length) locales.push("en");

  const output: DiscoveryQuery[] = [];
  const seen = new Set<string>();
  const append = (queries: DiscoveryQuery[]) => {
    for (const query of queries) {
      const key = `${query.locale}|${query.family}|${query.query.toLocaleLowerCase(query.locale)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(query);
      if (output.length >= maximum) return;
    }
  };

  append(
    buildLocalizedDiscoveryQueries({
      ...input,
      locale: locales[0],
      nightlifeDays: input.primaryNightlifeDays ?? 7,
    }),
  );
  for (const locale of locales.slice(1)) {
    if (output.length >= maximum) break;
    const supplemental = buildLocalizedDiscoveryQueries({
      ...input,
      locale,
      nightlifeDays: 1,
    });
    const priority: Record<DiscoveryQueryFamily, number> = {
      nightlife: 0,
      culture: 1,
      family: 2,
      outdoor: 3,
    };
    append([...supplemental].sort((left, right) => priority[left.family] - priority[right.family]));
  }
  return output.slice(0, maximum);
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function queryDateContext(
  date: Date,
  locale: string,
  place: string,
): { context: QueryDateContext; dateKey: string; monthKey: string } {
  const year = date.getUTCFullYear();
  const day = date.getUTCDate();
  const month = formatMonth(date, locale);
  const dateKey = `${year}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return {
    context: { place, day, month, year },
    dateKey,
    monthKey: dateKey.slice(0, 7),
  };
}

/**
 * Canonicalizes only public-looking HTTP(S) URLs. This lexical guard does not
 * replace a DNS/IP check immediately before a crawler performs its request.
 */
export function canonicalizeHttpUrl(rawUrl: unknown, baseUrl?: string): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!isPublicLookingHostname(hostname)) return null;
  if (!hostname.startsWith("[")) url.hostname = hostname;

  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith("utm_") || TRACKING_PARAMETERS.has(normalizedKey)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();

  return url.toString();
}

export function searchResultDomain(url: string): string | null {
  const canonicalUrl = canonicalizeHttpUrl(url);
  if (!canonicalUrl) return null;
  const hostname = new URL(canonicalUrl).hostname.toLowerCase().replace(/\.$/, "");
  return hostname.replace(/^www\d*\./, "");
}

export function normalizeSearxngResults(
  payload: unknown,
  options: NormalizeSearxngOptions = {},
): NormalizedSearchResult[] {
  const rawResults = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
  const requestedLimit = Number.isFinite(options.limit)
    ? Math.floor(options.limit as number)
    : MAX_SEARCH_RESULTS_PER_QUERY;
  const limit = Math.max(0, Math.min(MAX_SEARCH_RESULTS_PER_QUERY, requestedLimit));
  if (limit === 0) return [];

  const normalized: NormalizedSearchResult[] = [];
  const seenDomains = new Set<string>();

  for (let index = 0; index < rawResults.length && normalized.length < limit; index += 1) {
    const result = rawResults[index];
    if (!isRecord(result)) continue;

    const url = canonicalizeHttpUrl(result.url);
    if (!url) continue;
    const domain = searchResultDomain(url);
    if (!domain || seenDomains.has(domain)) continue;

    seenDomains.add(domain);
    normalized.push({
      rank: normalized.length + 1,
      sourceRank: index + 1,
      url,
      domain,
      title: cleanOptionalSearchText(result.title, 500),
      snippet: cleanOptionalSearchText(result.content, 2_000),
      engines: normalizeEngines(result.engines, result.engine),
      score:
        typeof result.score === "number" && Number.isFinite(result.score) ? result.score : null,
      publishedAt: cleanOptionalSearchText(
        typeof result.publishedDate === "string" ? result.publishedDate : result.published_date,
        100,
      ),
      thumbnailUrl: canonicalizeHttpUrl(
        typeof result.thumbnail === "string" ? result.thumbnail : result.img_src,
      ),
    });
  }

  return normalized;
}

function parseDiscoveryDate(input: Date | string): Date {
  let date: Date;

  if (input instanceof Date) {
    date = new Date(input.getTime());
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    date = new Date(`${input}T12:00:00.000Z`);
  } else {
    date = new Date(input);
  }

  if (!Number.isFinite(date.getTime())) throw new TypeError("discovery_date_invalid");
  return date;
}

function normalizeLocale(locale: string | null | undefined): string {
  const candidate = (locale ?? "en").trim().replace(/_/g, "-");
  if (!candidate) return "en";

  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? "en";
  } catch {
    return "en";
  }
}

function formatMonth(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    timeZone: "UTC",
  }).format(date);
}

function validPopulation(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : -1;
}

function cleanInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanOptionalSearchText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = decodeBasicHtmlEntities(value.replace(/<[^>]*>/g, " "))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, maxLength) : null;
}

function decodeBasicHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] !== "#") return named[body.toLowerCase()] ?? entity;
    const hexadecimal = body[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return entity;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return entity;
    }
  });
}

function normalizeEngines(engines: unknown, engine: unknown): string[] {
  const values = Array.isArray(engines) ? engines : [engine];
  return [
    ...new Set(
      values.flatMap((value) => {
        const normalized = cleanOptionalSearchText(value, 100);
        return normalized ? [normalized] : [];
      }),
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicLookingHostname(hostname: string): boolean {
  if (!hostname || hostname === "localhost") return false;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return false;

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return isPublicIpv6(hostname.slice(1, -1));
  }

  if (/^\d+(?:\.\d+){3}$/.test(hostname)) return isPublicIpv4(hostname);
  if (!hostname.includes(".")) return false;
  return /^[a-z0-9.-]+$/i.test(hostname) && !hostname.includes("..");
}

function isPublicIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) return false;

  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("::ffff:")) return false;

  const firstPart = normalized.split(":", 1)[0];
  const firstHextet = Number.parseInt(firstPart || "0", 16);
  if (!Number.isFinite(firstHextet)) return false;
  if ((firstHextet & 0xfe00) === 0xfc00) return false;
  if ((firstHextet & 0xffc0) === 0xfe80) return false;
  if ((firstHextet & 0xff00) === 0xff00) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  return /^[\da-f:]+$/.test(normalized);
}
