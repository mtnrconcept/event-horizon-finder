import { readFileSync, writeFileSync } from "node:fs";

const path = "supabase/functions/_shared/ladecadanse-adapter.ts";
const source = readFileSync(path, "utf8");
const start = source.indexOf("function eventAddress(");
const end = source.indexOf("\nfunction eventPrice(", start);

if (start < 0 || end < 0 || end <= start) {
  throw new Error("Unable to locate the La Décadanse eventAddress implementation");
}

const replacement = `function eventAddressCandidateScore(
  value: string,
  venue: { name: string } | null,
): number {
  const normalized = normalizeEventText(value);
  if (!normalized) return -1;
  if (venue && normalized === normalizeEventText(venue.name)) return -1;
  if (
    /(?:voir sur le plan|www\\.|https?:|ajouter a un agenda)/i.test(normalized) ||
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
    /\\b(?:rue|route|rte|chemin|ch|quai|place|pl|avenue|av|boulevard|bd|sentier|parc|impasse|passage|promenade|esplanade|allee|cours|square|faubourg|voie|montee)\\b/.test(
      normalized,
    )
  ) {
    score += 6;
  }
  if (postalCodeFromAddress(value)) score += 4;
  if (/\\b(?:geneve|carouge|lancy|meyrin|vernier|thonex|chene|vaud|france|suisse|switzerland)\\b/.test(normalized)) {
    score += 2;
  }
  if (/\\b\\d{1,4}[a-z]?\\b/.test(normalized)) score += 1;
  if (/\\s[-–—]\\s/.test(value)) score += 1;
  return score;
}

function eventAddress(html: string, venue: { name: string } | null): string | null {
  const h1 = /<h1\\b[^>]*>[\\s\\S]*?<\\/h1>/i.exec(html);
  const section =
    h1 && h1.index != null
      ? html.slice(h1.index + h1[0].length, h1.index + h1[0].length + 6_000)
      : html;
  const candidates = [...section.matchAll(/<li\\b[^>]*>([\\s\\S]*?)<\\/li>/gi)]
    .map((match) => htmlText(match[1], 500))
    .filter(Boolean)
    .map((value) => ({ value, score: eventAddressCandidateScore(value, venue) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.value ?? null;
}
`;

writeFileSync(path, `${source.slice(0, start)}${replacement}${source.slice(end)}`);
