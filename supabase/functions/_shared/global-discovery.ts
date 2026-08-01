export const MAX_SEARCH_RESULTS_PER_QUERY = 10;

type CoreLocalizedQueryFamily = "nightlife" | "family" | "outdoor" | "culture";

export type DiscoveryQueryFamily =
  | "general"
  | CoreLocalizedQueryFamily
  | "music"
  | "sports"
  | "gastronomy"
  | "learning"
  | "wellness"
  | "community"
  | "business"
  | "festivals";

export type DiscoveryQuery = {
  family: DiscoveryQueryFamily;
  query: string;
  locale: string;
  dateScope: "day" | "month" | "year";
  dateKey: string;
  monthKey: string;
};

export type BuildDiscoveryQueriesInput = {
  cityName: string;
  countryName?: string | null;
  date: Date | string;
  locale?: string | null;
  /** Number of consecutive daily general searches, starting at `date`. */
  dailyGeneralDays?: number;
  /** Stable city identifier used to rotate locales and category families. */
  rotationKey?: string | null;
};

export type BuildMultilingualDiscoveryQueriesInput = Omit<
  BuildDiscoveryQueriesInput,
  "locale" | "dailyGeneralDays"
> & {
  locales: Array<string | null | undefined>;
  primaryDailyGeneralDays?: number;
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
  candidateLimit?: number;
  random?: () => number;
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

type QueryTemplateSet = Record<CoreLocalizedQueryFamily, (context: QueryDateContext) => string>;

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

const ROTATING_MONTHLY_QUERY_FAMILIES: DiscoveryQueryFamily[] = [
  "culture",
  "family",
  "outdoor",
  "music",
  "sports",
  "gastronomy",
  "learning",
  "wellness",
  "community",
  "business",
  "nightlife",
];

const DAILY_GENERAL_LABELS: Record<string, string> = {
  fr: "Agenda événements",
  en: "Events calendar",
  de: "Veranstaltungskalender",
  es: "Agenda de eventos",
  it: "Calendario eventi",
  pt: "Agenda de eventos",
  nl: "Evenementenkalender",
  pl: "Kalendarz wydarzeń",
  ru: "Афиша событий",
  tr: "Etkinlik takvimi",
  id: "Kalender acara",
  ar: "دليل الفعاليات",
  hi: "कार्यक्रम कैलेंडर",
  ja: "イベントカレンダー",
  ko: "이벤트 일정",
  zh: "活动日历",
};

const CATEGORY_LABELS: Record<string, Partial<Record<DiscoveryQueryFamily, string>>> = {
  en: {
    music: "Live music and concerts",
    sports: "Sports events",
    gastronomy: "Food and drink events",
    learning: "Classes workshops and conferences",
    wellness: "Health and wellness events",
    community: "Community and local events",
    business: "Business and networking events",
    festivals: "Festivals and annual events",
  },
  fr: {
    music: "Concerts et musique live",
    sports: "Événements sportifs",
    gastronomy: "Événements gastronomie et boissons",
    learning: "Cours ateliers et conférences",
    wellness: "Événements santé et bien-être",
    community: "Manifestations locales et vie de quartier",
    business: "Événements professionnels et réseautage",
    festivals: "Festivals et événements annuels",
  },
  de: {
    music: "Konzerte und Live-Musik",
    sports: "Sportveranstaltungen",
    gastronomy: "Essen und Trinken Veranstaltungen",
    learning: "Kurse Workshops und Konferenzen",
    wellness: "Gesundheit und Wellness Veranstaltungen",
    community: "Lokale und Gemeinschaftsveranstaltungen",
    business: "Business und Networking Veranstaltungen",
    festivals: "Festivals und jährliche Veranstaltungen",
  },
  es: {
    music: "Conciertos y música en vivo",
    sports: "Eventos deportivos",
    gastronomy: "Eventos de gastronomía y bebidas",
    learning: "Cursos talleres y conferencias",
    wellness: "Eventos de salud y bienestar",
    community: "Eventos locales y comunitarios",
    business: "Eventos profesionales y networking",
    festivals: "Festivales y eventos anuales",
  },
  it: {
    music: "Concerti e musica dal vivo",
    sports: "Eventi sportivi",
    gastronomy: "Eventi enogastronomici",
    learning: "Corsi laboratori e conferenze",
    wellness: "Eventi salute e benessere",
    community: "Eventi locali e di comunità",
    business: "Eventi professionali e networking",
    festivals: "Festival ed eventi annuali",
  },
  pt: {
    music: "Concertos e música ao vivo",
    sports: "Eventos esportivos",
    gastronomy: "Eventos de gastronomia e bebidas",
    learning: "Cursos oficinas e conferências",
    wellness: "Eventos de saúde e bem-estar",
    community: "Eventos locais e comunitários",
    business: "Eventos profissionais e networking",
    festivals: "Festivais e eventos anuais",
  },
};

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
  const requestedDailyGeneralDays = input.dailyGeneralDays ?? 1;
  if (
    !Number.isInteger(requestedDailyGeneralDays) ||
    requestedDailyGeneralDays < 1 ||
    requestedDailyGeneralDays > 31
  ) {
    throw new TypeError("discovery_daily_general_days_invalid");
  }

  const dailyDates = Array.from({ length: requestedDailyGeneralDays }, (_, offset) =>
    addUtcDays(date, offset),
  );
  const dailyQueries = dailyDates.map((dailyDate): DiscoveryQuery => {
    const { context, dateKey, monthKey } = queryDateContext(dailyDate, locale, place);
    return {
      family: "general",
      query: `${DAILY_GENERAL_LABELS[templateLanguage] ?? DAILY_GENERAL_LABELS.en} ${place} ${context.day} ${context.month} ${context.year}`,
      locale,
      dateScope: "day",
      dateKey,
      monthKey,
    };
  });

  // Eight monthly category lanes rotate for every city and planning date. In
  // two consecutive weekly cycles every family gets a turn without letting
  // nightlife consume the daily budget.
  const { context, dateKey, monthKey } = queryDateContext(date, locale, place);
  const rotation = stableHash(input.rotationKey ?? place) + weeklySequence(date) * 8;
  const monthlyFamilies = rotate(ROTATING_MONTHLY_QUERY_FAMILIES, rotation).slice(0, 8);
  const monthlyQueries = monthlyFamilies.map(
    (family): DiscoveryQuery => ({
      family,
      query:
        family === "nightlife" ||
        family === "family" ||
        family === "outdoor" ||
        family === "culture"
          ? templates[family](context)
          : `${CATEGORY_LABELS[templateLanguage]?.[family] ?? CATEGORY_LABELS.en[family] ?? "Events"} ${place} ${context.month} ${context.year}`,
      locale,
      dateScope: "month",
      dateKey,
      monthKey,
    }),
  );
  const annualQuery: DiscoveryQuery = {
    family: "festivals",
    query: `${CATEGORY_LABELS[templateLanguage]?.festivals ?? CATEGORY_LABELS.en.festivals} ${place} ${context.year}`,
    locale,
    dateScope: "year",
    dateKey,
    monthKey,
  };

  return [...dailyQueries, ...monthlyQueries, annualQuery];
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

  // A city keeps one language per weekly slice so the 16-query budget is
  // spent on temporal/category coverage. The deterministic rotation gives all
  // configured local languages a turn across subsequent refreshes.
  const planningDate = parseDiscoveryDate(input.date);
  const localeOffset =
    (stableHash(input.rotationKey ?? input.cityName) + weeklySequence(planningDate)) %
    locales.length;
  const rotatedLocales = rotate(locales, localeOffset);

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
      locale: rotatedLocales[0],
      dailyGeneralDays: input.primaryDailyGeneralDays ?? 7,
    }),
  );
  for (const locale of rotatedLocales.slice(1)) {
    if (output.length >= maximum) break;
    const supplemental = buildLocalizedDiscoveryQueries({
      ...input,
      locale,
      dailyGeneralDays: 1,
    });
    append(supplemental);
  }
  return output.slice(0, maximum);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  if (!values.length) return [];
  const normalized = ((offset % values.length) + values.length) % values.length;
  return [...values.slice(normalized), ...values.slice(0, normalized)];
}

