import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type EventRow = {
  id: string;
  title: string;
  short_description: string | null;
  updated_at: string;
  category: { slug: string; name_fr: string } | null;
  organizer: { name: string } | null;
  venue: { name: string; city: { name: string } | null } | null;
  occurrences: Array<{ starts_at: string; timezone: string }>;
};

type Palette = {
  start: string;
  middle: string;
  end: string;
  accent: string;
  accent2: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PALETTES: Record<string, Palette> = {
  soirees: {
    start: "#13072b",
    middle: "#501071",
    end: "#061a3f",
    accent: "#ff4fd8",
    accent2: "#4de7ff",
  },
  concerts: {
    start: "#240817",
    middle: "#751d3c",
    end: "#171343",
    accent: "#ffb13b",
    accent2: "#ff4f8b",
  },
  festivals: {
    start: "#062b35",
    middle: "#14645f",
    end: "#3b174f",
    accent: "#ffd84a",
    accent2: "#ff6e83",
  },
  theatre: {
    start: "#20080f",
    middle: "#65162b",
    end: "#1a1237",
    accent: "#ffd078",
    accent2: "#ef5d75",
  },
  expositions: {
    start: "#092438",
    middle: "#28527a",
    end: "#30153f",
    accent: "#7de1ff",
    accent2: "#ff8dc7",
  },
  famille: {
    start: "#17213f",
    middle: "#315a7b",
    end: "#4b1d55",
    accent: "#ffe16b",
    accent2: "#64e5c2",
  },
};

const FALLBACK_PALETTE = PALETTES.soirees;
const memoryCache = new Map<string, { etag: string; svg: string }>();

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function clean(value: string | null | undefined, maxLength: number): string {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function wrapTitle(title: string, maxCharacters = 27, maxLines = 3): string[] {
  const words = clean(title, 180).split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharacters || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) break;
  }

  const consumed = lines.join(" ").split(" ").filter(Boolean).length;
  if (current && lines.length < maxLines) {
    const hasMore = consumed + current.split(" ").length < words.length;
    const available = Math.max(4, maxCharacters - (hasMore ? 1 : 0));
    lines.push(`${current.slice(0, available)}${hasMore || current.length > available ? "…" : ""}`);
  }

  return lines.length ? lines : ["ÉVÉNEMENT"];
}

function categoryLabel(event: EventRow): string {
  return clean(event.category?.name_fr, 40) || "Événement";
}

