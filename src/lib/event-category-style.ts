import type maplibregl from "maplibre-gl";

export type EventCategoryVisual = {
  color: string;
  icon: string;
  imageId: string;
};

const DEFAULT_CATEGORY = "other";

const CATEGORY_VISUALS: Record<string, EventCategoryVisual> = {
  concerts: { color: "#e11d48", icon: "🎸", imageId: "event-category-concerts" },
  festivals: { color: "#f97316", icon: "🎪", imageId: "event-category-festivals" },
  expositions: { color: "#8b5cf6", icon: "🖼️", imageId: "event-category-expositions" },
  soirees: { color: "#4338ca", icon: "🌙", imageId: "event-category-soirees" },
  theatre: { color: "#db2777", icon: "🎭", imageId: "event-category-theatre" },
  famille: { color: "#0284c7", icon: "👪", imageId: "event-category-famille" },
  "sports-outdoor": {
    color: "#15803d",
    icon: "🏃",
    imageId: "event-category-sports-outdoor",
  },
  heritage: { color: "#a16207", icon: "🏛️", imageId: "event-category-heritage" },
  gastronomy: { color: "#c2410c", icon: "🍴", imageId: "event-category-gastronomy" },
  activities: { color: "#0f766e", icon: "🛠️", imageId: "event-category-activities" },
  conferences: { color: "#2563eb", icon: "🎤", imageId: "event-category-conferences" },
  cinema: { color: "#334155", icon: "🎬", imageId: "event-category-cinema" },
  leisure: { color: "#0d9488", icon: "🎯", imageId: "event-category-leisure" },
  other: { color: "#64748b", icon: "✨", imageId: "event-category-other" },
};

const CATEGORY_ALIASES: Record<string, string> = {
  concert: "concerts",
  festival: "festivals",
  exhibition: "expositions",
  exposition: "expositions",
  nightlife: "soirees",
  party: "soirees",
  parties: "soirees",
  soiree: "soirees",
  family: "famille",
  sport: "sports-outdoor",
  sports: "sports-outdoor",
  outdoor: "sports-outdoor",
  patrimoine: "heritage",
  gastronomie: "gastronomy",
  activity: "activities",
  activity_workshop: "activities",
  workshop: "activities",
  conference: "conferences",
  comedy: "theatre",
  dance: "theatre",
  film: "cinema",
  games: "leisure",
  loisirs: "leisure",
  autre: "other",
};

export function normalizeEventCategorySlug(slug: string | null | undefined): string {
  const normalized = slug?.trim().toLocaleLowerCase("fr") || DEFAULT_CATEGORY;
  const canonical = CATEGORY_ALIASES[normalized] ?? normalized;
  return CATEGORY_VISUALS[canonical] ? canonical : DEFAULT_CATEGORY;
}

export function eventCategoryVisual(slug: string | null | undefined): EventCategoryVisual {
  return CATEGORY_VISUALS[normalizeEventCategorySlug(slug)];
}

export function eventCategoryTextColor(slug: string | null | undefined): "#ffffff" | "#111827" {
  const color = eventCategoryVisual(slug).color;
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  const luminance = channels
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const whiteContrast = 1.05 / (luminance + 0.05);
  return whiteContrast >= 4.5 ? "#ffffff" : "#111827";
}

export function eventCategoryVisuals(): readonly EventCategoryVisual[] {
  return Object.values(CATEGORY_VISUALS);
}

/**
 * MapLibre's OSM fallback glyph endpoint does not contain every emoji. Render
 * the category symbols once on a canvas and register them as bitmap icons so
 * the same recognizable marker works with Mapbox, OSM and mobile WebGL.
 */
export function registerEventCategoryImages(map: maplibregl.Map): void {
  if (typeof document === "undefined") return;

  for (const visual of eventCategoryVisuals()) {
    if (map.hasImage(visual.imageId)) continue;
    const canvas = document.createElement("canvas");
    const pixelRatio = 2;
    const logicalSize = 36;
    canvas.width = logicalSize * pixelRatio;
    canvas.height = logicalSize * pixelRatio;
    const context = canvas.getContext("2d");
    if (!context) continue;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `${24 * pixelRatio}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    context.fillText(visual.icon, canvas.width / 2, canvas.height / 2 + pixelRatio / 2);
    map.addImage(visual.imageId, context.getImageData(0, 0, canvas.width, canvas.height), {
      pixelRatio,
    });
  }
}
