export type EventSourceCity = {
  name: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  country?: { code: string } | null;
};

export type EventSourceContext = {
  id: string;
  name: string;
  domain: string;
  category_slug: string | null;
  metadata: Record<string, unknown> | null;
  city: EventSourceCity | null;
};

export type EventCandidatePerformer = {
  name?: string | null;
  type?: string | null;
  imageUrl?: string | null;
  isHeadliner?: boolean | null;
};

export type EventCandidateAccessibility = {
  wheelchair?: boolean | null;
  hearingLoop?: boolean | null;
  signLanguage?: boolean | null;
  quietSpace?: boolean | null;
  notes?: string | null;
};

export type NormalizedEventPerformer = {
  name: string;
  type: string | null;
  imageUrl: string | null;
  isHeadliner: boolean;
};

export type NormalizedEventAccessibility = {
  wheelchair: boolean;
  hearingLoop: boolean;
  signLanguage: boolean;
  quietSpace: boolean;
  notes: string | null;
};

export type EventCandidate = {
  externalId?: string | null;
  title?: string | null;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  timezone?: string | null;
  timePrecision?: string | null;
  allDay?: boolean | null;
  venueName?: string | null;
  venueUrl?: string | null;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
  region?: string | null;
  countryCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  organizerName?: string | null;
  organizerUrl?: string | null;
  status?: string | null;
  language?: string | null;
  category?: string | null;
  genres?: string[] | null;
  performers?: EventCandidatePerformer[] | null;
  ageRestriction?: string | null;
  accessibility?: EventCandidateAccessibility | null;
  capacity?: number | null;
  priceMin?: number | null;
  priceMax?: number | null;
  currency?: string | null;
  ticketUrl?: string | null;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  isFree?: boolean | null;
  sourceUrl?: string | null;
  extractionMethod?: "jsonld" | "html" | "ai";
};

export type NormalizedEvent = {
  externalId: string | null;
  title: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
  timezone: string;
  timePrecision: "exact" | "date" | "tbd" | "unknown";
  allDay: boolean;
  venueName: string | null;
  venueUrl: string | null;
  address: string | null;
  postalCode: string | null;
  city: string;
  region: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  organizerName: string | null;
  organizerUrl: string | null;
  status: "scheduled" | "cancelled" | "postponed" | "sold_out";
  language: string;
  category: string | null;
  genres: string[];
  performers: NormalizedEventPerformer[];
  ageRestriction: string | null;
  accessibility: NormalizedEventAccessibility | null;
  capacity: number | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  ticketUrl: string | null;
  imageUrl: string | null;
  isFree: boolean;
  sourceUrl: string;
  extractionMethod: "jsonld" | "html" | "ai";
  qualityScore: number;
  fingerprint: string;
  warnings: string[];
};

export type NormalizationResult =
  { ok: true; event: NormalizedEvent } | { ok: false; reason: string; candidate: EventCandidate };

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source",
]);

const GENRE_ALIASES: Record<string, string> = {
  "afro house": "afro-house",
  afrohouse: "afro-house",
  techno: "techno",
  house: "house",
  electro: "electro",
  edm: "electro",
  trance: "trance",
  "drum and bass": "drum-and-bass",
  dnb: "drum-and-bass",
  "hip hop": "hip-hop",
  hiphop: "hip-hop",
  rap: "hip-hop",
  "r&b": "r-and-b",
  rnb: "r-and-b",
  soul: "soul",
  reggae: "reggae",
  dancehall: "dancehall",
  disco: "disco",
  funk: "funk",
  jazz: "jazz",
  blues: "blues",
  rock: "rock",
  metal: "metal",
  punk: "punk",
  indie: "indie",
  pop: "pop",
  classical: "classical",
  classique: "classical",
  opera: "opera",
  latin: "latin",
  latino: "latin",
  reggaeton: "reggaeton",
  afrobeat: "afrobeat",
  "afro beat": "afrobeat",
  world: "world",
  experimental: "experimental",
  ambient: "ambient",
  gospel: "gospel",
};

const CATEGORY_RULES: Array<[string, string[]]> = [
  [
    "soirees",
    [
      "nightclub",
      "night club",
      "club night",
      "clubbing",
      "rave",
      "party",
      "soiree",
      "fiesta",
      "afterwork",
      "boat party",
      "silent disco",
      "dj set",
      "discoteca",
      "boite de nuit",
      "klub nocny",
      "nachtclub",
    ],
  ],
  [
    "festivals",
    [
      "festival",
      "music festival",
      "festival de musique",
      "musikfestival",
      "open air festival",
      "festival open air",
      "festiwal",
    ],
  ],
  [
    "concerts",
    [
      "concert",
      "live music",
      "live show",
      "konzert",
      "concerto",
      "concierto",
      "gig",
      "orchestra",
      "orchestre",
      "recital",
    ],
  ],
  [
    "expositions",
    [
      "exhibition",
      "exposition",
      "vernissage",
      "gallery",
      "galerie",
      "museum",
      "musee",
      "ausstellung",
      "mostra",
      "wystawa",
      "art fair",
    ],
  ],
  [
    "theatre",
    [
      "theatre",
      "theater",
      "teatro",
      "teatr",
      "ballet",
      "dance performance",
      "spectacle",
      "opera",
      "musical",
      "stand up",
      "standup",
      "comedy",
      "comedie",
      "humour",
    ],
  ],
  ["famille", ["family", "famille", "children", "enfant", "kids", "jeune public"]],
  [
    "sports-outdoor",
    [
      "sports-outdoor",
      "sport",
      "sports",
      "outdoor activity",
      "outdoor activities",
      "plein air",
      "hiking",
      "randonnee",
      "trail",
      "running",
      "cycling",
      "bike",
      "yoga",
      "fitness",
      "ski",
      "swimming",
    ],
  ],
  [
    "heritage",
    [
      "heritage",
      "patrimoine",
      "guided tour",
      "visite guidee",
      "historic monument",
      "architecture tour",
      "walking tour",
    ],
  ],
  [
    "gastronomy",
    [
      "gastronomy",
      "gastronomie",
      "food market",
      "marche gourmand",
      "tasting",
      "degustation",
      "wine event",
      "culinary",
    ],
  ],
  [
    "activities",
    [
      "activities",
      "activity",
      "workshop",
      "atelier",
      "masterclass",
      "course",
      "creative class",
      "participatory",
    ],
  ],
  [
    "conferences",
    [
      "conferences",
      "conference",
      "talk",
      "lecture",
      "meetup",
      "seminar",
      "panel",
      "debate",
      "rencontre",
    ],
  ],
  ["cinema", ["cinema", "film", "movie", "screening", "projection"]],
  ["leisure", ["leisure", "loisir", "game", "gaming", "escape room", "quiz", "bowling", "arcade"]],
  ["other", []],
];