function weeklySequence(date: Date): number {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 604_800_000,
  );
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
  const requestedCandidateLimit = Number.isFinite(options.candidateLimit)
    ? Math.floor(options.candidateLimit as number)
    : limit;
  const candidateLimit = Math.max(limit, Math.min(50, requestedCandidateLimit));

  const candidates: NormalizedSearchResult[] = [];
  const seenDomains = new Set<string>();

  for (let index = 0; index < rawResults.length && candidates.length < candidateLimit; index += 1) {
    const result = rawResults[index];
    if (!isRecord(result)) continue;

    const url = canonicalizeHttpUrl(result.url);
    if (!url) continue;
    const domain = searchResultDomain(url);
    if (!domain || seenDomains.has(domain)) continue;

    seenDomains.add(domain);
    candidates.push({
      rank: candidates.length + 1,
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

  if (options.random && candidates.length > 1) {
    for (let index = candidates.length - 1; index > 0; index -= 1) {
      const randomValue = options.random();
      const safeRandom =
        Number.isFinite(randomValue) && randomValue >= 0 && randomValue < 1 ? randomValue : 0;
      const swapIndex = Math.floor(safeRandom * (index + 1));
      [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
    }
  }

  return candidates.slice(0, limit).map((result, index) => ({
    ...result,
    rank: index + 1,
  }));
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
