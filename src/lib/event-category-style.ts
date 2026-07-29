import type maplibregl from "maplibre-gl";

export type EventCategoryVisual = {
  slug: string;
  color: string;
  colorEnd: string;
  imageId: string;
};

const DEFAULT_CATEGORY = "other";

const CATEGORY_VISUALS: Record<string, EventCategoryVisual> = {
  concerts: {
    slug: "concerts",
    color: "#f43f5e",
    colorEnd: "#be123c",
    imageId: "event-category-concerts",
  },
  festivals: {
    slug: "festivals",
    color: "#fb923c",
    colorEnd: "#dc2626",
    imageId: "event-category-festivals",
  },
  expositions: {
    slug: "expositions",
    color: "#a855f7",
    colorEnd: "#6d28d9",
    imageId: "event-category-expositions",
  },
  soirees: {
    slug: "soirees",
    color: "#d946ef",
    colorEnd: "#5b21b6",
    imageId: "event-category-soirees",
  },
  theatre: {
    slug: "theatre",
    color: "#ec4899",
    colorEnd: "#be185d",
    imageId: "event-category-theatre",
  },
  famille: {
    slug: "famille",
    color: "#2dd4bf",
    colorEnd: "#0f766e",
    imageId: "event-category-famille",
  },
  "sports-outdoor": {
    slug: "sports-outdoor",
    color: "#a3e635",
    colorEnd: "#15803d",
    imageId: "event-category-sports-outdoor",
  },
  heritage: {
    slug: "heritage",
    color: "#c084fc",
    colorEnd: "#6b21a8",
    imageId: "event-category-heritage",
  },
  gastronomy: {
    slug: "gastronomy",
    color: "#fb923c",
    colorEnd: "#ea580c",
    imageId: "event-category-gastronomy",
  },
  activities: {
    slug: "activities",
    color: "#22d3ee",
    colorEnd: "#0369a1",
    imageId: "event-category-activities",
  },
  conferences: {
    slug: "conferences",
    color: "#60a5fa",
    colorEnd: "#1d4ed8",
    imageId: "event-category-conferences",
  },
  cinema: {
    slug: "cinema",
    color: "#94a3b8",
    colorEnd: "#334155",
    imageId: "event-category-cinema",
  },
  leisure: {
    slug: "leisure",
    color: "#34d399",
    colorEnd: "#047857",
    imageId: "event-category-leisure",
  },
  other: {
    slug: "other",
    color: "#f472b6",
    colorEnd: "#be185d",
    imageId: "event-category-other",
  },
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

const G_PIN_PATH =
  "M26 2 C12.7 2 3 12.2 3 25.2 C3 35.4 9.6 43.5 26 58 " +
  "C42.4 43.5 49 35.4 49 25.2 L49 22.6 L28.5 22.6 L28.5 30.4 L39.4 30.4 " +
  "C36.9 37 32.4 43 26 48.8 C15.3 39.3 10.1 33 10.1 25.2 " +
  "C10.1 16.1 16.9 9.1 26 9.1 C33.1 9.1 38.3 12.7 41.2 18.1 " +
  "L47.4 14.6 C42.9 6.7 35.5 2 26 2 Z";

function categoryGradient(
  context: CanvasRenderingContext2D,
  visual: EventCategoryVisual,
): CanvasGradient {
  const gradient = context.createLinearGradient(7, 6, 45, 55);
  gradient.addColorStop(0, visual.color);
  gradient.addColorStop(1, visual.colorEnd);
  return gradient;
}

function configureGlyphStroke(
  context: CanvasRenderingContext2D,
  gradient: CanvasGradient,
  width = 2.5,
): void {
  context.strokeStyle = gradient;
  context.fillStyle = gradient;
  context.lineWidth = width;
  context.lineCap = "round";
  context.lineJoin = "round";
}

function drawCategoryGlyph(
  context: CanvasRenderingContext2D,
  visual: EventCategoryVisual,
  gradient: CanvasGradient,
): void {
  configureGlyphStroke(context, gradient);
  context.save();

  switch (visual.slug) {
    case "concerts":
      context.beginPath();
      context.arc(21, 24, 5, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(26, 24);
      context.lineTo(34, 18);
      context.lineTo(34, 32);
      context.stroke();
      context.beginPath();
      context.arc(31, 33, 3, 0, Math.PI * 2);
      context.fill();
      break;
    case "festivals":
      context.beginPath();
      context.moveTo(16, 34);
      context.lineTo(26, 22);
      context.lineTo(36, 34);
      context.moveTo(18, 34);
      context.lineTo(18, 39);
      context.moveTo(34, 34);
      context.lineTo(34, 39);
      context.stroke();
      context.beginPath();
      context.moveTo(20, 18);
      context.lineTo(17, 14);
      context.moveTo(26, 17);
      context.lineTo(26, 12);
      context.moveTo(32, 18);
      context.lineTo(36, 14);
      context.stroke();
      break;
    case "expositions":
      context.strokeRect(17, 20, 18, 15);
      context.beginPath();
      context.moveTo(19, 32);
      context.lineTo(24, 27);
      context.lineTo(28, 30);
      context.lineTo(33, 24);
      context.stroke();
      break;
    case "soirees":
      context.beginPath();
      context.arc(25, 23, 5, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(18, 34);
      context.quadraticCurveTo(26, 28, 34, 34);
      context.stroke();
      context.beginPath();
      context.arc(17, 18, 1.2, 0, Math.PI * 2);
      context.arc(35, 16, 1.2, 0, Math.PI * 2);
      context.fill();
      break;
    case "theatre":
      context.beginPath();
      context.moveTo(17, 20);
      context.quadraticCurveTo(21, 17, 25, 20);
      context.lineTo(25, 34);
      context.quadraticCurveTo(21, 38, 17, 34);
      context.closePath();
      context.moveTo(27, 20);
      context.quadraticCurveTo(31, 17, 35, 20);
      context.lineTo(35, 34);
      context.quadraticCurveTo(31, 38, 27, 34);
      context.closePath();
      context.stroke();
      break;
    case "famille":
      context.beginPath();
      context.arc(21, 23, 3.5, 0, Math.PI * 2);
      context.arc(31, 25, 3, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(15, 36);
      context.quadraticCurveTo(21, 28, 27, 36);
      context.moveTo(26, 37);
      context.quadraticCurveTo(31, 30, 36, 37);
      context.stroke();
      break;
    case "sports-outdoor":
      context.beginPath();
      context.arc(27, 18, 2.6, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.moveTo(26, 22);
      context.lineTo(22, 29);
      context.lineTo(29, 31);
      context.lineTo(34, 38);
      context.moveTo(22, 29);
      context.lineTo(17, 36);
      context.moveTo(25, 24);
      context.lineTo(33, 25);
      context.stroke();
      break;
    case "heritage":
      context.beginPath();
      context.moveTo(16, 22);
      context.lineTo(26, 16);
      context.lineTo(36, 22);
      context.closePath();
      context.moveTo(18, 24);
      context.lineTo(34, 24);
      context.moveTo(20, 25);
      context.lineTo(20, 36);
      context.moveTo(26, 25);
      context.lineTo(26, 36);
      context.moveTo(32, 25);
      context.lineTo(32, 36);
      context.moveTo(17, 38);
      context.lineTo(35, 38);
      context.stroke();
      break;
    case "gastronomy":
      context.beginPath();
      context.moveTo(20, 17);
      context.lineTo(20, 36);
      context.moveTo(16, 17);
      context.lineTo(16, 24);
      context.quadraticCurveTo(20, 27, 24, 24);
      context.lineTo(24, 17);
      context.moveTo(31, 18);
      context.quadraticCurveTo(36, 24, 31, 29);
      context.lineTo(31, 37);
      context.stroke();
      break;
    case "activities":
      context.beginPath();
      context.arc(26, 27, 9, 0.2, Math.PI * 1.85);
      context.moveTo(26, 18);
      context.lineTo(26, 27);
      context.lineTo(33, 31);
      context.stroke();
      break;
    case "conferences":
      context.beginPath();
      context.moveTo(21, 18);
      context.lineTo(31, 18);
      context.quadraticCurveTo(35, 18, 35, 22);
      context.lineTo(35, 27);
      context.quadraticCurveTo(35, 31, 31, 31);
      context.lineTo(27, 31);
      context.lineTo(20, 36);
      context.lineTo(22, 31);
      context.lineTo(21, 31);
      context.quadraticCurveTo(17, 31, 17, 27);
      context.lineTo(17, 22);
      context.quadraticCurveTo(17, 18, 21, 18);
      context.stroke();
      break;
    case "cinema":
      context.strokeRect(16, 21, 20, 15);
      context.beginPath();
      context.moveTo(18, 21);
      context.lineTo(22, 17);
      context.lineTo(27, 21);
      context.lineTo(31, 17);
      context.lineTo(35, 21);
      context.stroke();
      context.beginPath();
      context.moveTo(24, 25);
      context.lineTo(31, 28.5);
      context.lineTo(24, 32);
      context.closePath();
      context.fill();
      break;
    case "leisure":
      context.beginPath();
      context.arc(26, 27, 10, 0, Math.PI * 2);
      context.arc(26, 27, 5, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(26, 27);
      context.lineTo(34, 20);
      context.stroke();
      break;
    default:
      context.beginPath();
      context.moveTo(26, 16);
      context.lineTo(29, 24);
      context.lineTo(37, 27);
      context.lineTo(29, 30);
      context.lineTo(26, 38);
      context.lineTo(23, 30);
      context.lineTo(15, 27);
      context.lineTo(23, 24);
      context.closePath();
      context.stroke();
      break;
  }

  context.restore();
}

/**
 * Register a high-density transparent GlobalParty marker for every event category.
 * The exact same G-shaped pin is used everywhere; only the gradient and the
 * minimal interior glyph change. No white disc is drawn, so the basemap remains
 * visible through the G and the category stays legible at compact map sizes.
 */
export function registerEventCategoryImages(map: maplibregl.Map): void {
  if (typeof document === "undefined" || typeof Path2D === "undefined") return;

  for (const visual of eventCategoryVisuals()) {
    if (map.hasImage(visual.imageId)) continue;

    const canvas = document.createElement("canvas");
    const pixelRatio = 3;
    const logicalWidth = 52;
    const logicalHeight = 62;
    canvas.width = logicalWidth * pixelRatio;
    canvas.height = logicalHeight * pixelRatio;

    const context = canvas.getContext("2d");
    if (!context) continue;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.scale(pixelRatio, pixelRatio);

    const gradient = categoryGradient(context, visual);
    context.shadowColor = "rgba(15, 23, 42, 0.32)";
    context.shadowBlur = 4;
    context.shadowOffsetY = 2;
    context.fillStyle = gradient;
    context.fill(new Path2D(G_PIN_PATH));

    context.shadowColor = "transparent";
    drawCategoryGlyph(context, visual, gradient);
    context.restore();

    map.addImage(visual.imageId, context.getImageData(0, 0, canvas.width, canvas.height), {
      pixelRatio,
    });
  }
}