const NOISE_TITLE =
  /(?:gift\s*card|carte\s*cadeau|newsletter|privacy|confidentialite|cookie|membership|abonnement|contact|faq|home|accueil)/i;

const FREE_TERMS =
  /(?:free\s+(?:entry|admission)|entry\s+free|entree\s+libre|gratuit(?:e)?|kostenlos|eintritt\s+frei|entrada\s+libre|gratis|wstep\s+wolny)/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

export function cleanEventText(value: unknown, maximum = 6_000): string {
  if (typeof value !== "string") return "";
  const withoutControls = [...decodeEntities(value)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  const cleaned = withoutControls
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, maximum);
}

export function normalizeEventText(value: unknown): string {
  return cleanEventText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function canonicalEventUrl(value: unknown, baseUrl: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value, baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function timezoneParts(date: Date, timezone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function localDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): Date | null {
  try {
    const desired = Date.UTC(year, month - 1, day, hour, minute, second);
    let result = desired;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const parts = timezoneParts(new Date(result), timezone);
      const represented = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      );
      result += desired - represented;
    }
    const date = new Date(result);
    return Number.isFinite(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}

function parseEventDate(
  value: unknown,
  timezone: string,
): { date: Date; precision: "exact" | "date" } | null {
  const text = cleanEventText(value, 100);
  if (!text) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const date = localDateTimeToUtc(
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
      0,
      0,
      0,
      timezone,
    );
    return date ? { date, precision: "date" } : null;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(text);
  if (local) {
    const date = localDateTimeToUtc(
      Number(local[1]),
      Number(local[2]),
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6] ?? 0),
      timezone,
    );
    return date ? { date, precision: "exact" } : null;
  }
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? { date: parsed, precision: "exact" } : null;
}