function formatDate(event: EventRow): string {
  const next = [...(event.occurrences ?? [])]
    .filter((occurrence) => Number.isFinite(Date.parse(occurrence.starts_at)))
    .sort((left, right) => left.starts_at.localeCompare(right.starts_at))[0];
  if (!next) return "Date à confirmer";
  try {
    return new Intl.DateTimeFormat("fr-CH", {
      timeZone: clean(next.timezone, 80) || "Europe/Zurich",
      weekday: "short",
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(next.starts_at));
  } catch {
    return new Intl.DateTimeFormat("fr-CH", {
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(next.starts_at));
  }
}

function locationLabel(event: EventRow): string {
  const venue = clean(event.venue?.name, 70);
  const city = clean(event.venue?.city?.name, 50);
  const organizer = clean(event.organizer?.name, 70);
  return [venue, city].filter(Boolean).join(" · ") || organizer || "Lieu à confirmer";
}

function visualMotif(category: string, palette: Palette, seed: number): string {
  const bars = Array.from({ length: 18 }, (_, index) => {
    const height = 45 + (((seed >>> (index % 16)) + index * 31) % 155);
    const x = 650 + index * 31;
    return `<rect x="${x}" y="${590 - height}" width="12" height="${height}" rx="6" fill="url(#bars)" opacity="${0.2 + (index % 4) * 0.12}"/>`;
  }).join("");

  if (category === "festivals") {
    return `<circle cx="930" cy="208" r="116" fill="none" stroke="${palette.accent}" stroke-width="5" opacity=".45"/>
      <circle cx="930" cy="208" r="72" fill="none" stroke="${palette.accent2}" stroke-width="3" opacity=".38"/>
      <path d="M930 92v232M814 208h232M848 126l164 164M1012 126L848 290" stroke="white" stroke-width="2" opacity=".22"/>
      ${bars}`;
  }
  if (category === "theatre") {
    return `<path d="M760 0c20 190 38 318 168 410C805 470 723 567 704 750H1200V0Z" fill="${palette.accent2}" opacity=".2"/>
      <path d="M1200 0c-25 180-82 316-214 405 132 70 195 186 214 345Z" fill="${palette.accent}" opacity=".16"/>
      <ellipse cx="930" cy="520" rx="260" ry="80" fill="url(#spotlight)" opacity=".38"/>`;
  }
  return `<path d="M640 545c110-100 190-185 285-365M760 620c90-150 198-255 356-390" stroke="${palette.accent2}" stroke-width="5" opacity=".2"/>
    ${bars}`;
}

function renderSvg(event: EventRow): string {
  const category = clean(event.category?.slug, 30) || "soirees";
  const palette = PALETTES[category] ?? FALLBACK_PALETTE;
  const seed = hash(`${event.id}:${event.title}`);
  const titleLines = wrapTitle(event.title);
  const titleSize = titleLines.length === 1 ? 84 : titleLines.length === 2 ? 70 : 58;
  const lineHeight = Math.round(titleSize * 1.02);
  const titleY = 300 - (titleLines.length - 1) * (lineHeight / 2);
  const title = titleLines
    .map(
      (line, index) =>
        `<text x="74" y="${titleY + index * lineHeight}" font-size="${titleSize}" font-weight="900" letter-spacing="-2">${xml(line)}</text>`,
    )
    .join("");
  const label = categoryLabel(event).toLocaleUpperCase("fr-CH");
  const date = formatDate(event);
  const location = locationLabel(event);
  const motif = visualMotif(category, palette, seed);
  const orbX = 820 + (seed % 230);
  const orbY = 120 + ((seed >>> 8) % 170);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750" viewBox="0 0 1200 750" role="img" aria-label="Illustration de ${xml(clean(event.title, 140))}">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${palette.start}"/>
      <stop offset=".52" stop-color="${palette.middle}"/>
      <stop offset="1" stop-color="${palette.end}"/>
    </linearGradient>
    <linearGradient id="bars" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="${palette.accent}"/>
      <stop offset="1" stop-color="${palette.accent2}"/>
    </linearGradient>
    <radialGradient id="orb">
      <stop stop-color="${palette.accent}" stop-opacity=".72"/>
      <stop offset="1" stop-color="${palette.accent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="spotlight">
      <stop stop-color="${palette.accent}" stop-opacity=".55"/>
      <stop offset="1" stop-color="${palette.accent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" seed="${seed % 91}" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="table" tableValues="0 .1"/></feComponentTransfer>
    </filter>
    <filter id="blur"><feGaussianBlur stdDeviation="34"/></filter>
  </defs>
  <rect width="1200" height="750" fill="url(#background)"/>
  <circle cx="${orbX}" cy="${orbY}" r="285" fill="url(#orb)" filter="url(#blur)" opacity=".7"/>
  <circle cx="150" cy="690" r="250" fill="${palette.accent2}" filter="url(#blur)" opacity=".12"/>
  ${motif}
  <rect width="1200" height="750" filter="url(#grain)" opacity=".42"/>
  <g font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" fill="white">
  <g>
    <rect x="74" y="66" width="${Math.max(210, 32 + label.length * 14)}" height="46" rx="23" fill="white" opacity=".13"/>
    <circle cx="99" cy="89" r="7" fill="${palette.accent}"/>
    <text x="118" y="97" font-size="18" font-weight="800" letter-spacing="2">${xml(label)}</text>
  </g>
  ${title}
  <g transform="translate(74 578)">
    <rect width="1052" height="112" rx="30" fill="#050713" opacity=".42" stroke="white" stroke-opacity=".12"/>
    <text x="30" y="46" font-size="22" font-weight="650">${xml(date)}</text>
    <text x="30" y="79" font-size="18" opacity=".76">${xml(location)}</text>
    <text x="985" y="67" text-anchor="end" font-size="16" font-weight="800" letter-spacing="2" opacity=".58">EVENTA</text>
  </g>
  </g>
</svg>`;
}

function response(svg: string, etag: string, status = 200): Response {
  return new Response(status === 304 ? null : svg, {
    status,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      ETag: etag,
      "Access-Control-Allow-Origin": "*",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" },
    });
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const eventId = new URL(request.url).searchParams.get("id") ?? "";
  if (!UUID_PATTERN.test(eventId)) return new Response("Invalid event id", { status: 400 });

  const cached = memoryCache.get(eventId);
  if (cached) {
    if (request.headers.get("if-none-match") === cached.etag) return response("", cached.etag, 304);
    return response(cached.svg, cached.etag);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serverKey =
    Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serverKey) return new Response("Service unavailable", { status: 503 });

  const endpoint = new URL(`${supabaseUrl}/rest/v1/events`);
  endpoint.searchParams.set(
    "select",
    "id,title,short_description,updated_at,category:event_categories(slug,name_fr),organizer:organizers(name),venue:venues(name,city:cities(name)),occurrences:event_occurrences(starts_at,timezone)",
  );
  endpoint.searchParams.set("id", `eq.${eventId}`);
  endpoint.searchParams.set("status", "eq.published");
  endpoint.searchParams.set("is_demo", "eq.false");
  endpoint.searchParams.set("limit", "1");

  const headers = new Headers({ apikey: serverKey, Accept: "application/json" });
  if (!serverKey.startsWith("sb_secret_")) headers.set("Authorization", `Bearer ${serverKey}`);

  const databaseResponse = await fetch(endpoint, { headers });
  if (!databaseResponse.ok) return new Response("Service unavailable", { status: 503 });
  const rows = (await databaseResponse.json()) as EventRow[];
  const event = rows[0];
  if (!event) return new Response("Event not found", { status: 404 });

  const svg = renderSvg(event);
  const etag = `W/\"${hash(`${event.id}:${event.updated_at}:${svg.length}`).toString(16)}\"`;
  memoryCache.set(eventId, { etag, svg });
  if (memoryCache.size > 250) memoryCache.delete(memoryCache.keys().next().value as string);

  if (request.headers.get("if-none-match") === etag) return response("", etag, 304);
  return response(svg, etag);
});