function safeNumber(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function haversineKm(leftLat: number, leftLon: number, rightLat: number, rightLon: number): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(rightLat - leftLat);
  const dLon = radians(rightLon - leftLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(leftLat)) * Math.cos(radians(rightLat)) * Math.sin(dLon / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validTimezone(value: unknown, fallback = "UTC"): string {
  const candidate = cleanEventText(value, 100) || fallback;
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

function sourceHostMatches(url: string, source: EventSourceContext): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const sourceHost = source.domain.toLowerCase().replace(/^www\./, "");
    return (
      host === sourceHost || host.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

function classifyCategory(candidate: EventCandidate, source: EventSourceContext): string | null {
  const title = normalizeEventText(candidate.title);
  const description = normalizeEventText(candidate.description);
  const supplied = normalizeEventText(candidate.category);
  let best: { category: string; score: number } | null = null;
  for (const [category, keywords] of CATEGORY_RULES) {
    let score = 0;
    for (const keyword of keywords) {
      const normalized = normalizeEventText(keyword);
      const pattern = new RegExp(
        `(?:^|\\s)${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|\\s)`,
      );
      if (pattern.test(title)) score += 3;
      if (pattern.test(supplied)) score += 4;
      if (pattern.test(description)) score += 1;
    }
    if (!best || score > best.score) best = { category, score };
  }
  if (best && best.score >= 2) return best.category;
  const suppliedSlug = cleanEventText(candidate.category, 80).toLowerCase();
  if (CATEGORY_RULES.some(([category]) => category === suppliedSlug)) return suppliedSlug;
  return source.category_slug ?? "other";
}

function normalizeGenres(value: unknown, candidate: EventCandidate): string[] {
  const inputs = Array.isArray(value) ? value : [];
  const searchable = normalizeEventText(
    [candidate.title, candidate.description, candidate.category, ...inputs]
      .filter(Boolean)
      .join(" "),
  );
  const genres = new Set<string>();
  for (const [alias, genre] of Object.entries(GENRE_ALIASES)) {
    const normalized = normalizeEventText(alias);
    const pattern = new RegExp(
      `(?:^|\\s)${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|\\s)`,
    );
    if (pattern.test(searchable)) genres.add(genre);
  }
  return [...genres].slice(0, 8);
}

function normalizeStatus(value: unknown): NormalizedEvent["status"] {
  const status = normalizeEventText(value).replace(/\s+/g, "");
  if (status.includes("cancel")) return "cancelled";
  if (status.includes("postpon") || status.includes("report")) return "postponed";
  if (status.includes("soldout") || status.includes("complet")) return "sold_out";
  return "scheduled";
}

function normalizedCurrency(value: unknown): string | null {
  const currency = cleanEventText(value, 3).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function normalizeCandidatePerformers(
  value: EventCandidate["performers"],
  baseUrl: string,
): NormalizedEventPerformer[] {
  const performers = new Map<string, NormalizedEventPerformer>();
  for (const candidate of value ?? []) {
    if (!candidate || typeof candidate !== "object") continue;
    const name = cleanEventText(candidate.name, 180);
    if (!name) continue;
    const key = normalizeEventText(name);
    if (!key) continue;
    const type = cleanEventText(candidate.type, 80) || null;
    const imageUrl = canonicalEventUrl(candidate.imageUrl, baseUrl);
    const existing = performers.get(key);
    if (existing) {
      existing.type ??= type;
      existing.imageUrl ??= imageUrl;
      existing.isHeadliner ||= candidate.isHeadliner === true;
      continue;
    }
    performers.set(key, {
      name,
      type,
      imageUrl,
      isHeadliner: candidate.isHeadliner === true,
    });
    if (performers.size >= 100) break;
  }
  return [...performers.values()];
}

function normalizeCandidateAccessibility(
  value: EventCandidate["accessibility"],
): NormalizedEventAccessibility | null {
  if (!value || typeof value !== "object") return null;
  const notes = cleanEventText(value.notes, 1_000) || null;
  const hasExplicitValue =
    typeof value.wheelchair === "boolean" ||
    typeof value.hearingLoop === "boolean" ||
    typeof value.signLanguage === "boolean" ||
    typeof value.quietSpace === "boolean" ||
    Boolean(notes);
  if (!hasExplicitValue) return null;
  return {
    wheelchair: value.wheelchair === true,
    hearingLoop: value.hearingLoop === true,
    signLanguage: value.signLanguage === true,
    quietSpace: value.quietSpace === true,
    notes,
  };
}

const COUNTRY_NAME_CODES: Record<string, string> = {
  australia: "AU",
  austria: "AT",
  autriche: "AT",
  belgique: "BE",
  belgium: "BE",
  canada: "CA",
  "coree du sud": "KR",
  "czech republic": "CZ",
  czechia: "CZ",
  danemark: "DK",
  denmark: "DK",
  emiratsarabesunis: "AE",
  "emirats arabes unis": "AE",
  espagne: "ES",
  france: "FR",
  ireland: "IE",
  irlande: "IE",
  italie: "IT",
  italy: "IT",
  japan: "JP",
  japon: "JP",
  maroc: "MA",
  mexico: "MX",
  mexique: "MX",
  morocco: "MA",
  "new zealand": "NZ",
  "nouvelle zelande": "NZ",
  norway: "NO",
  norvege: "NO",
  pologne: "PL",
  poland: "PL",
  "republic of korea": "KR",
  singapour: "SG",
  singapore: "SG",
  "south africa": "ZA",
  "south korea": "KR",
  spain: "ES",
  suede: "SE",
  suisse: "CH",
  sweden: "SE",
  switzerland: "CH",
  tchequie: "CZ",
  "united arab emirates": "AE",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
};

function normalizedCountryCode(value: unknown, fallback: string | null | undefined): string | null {
  const fallbackCode = cleanEventText(fallback, 2).toUpperCase();
  const safeFallback = /^[A-Z]{2}$/.test(fallbackCode) ? fallbackCode : null;
  const supplied = cleanEventText(value, 120);
  if (!supplied) return safeFallback;
  const uppercase = supplied.toUpperCase();
  if (/^[A-Z]{2}$/.test(uppercase)) return uppercase;
  const name = normalizeEventText(supplied);
  return COUNTRY_NAME_CODES[name] ?? COUNTRY_NAME_CODES[name.replace(/\s+/g, "")] ?? safeFallback;
}

function currencyForCountry(countryCode: string | null | undefined): string | null {
  const currencies: Record<string, string> = {
    AD: "EUR",
    AT: "EUR",
    BE: "EUR",
    CH: "CHF",
    CY: "EUR",
    DE: "EUR",
    EE: "EUR",
    ES: "EUR",
    FI: "EUR",
    FR: "EUR",
    GR: "EUR",
    HR: "EUR",
    IE: "EUR",
    IT: "EUR",
    LT: "EUR",
    LU: "EUR",
    LV: "EUR",
    MC: "EUR",
    ME: "EUR",
    MT: "EUR",
    NL: "EUR",
    PT: "EUR",
    SI: "EUR",
    SK: "EUR",
    SM: "EUR",
    VA: "EUR",
    XK: "EUR",
    GB: "GBP",
    US: "USD",
    CA: "CAD",
    AU: "AUD",
    NZ: "NZD",
    JP: "JPY",
    PL: "PLN",
    CZ: "CZK",
    HU: "HUF",
    SE: "SEK",
    NO: "NOK",
    DK: "DKK",
    MX: "MXN",
    KR: "KRW",
    SG: "SGD",
    AE: "AED",
    ZA: "ZAR",
    MA: "MAD",
  };
  if (!countryCode) return null;
  // Never invent EUR for an unmapped country. A missing currency is more
  // truthful than a plausible-looking but incorrect price denomination.
  return currencies[countryCode.toUpperCase()] ?? null;
}

function stableFingerprint(parts: string[]): string {
  // FNV-1a is deterministic and sufficient as a pre-ingestion identity. The database
  // still generates a SHA-256 canonical fingerprint for persistent matching.
  let hash = 0x811c9dc5;
  const value = parts.join("|");
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function normalizeEventCandidate(
  candidate: EventCandidate,
  source: EventSourceContext,
  pageUrl: string,
  now = new Date(),
): NormalizationResult {
  const title = cleanEventText(candidate.title, 240);
  if (title.length < 3) return { ok: false, reason: "invalid_title", candidate };
  if (NOISE_TITLE.test(title)) return { ok: false, reason: "navigation_or_commerce", candidate };

  const timezone = validTimezone(candidate.timezone, validTimezone(source.city?.timezone, "UTC"));
  const start = parseEventDate(candidate.startDate, timezone);
  if (!start) return { ok: false, reason: "invalid_start_date", candidate };
  const oldest = now.getTime() - 2 * 86_400_000;
  const newest = now.getTime() + 730 * 86_400_000;
  if (start.date.getTime() < oldest || start.date.getTime() > newest) {
    return { ok: false, reason: "outside_ingestion_window", candidate };
  }

  const warnings: string[] = [];
  const explicitPrecision = cleanEventText(candidate.timePrecision, 20).toLowerCase();
  const precision = (["exact", "date", "tbd", "unknown"] as const).includes(
    explicitPrecision as NormalizedEvent["timePrecision"],
  )
    ? (explicitPrecision as NormalizedEvent["timePrecision"])
    : start.precision;
  const allDay = candidate.allDay === true || start.precision === "date";

  let end = parseEventDate(candidate.endDate, timezone)?.date ?? null;
  if (allDay) {
    if (!end) end = new Date(start.date.getTime() + 86_400_000);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(cleanEventText(candidate.endDate, 20))) {
      end = new Date(end.getTime() + 86_400_000);
    }
  }
  if (end && end < start.date) {
    warnings.push("end_before_start");
    end = null;
  }

  const fallbackSourceUrl = canonicalEventUrl(pageUrl, pageUrl) ?? pageUrl;
  let sourceUrl = canonicalEventUrl(candidate.sourceUrl, fallbackSourceUrl) ?? fallbackSourceUrl;
  if (!sourceHostMatches(sourceUrl, source)) {
    warnings.push("off_domain_source_url");
    sourceUrl = fallbackSourceUrl;
  }
  const ticketUrl = canonicalEventUrl(candidate.ticketUrl, sourceUrl);
  const organizerUrl = canonicalEventUrl(candidate.organizerUrl, sourceUrl);
  const venueUrl = canonicalEventUrl(candidate.venueUrl, sourceUrl);
  const images = [candidate.imageUrl, ...(candidate.imageUrls ?? [])]
    .map((value) => canonicalEventUrl(value, sourceUrl))
    .filter((value): value is string => Boolean(value))
    .filter((value) => !/(?:placeholder|spacer|transparent|logo)(?:[._/-]|$)/i.test(value));

  const rawLatitude = safeNumber(candidate.latitude, -90, 90);
  const rawLongitude = safeNumber(candidate.longitude, -180, 180);
  let latitude = rawLatitude;
  let longitude = rawLongitude;
  if ((latitude == null) !== (longitude == null)) {
    warnings.push("incomplete_coordinates");
    latitude = null;
    longitude = null;
  }
  if (
    latitude != null &&
    longitude != null &&
    source.city?.latitude != null &&
    source.city.longitude != null
  ) {
    const configuredDistance = safeNumber(source.metadata?.max_distance_km, 5, 2_000);
    const maximumDistance = configuredDistance ?? 250;
    const distance = haversineKm(latitude, longitude, source.city.latitude, source.city.longitude);
    if (distance > maximumDistance) {
      warnings.push(`coordinates_outside_source_area:${Math.round(distance)}km`);
      latitude = null;
      longitude = null;
    }
  }

  const suppliedCity = cleanEventText(candidate.city, 120);
  const sourceCity = cleanEventText(source.city?.name, 120);
  const configuredCityAliases = Array.isArray(source.metadata?.city_aliases)
    ? source.metadata.city_aliases
        .map((value) => cleanEventText(value, 120))
        .filter((value): value is string => Boolean(value))
    : [];
  const suppliedCityMatchesSource =
    Boolean(suppliedCity && sourceCity) &&
    [sourceCity, ...configuredCityAliases].some(
      (alias) => normalizeEventText(alias) === normalizeEventText(suppliedCity),
    );
  const city = suppliedCityMatchesSource ? sourceCity : suppliedCity || sourceCity;
  const eventUsesSourceCity =
    Boolean(city && sourceCity) && normalizeEventText(city) === normalizeEventText(sourceCity);
  if (suppliedCity && sourceCity && !suppliedCityMatchesSource) {
    warnings.push("city_differs_from_source");
  }
  const description = cleanEventText(candidate.description, 6_000) || null;
  const venueName = cleanEventText(candidate.venueName, 180) || null;
  const address = cleanEventText(candidate.address, 300) || null;
  const postalCode = cleanEventText(candidate.postalCode, 40) || null;
  const category = classifyCategory(candidate, source);
  const genres = normalizeGenres(candidate.genres, candidate);
  const performers = normalizeCandidatePerformers(candidate.performers, sourceUrl);
  const ageRestriction = cleanEventText(candidate.ageRestriction, 80) || null;
  const accessibility = normalizeCandidateAccessibility(candidate.accessibility);
  const capacity = safeNumber(candidate.capacity, 1, 1_000_000);
  let priceMin = safeNumber(candidate.priceMin, 0, 100_000);
  let priceMax = safeNumber(candidate.priceMax, 0, 100_000);
  if (priceMin != null && priceMax != null && priceMin > priceMax) {
    [priceMin, priceMax] = [priceMax, priceMin];
  }
  const isFree =
    candidate.isFree === true ||
    priceMin === 0 ||
    priceMax === 0 ||
    FREE_TERMS.test(`${title} ${description ?? ""}`);
  if (isFree) {
    priceMin ??= 0;
    priceMax ??= 0;
  }
  const sourceCountryCode = normalizedCountryCode(source.city?.country?.code, null);
  const suppliedCountryCode = normalizedCountryCode(candidate.countryCode, sourceCountryCode);
  const countryCode = eventUsesSourceCity
    ? (sourceCountryCode ?? suppliedCountryCode)
    : suppliedCountryCode;
  if (
    eventUsesSourceCity &&
    sourceCountryCode &&
    suppliedCountryCode &&
    suppliedCountryCode !== sourceCountryCode
  ) {
    warnings.push("country_differs_from_source");
  }
  if (
    latitude == null &&
    longitude == null &&
    city &&
    sourceCity &&
    normalizeEventText(city) !== normalizeEventText(sourceCity) &&
    countryCode === sourceCountryCode &&
    source.city?.latitude != null &&
    source.city.longitude != null
  ) {
    // City-specific calendars sometimes list a nearby suburb without venue
    // coordinates. Keep the event visible on the map at the source-city
    // centroid and flag the approximation instead of silently losing its pin.
    latitude = source.city.latitude;
    longitude = source.city.longitude;
    warnings.push("approximate_source_city_coordinates");
  }
  const currency = normalizedCurrency(candidate.currency) ?? currencyForCountry(countryCode);
  const externalId = cleanEventText(candidate.externalId, 500) || null;
  const extractionMethod = candidate.extractionMethod ?? "ai";

  let quality = 0;
  quality += 22;
  quality += 22;
  quality += end ? 10 : 0;
  quality += venueName || address ? 12 : 0;
  quality += city ? 8 : 0;
  quality += description && description.length >= 40 ? 8 : 0;
  quality += images.length ? 6 : 0;
  quality += ticketUrl ? 5 : 0;
  quality += category ? 4 : 0;
  quality += latitude != null && longitude != null ? 3 : 0;
  quality += extractionMethod === "jsonld" ? 3 : 0;
  quality -= warnings.includes("city_differs_from_source") ? 8 : 0;
  quality -= warnings.includes("off_domain_source_url") ? 4 : 0;
  quality = Math.max(0, Math.min(100, quality));
  if (quality < 48) return { ok: false, reason: `quality_below_threshold:${quality}`, candidate };

  const startDate = start.date.toISOString();
  const fingerprint = stableFingerprint([
    normalizeEventText(title),
    startDate.slice(0, 16),
    normalizeEventText(venueName ?? address ?? city),
    normalizeEventText(city),
  ]);
  return {
    ok: true,
    event: {
      externalId,
      title,
      description,
      startDate,
      endDate: end?.toISOString() ?? null,
      timezone,
      timePrecision: allDay ? "date" : precision,
      allDay,
      venueName,
      venueUrl,
      address,
      postalCode,
      city,
      region: cleanEventText(candidate.region, 120) || null,
      countryCode,
      latitude,
      longitude,
      organizerName: cleanEventText(candidate.organizerName, 180) || null,
      organizerUrl,
      status: normalizeStatus(candidate.status),
      language: cleanEventText(candidate.language, 10).toLowerCase() || "und",
      category,
      genres,
      performers,
      ageRestriction,
      accessibility,
      capacity: capacity == null ? null : Math.round(capacity),
      priceMin,
      priceMax,
      currency,
      ticketUrl,
      imageUrl: images[0] ?? null,
      isFree,
      sourceUrl,
      extractionMethod,
      qualityScore: quality,
      fingerprint,
      warnings,
    },
  };
}

function firstText(value: unknown): string {
  if (typeof value === "string") return cleanEventText(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstText(item);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return firstText(row.name ?? row.value ?? row.url ?? row.contentUrl ?? row["@id"]);
  }
  return "";
}

function absoluteUrl(value: unknown, baseUrl: string): string | null {
  return canonicalEventUrl(firstText(value), baseUrl);
}

function imageUrlValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  return row.contentUrl ?? row.url ?? row["@id"] ?? row.thumbnailUrl;
}

function asList(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const match = value.replace(/'/g, "").match(/-?\d+(?:[.,]\d+)?/);
  return match ? Number.parseFloat(match[0].replace(",", ".")) : null;
}

function offerData(
  value: unknown,
  baseUrl: string,
): {
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  ticketUrl: string | null;
} {
  const prices: number[] = [];
  let currency: string | null = null;
  let ticketUrl: string | null = null;
  const visit = (current: unknown) => {
    for (const offer of asList(current)) {
      if (!offer || typeof offer !== "object") continue;
      const row = offer as Record<string, unknown>;
      for (const key of ["price", "lowPrice", "highPrice", "minPrice", "maxPrice"]) {
        const parsed = numericValue(row[key]);
        if (parsed != null && parsed >= 0) prices.push(parsed);
      }
      currency ??= normalizedCurrency(row.priceCurrency);
      ticketUrl ??= absoluteUrl(row.url, baseUrl);
      if (row.offers) visit(row.offers);
    }
  };
  visit(value);
  return {
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    currency,
    ticketUrl,
  };
}

function schemaTypeName(value: unknown): string | null {
  for (const item of asList(value)) {
    if (typeof item !== "string") continue;
    const type = cleanEventText(item, 200);
    if (!type) continue;
    try {
      const parsed = new URL(type);
      const fragment = parsed.hash.replace(/^#/, "");
      const pathName = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
      const name = cleanEventText(fragment || pathName, 80);
      if (name) return name;
    } catch {
      const name = cleanEventText(type, 80);
      if (name) return name;
    }
  }
  return null;
}

function jsonLdPerformers(
  node: Record<string, unknown>,
  baseUrl: string,
): EventCandidatePerformer[] {
  const performers = new Map<string, EventCandidatePerformer>();
  const add = (value: unknown, isHeadliner: boolean) => {
    for (const item of asList(value)) {
      const row =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : null;
      const name = row ? firstText(row.name) : firstText(item);
      if (!name) continue;
      const key = normalizeEventText(name);
      if (!key) continue;
      const candidate: EventCandidatePerformer = {
        name,
        type: row ? schemaTypeName(row["@type"]) : null,
        imageUrl: row ? absoluteUrl(row.image, baseUrl) : null,
        isHeadliner: isHeadliner || row?.isHeadliner === true,
      };
      const existing = performers.get(key);
      if (existing) {
        existing.type ??= candidate.type;
        existing.imageUrl ??= candidate.imageUrl;
        existing.isHeadliner = existing.isHeadliner === true || candidate.isHeadliner === true;
      } else {
        performers.set(key, candidate);
      }
      if (performers.size >= 100) return;
    }
  };
  add(node.performer, false);
  add(node.performers, false);
  add(node.actor, false);
  add(node.actors, false);
  // `headliner` is not inferred from performer ordering. It is honored only
  // when the publisher labels the performer explicitly.
  add(node.headliner, true);
  return [...performers.values()];
}

function formattedAge(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

function ageNumber(value: unknown): number | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return safeNumber((value as Record<string, unknown>).value, 0, 150);
  }
  return safeNumber(value, 0, 150);
}

function jsonLdAgeRestriction(node: Record<string, unknown>): string | null {
  const direct = cleanEventText(firstText(node.typicalAgeRange ?? node.ageRestriction), 80);
  if (direct) return direct;
  for (const value of asList(node.audience)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const audience = value as Record<string, unknown>;
    const range = cleanEventText(firstText(audience.typicalAgeRange), 80);
    if (range) return range;
    const minimum = ageNumber(audience.suggestedMinAge);
    const maximum = ageNumber(audience.suggestedMaxAge);
    if (minimum != null && maximum != null && minimum <= maximum) {
      return minimum === maximum
        ? formattedAge(minimum)
        : `${formattedAge(minimum)}-${formattedAge(maximum)}`;
    }
    if (minimum != null && maximum == null) return `${formattedAge(minimum)}+`;
    if (maximum != null && minimum == null) return `<=${formattedAge(maximum)}`;
  }
  return null;
}

function jsonLdVenueUrl(location: Record<string, unknown>, baseUrl: string): string | null {
  const direct = absoluteUrl(location.url ?? location.sameAs, baseUrl);
  if (direct) return direct;
  const identifier = firstText(location["@id"]);
  return /^https?:\/\//i.test(identifier) ? canonicalEventUrl(identifier, baseUrl) : null;
}

type AccessibilityFlag = "wheelchair" | "hearingLoop" | "signLanguage" | "quietSpace";

const ACCESSIBILITY_FEATURES: Record<AccessibilityFlag, Set<string>> = {
  wheelchair: new Set([
    "wheelchair",
    "wheelchairaccess",
    "wheelchairaccessible",
    "wheelchairaccessibility",
  ]),
  hearingLoop: new Set(["hearingloop", "inductionloop", "audioinductionloop"]),
  signLanguage: new Set(["signlanguage", "signlanguageinterpretation", "signlanguageinterpreter"]),
  quietSpace: new Set(["quietspace", "sensoryfriendly", "sensoryfriendlyspace"]),
};

function accessibilityFlag(value: unknown): AccessibilityFlag | null {
  const feature = normalizeEventText(value).replace(/\s+/g, "");
  if (!feature) return null;
  for (const [flag, names] of Object.entries(ACCESSIBILITY_FEATURES) as Array<
    [AccessibilityFlag, Set<string>]
  >) {
    if (names.has(feature)) return flag;
  }
  return null;
}

function explicitBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const literal = (value as Record<string, unknown>)["@value"];
    return typeof literal === "boolean" ? literal : null;
  }
  return null;
}

function jsonLdAccessibility(
  node: Record<string, unknown>,
  location: Record<string, unknown>,
): EventCandidateAccessibility | null {
  const flags: Record<AccessibilityFlag, boolean | null> = {
    wheelchair: null,
    hearingLoop: null,
    signLanguage: null,
    quietSpace: null,
  };
  const readFeatures = (value: unknown, requireTrueValue: boolean) => {
    for (const item of asList(value)) {
      if (typeof item === "string") {
        if (requireTrueValue) continue;
        const flag = accessibilityFlag(item);
        if (flag) flags[flag] = true;
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const enabled = explicitBoolean(row.value);
      if (enabled === false || (requireTrueValue && enabled !== true)) continue;
      const flag = accessibilityFlag(row.name ?? row.valueReference);
      if (flag) flags[flag] = true;
    }
  };
  readFeatures(node.accessibilityFeature, false);
  readFeatures(location.accessibilityFeature, false);
  readFeatures(node.amenityFeature, true);
  readFeatures(location.amenityFeature, true);

  const explicitProperties: Array<[AccessibilityFlag, unknown[]]> = [
    ["wheelchair", [node.wheelchairAccessible, location.wheelchairAccessible]],
    ["hearingLoop", [node.hearingLoop, location.hearingLoop]],
    ["signLanguage", [node.signLanguage, location.signLanguage]],
    ["quietSpace", [node.quietSpace, location.quietSpace]],
  ];
  for (const [flag, values] of explicitProperties) {
    for (const value of values) {
      const enabled = explicitBoolean(value);
      if (enabled != null) flags[flag] = enabled;
    }
  }

  const notes =
    [
      ...new Set(
        [node.accessibilitySummary, location.accessibilitySummary]
          .map((value) => cleanEventText(firstText(value), 1_000))
          .filter(Boolean),
      ),
    ]
      .join(" · ")
      .slice(0, 1_000) || null;
  if (Object.values(flags).every((value) => value == null) && !notes) return null;
  return {
    wheelchair: flags.wheelchair ?? false,
    hearingLoop: flags.hearingLoop ?? false,
    signLanguage: flags.signLanguage ?? false,
    quietSpace: flags.quietSpace ?? false,
    notes,
  };
}

function walkJson(value: unknown): unknown[] {
  const output: unknown[] = [value];
  if (Array.isArray(value)) {
    for (const item of value) output.push(...walkJson(item));
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      output.push(...walkJson(item));
    }
  }
  return output;
}

function isJsonLdEvent(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>)["@type"];
  return asList(type).some(
    (item) => typeof item === "string" && item.toLowerCase().endsWith("event"),
  );
}

function decodeJsonDocuments(value: string): unknown[] {
  const cleaned = value.trim().replace(/^<!--/, "").replace(/-->$/, "").trim().replace(/;$/, "");
  if (!cleaned) return [];
  try {
    return [JSON.parse(cleaned)];
  } catch {
    const documents: unknown[] = [];
    for (let start = 0; start < cleaned.length; start += 1) {
      if (cleaned[start] !== "{" && cleaned[start] !== "[") continue;
      for (let end = cleaned.length; end > start; end -= 1) {
        const last = cleaned[end - 1];
        if (last !== "}" && last !== "]") continue;
        try {
          documents.push(JSON.parse(cleaned.slice(start, end)));
          start = end - 1;
          break;
        } catch {
          // Continue scanning malformed concatenated JSON-LD blocks.
        }
      }
    }
    return documents;
  }
}

function jsonLdCandidate(
  node: Record<string, unknown>,
  pageUrl: string,
  source: EventSourceContext,
): EventCandidate | null {
  const title = firstText(node.name ?? node.headline);
  if (!title) return null;
  const locationValue = Array.isArray(node.location)
    ? node.location.find((item) => item && typeof item === "object")
    : node.location;
  const location =
    locationValue && typeof locationValue === "object"
      ? (locationValue as Record<string, unknown>)
      : ({ name: firstText(locationValue) } as Record<string, unknown>);
  const addressValue = location.address;
  const addressRow =
    addressValue && typeof addressValue === "object" && !Array.isArray(addressValue)
      ? (addressValue as Record<string, unknown>)
      : null;
  const address = addressRow
    ? [addressRow.streetAddress, addressRow.postalCode, addressRow.addressLocality]
        .map(firstText)
        .filter(Boolean)
        .join(", ")
    : firstText(addressValue);
  const geo =
    location.geo && typeof location.geo === "object" && !Array.isArray(location.geo)
      ? (location.geo as Record<string, unknown>)
      : {};
  const offers = offerData(node.offers, pageUrl);
  const identifierValue = node.identifier;
  const externalId =
    identifierValue && typeof identifierValue === "object" && !Array.isArray(identifierValue)
      ? firstText((identifierValue as Record<string, unknown>).value ?? identifierValue)
      : firstText(identifierValue ?? node["@id"]);
  const organizer =
    node.organizer && typeof node.organizer === "object" && !Array.isArray(node.organizer)
      ? (node.organizer as Record<string, unknown>)
      : {};
  const imageUrls = asList(node.image)
    .map((image) => absoluteUrl(imageUrlValue(image), pageUrl))
    .filter((url): url is string => Boolean(url));
  const performers = jsonLdPerformers(node, pageUrl);
  const accessibility = jsonLdAccessibility(node, location);
  const categories = asList(node.eventType ?? node.category)
    .map(firstText)
    .filter(Boolean);
  const schedule =
    node.eventSchedule &&
    typeof node.eventSchedule === "object" &&
    !Array.isArray(node.eventSchedule)
      ? (node.eventSchedule as Record<string, unknown>)
      : {};
  return {
    externalId,
    title,
    description: firstText(node.description),
    startDate: firstText(node.startDate),
    endDate: firstText(node.endDate),
    timezone: firstText(schedule.scheduleTimezone) || source.city?.timezone,
    timePrecision: /^\d{4}-\d{2}-\d{2}$/.test(firstText(node.startDate)) ? "date" : "exact",
    allDay: /^\d{4}-\d{2}-\d{2}$/.test(firstText(node.startDate)),
    venueName: firstText(location.name),
    venueUrl: jsonLdVenueUrl(location, pageUrl),
    address,
    postalCode: firstText(addressRow?.postalCode),
    city: firstText(addressRow?.addressLocality) || source.city?.name,
    region: firstText(addressRow?.addressRegion),
    countryCode: firstText(addressRow?.addressCountry),
    latitude: numericValue(geo.latitude),
    longitude: numericValue(geo.longitude),
    organizerName: firstText(node.organizer),
    organizerUrl: absoluteUrl(organizer.url ?? organizer["@id"], pageUrl),
    status: firstText(node.eventStatus),
    language: firstText(node.inLanguage),
    category: categories[0] ?? null,
    genres: categories,
    performers,
    ageRestriction: jsonLdAgeRestriction(node),
    accessibility,
    priceMin: offers.priceMin,
    priceMax: offers.priceMax,
    currency: offers.currency,
    ticketUrl: offers.ticketUrl,
    imageUrls,
    isFree:
      typeof node.isAccessibleForFree === "boolean"
        ? node.isAccessibleForFree
        : offers.priceMin === 0,
    sourceUrl: absoluteUrl(node.url ?? node["@id"], pageUrl) ?? pageUrl,
    extractionMethod: "jsonld",
  };
}

export function extractJsonLdCandidates(
  html: string | null | undefined,
  pageUrl: string,
  source: EventSourceContext,
): EventCandidate[] {
  if (!html) return [];
  const scripts = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  const output: EventCandidate[] = [];
  const seen = new Set<string>();
  for (const match of scripts) {
    for (const document of decodeJsonDocuments(match[1] ?? "")) {
      for (const value of walkJson(document)) {
        if (!isJsonLdEvent(value)) continue;
        const event = jsonLdCandidate(value, pageUrl, source);
        if (!event) continue;
        const key = `${event.externalId ?? ""}|${event.startDate ?? ""}|${normalizeEventText(event.title)}`;
        if (!seen.has(key)) {
          seen.add(key);
          output.push(event);
        }
      }
    }
  }
  return output;
}

function bigrams(value: string): Map<string, number> {
  const normalized = normalizeEventText(value).replace(/\s+/g, " ");
  const result = new Map<string, number>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const pair = normalized.slice(index, index + 2);
    result.set(pair, (result.get(pair) ?? 0) + 1);
  }
  return result;
}

function similarity(left: string, right: string): number {
  const first = bigrams(left);
  const second = bigrams(right);
  const firstSize = [...first.values()].reduce((sum, value) => sum + value, 0);
  const secondSize = [...second.values()].reduce((sum, value) => sum + value, 0);
  if (!firstSize || !secondSize)
    return normalizeEventText(left) === normalizeEventText(right) ? 1 : 0;
  let overlap = 0;
  for (const [pair, count] of first) overlap += Math.min(count, second.get(pair) ?? 0);
  return (2 * overlap) / (firstSize + secondSize);
}

function mergeNormalizedPerformers(
  left: NormalizedEventPerformer[],
  right: NormalizedEventPerformer[],
): NormalizedEventPerformer[] {
  const performers = new Map<string, NormalizedEventPerformer>();
  for (const performer of [...left, ...right]) {
    const key = normalizeEventText(performer.name);
    if (!key) continue;
    const existing = performers.get(key);
    if (existing) {
      existing.type ??= performer.type;
      existing.imageUrl ??= performer.imageUrl;
      existing.isHeadliner ||= performer.isHeadliner;
    } else {
      performers.set(key, { ...performer });
    }
  }
  return [...performers.values()].slice(0, 100);
}

function mergeNormalizedAccessibility(
  left: NormalizedEventAccessibility | null,
  right: NormalizedEventAccessibility | null,
): NormalizedEventAccessibility | null {
  if (!left) return right ? { ...right } : null;
  if (!right) return { ...left };
  const notes = !left.notes
    ? right.notes
    : !right.notes || left.notes.length >= right.notes.length
      ? left.notes
      : right.notes;
  return {
    wheelchair: left.wheelchair || right.wheelchair,
    hearingLoop: left.hearingLoop || right.hearingLoop,
    signLanguage: left.signLanguage || right.signLanguage,
    quietSpace: left.quietSpace || right.quietSpace,
    notes,
  };
}

function mergeNormalizedEvents(left: NormalizedEvent, right: NormalizedEvent): NormalizedEvent {
  const rightIsPrimary = right.qualityScore > left.qualityScore;
  const primary = { ...(rightIsPrimary ? right : left) };
  const secondary = rightIsPrimary ? left : right;
  const prefer = (current: string | null, candidate: string | null) => {
    if (!current) return candidate;
    if (!candidate) return current;
    return candidate.length > current.length ? candidate : current;
  };
  primary.description = prefer(primary.description, secondary.description);
  primary.venueName = prefer(primary.venueName, secondary.venueName);
  primary.venueUrl ??= secondary.venueUrl;
  primary.address = prefer(primary.address, secondary.address);
  primary.postalCode = prefer(primary.postalCode, secondary.postalCode);
  primary.organizerName = prefer(primary.organizerName, secondary.organizerName);
  primary.ticketUrl ??= secondary.ticketUrl;
  primary.imageUrl ??= secondary.imageUrl;
  primary.endDate ??= secondary.endDate;
  primary.latitude ??= secondary.latitude;
  primary.longitude ??= secondary.longitude;
  primary.externalId ??= secondary.externalId;
  primary.genres = [...new Set([...primary.genres, ...secondary.genres])].slice(0, 8);
  primary.performers = mergeNormalizedPerformers(primary.performers, secondary.performers);
  primary.ageRestriction = prefer(primary.ageRestriction, secondary.ageRestriction);
  primary.accessibility = mergeNormalizedAccessibility(
    primary.accessibility,
    secondary.accessibility,
  );
  primary.warnings = [...new Set([...primary.warnings, ...secondary.warnings])];
  primary.qualityScore = Math.max(primary.qualityScore, secondary.qualityScore);
  if (primary.currency === secondary.currency || !primary.currency || !secondary.currency) {
    const minimums = [primary.priceMin, secondary.priceMin].filter(
      (value): value is number => value != null,
    );
    const maximums = [primary.priceMax, secondary.priceMax].filter(
      (value): value is number => value != null,
    );
    primary.priceMin = minimums.length ? Math.min(...minimums) : null;
    primary.priceMax = maximums.length ? Math.max(...maximums) : null;
    primary.currency ??= secondary.currency;
  }
  primary.isFree ||= secondary.isFree;
  if (secondary.status !== "scheduled") primary.status = secondary.status;
  return primary;
}

export function deduplicateNormalizedEvents(events: NormalizedEvent[]): {
  events: NormalizedEvent[];
  duplicates: number;
  review: Array<{ left: string; right: string; score: number }>;
} {
  const output: NormalizedEvent[] = [];
  const exact = new Map<string, number>();
  const review: Array<{ left: string; right: string; score: number }> = [];
  let duplicates = 0;
  for (const event of events) {
    const exactKey = `${event.externalId ?? event.sourceUrl}|${event.startDate.slice(0, 16)}`;
    const exactIndex = exact.get(exactKey);
    if (exactIndex != null) {
      output[exactIndex] = mergeNormalizedEvents(output[exactIndex], event);
      duplicates += 1;
      continue;
    }
    let bestIndex = -1;
    let bestScore = 0;
    for (let index = 0; index < output.length; index += 1) {
      const candidate = output[index];
      const timeDelta = Math.abs(Date.parse(candidate.startDate) - Date.parse(event.startDate));
      if (timeDelta > 4 * 3_600_000) continue;
      const titleScore = similarity(candidate.title, event.title);
      if (titleScore < 0.7) continue;
      const venueScore =
        candidate.venueName && event.venueName
          ? similarity(candidate.venueName, event.venueName)
          : 0;
      const dateScore = Math.max(0, 1 - timeDelta / (4 * 3_600_000));
      const score =
        candidate.venueName && event.venueName
          ? 0.55 * titleScore + 0.25 * dateScore + 0.2 * venueScore
          : 0.7 * titleScore + 0.3 * dateScore;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    const timeDelta =
      bestIndex >= 0
        ? Math.abs(Date.parse(output[bestIndex].startDate) - Date.parse(event.startDate))
        : Number.POSITIVE_INFINITY;
    if (bestIndex >= 0 && bestScore >= 0.92 && timeDelta <= 15 * 60_000) {
      output[bestIndex] = mergeNormalizedEvents(output[bestIndex], event);
      exact.set(exactKey, bestIndex);
      duplicates += 1;
    } else {
      if (bestIndex >= 0 && bestScore >= 0.78) {
        review.push({
          left: output[bestIndex].externalId ?? output[bestIndex].fingerprint,
          right: event.externalId ?? event.fingerprint,
          score: Math.round(bestScore * 1_000) / 1_000,
        });
      }
      exact.set(exactKey, output.length);
      output.push(event);
    }
  }
  return { events: output, duplicates, review };
}
