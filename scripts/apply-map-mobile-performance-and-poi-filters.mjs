import { readFile, writeFile } from "node:fs/promises";

const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const filtersPath = new URL("../src/lib/event-filters.ts", import.meta.url);
const panelPath = new URL("../src/components/event-filter-panel.tsx", import.meta.url);
const testPath = new URL("../tests/map-mobile-performance-poi-filters.test.ts", import.meta.url);

async function replaceOnce(path, before, after, label) {
  let source = await readFile(path, "utf8");
  if (!source.includes(before)) throw new Error(`Expected ${label} fragment was not found`);
  await writeFile(path, source.replace(before, after));
}

await replaceOnce(
  mapPath,
  `    void fetch(PRIMARY_MAP_STYLE, {\n      signal: preferredStyleController.signal,\n      cache: "force-cache",\n      mode: "cors",\n    })`,
  `    const shouldUpgradeBasemap = !isMobileRef.current && window.devicePixelRatio <= 2;\n    const preferredStyleRequest = shouldUpgradeBasemap\n      ? fetch(PRIMARY_MAP_STYLE, {\n          signal: preferredStyleController.signal,\n          cache: "force-cache",\n          mode: "cors",\n        })\n      : Promise.reject(new Error("mobile_raster_fast_path"));\n    void preferredStyleRequest`,
  "mobile raster fast path",
);

await replaceOnce(
  filtersPath,
  `export interface AdvancedEventFilters {\n  priceMode: PriceMode;`,
  `export const PLACE_CATEGORIES = [\n  ["attraction", "Attractions et monuments"],\n  ["culture", "Musées, art et patrimoine"],\n  ["nature", "Parcs, jardins et nature"],\n  ["family", "Famille et loisirs"],\n  ["sports-outdoors", "Sports et plein air"],\n  ["food-drink", "Marchés et gastronomie"],\n] as const;\n\nexport type DiscoveryContentMode = "events" | "places" | "all";\n\nexport interface AdvancedEventFilters {\n  contentMode: DiscoveryContentMode;\n  placeCategories: string[];\n  openNowOnly: boolean;\n  freePlacesOnly: boolean;\n  priceMode: PriceMode;`,
  "POI filter interface",
);

await replaceOnce(
  filtersPath,
  `export const DEFAULT_ADVANCED_FILTERS: AdvancedEventFilters = {\n  priceMode: "all",`,
  `export const DEFAULT_ADVANCED_FILTERS: AdvancedEventFilters = {\n  contentMode: "events",\n  placeCategories: [],\n  openNowOnly: false,\n  freePlacesOnly: false,\n  priceMode: "all",`,
  "POI filter defaults",
);

await replaceOnce(
  filtersPath,
  `  return {\n    ...price,`,
  `  return {\n    contentMode: filters.contentMode,\n    placeCategories: filters.placeCategories.length ? [...new Set(filters.placeCategories)] : null,\n    openNowOnly: filters.openNowOnly,\n    freePlacesOnly: filters.freePlacesOnly,\n    ...price,`,
  "POI discovery projection",
);

await replaceOnce(
  filtersPath,
  `  return (\n    Number(filters.priceMode !== "all") +`,
  `  return (\n    Number(filters.contentMode !== "events") +\n    filters.placeCategories.length +\n    Number(filters.openNowOnly) +\n    Number(filters.freePlacesOnly) +\n    Number(filters.priceMode !== "all") +`,
  "POI active count",
);

await replaceOnce(
  panelPath,
  `import { BadgeCheck, MapPinCheck, TicketCheck, Accessibility } from "lucide-react";\nimport { type AdvancedEventFilters, type CapacityMode, type PriceMode } from "@/lib/event-filters";`,
  `import { BadgeCheck, MapPinCheck, TicketCheck, Accessibility, Landmark, Clock3, CircleDollarSign } from "lucide-react";\nimport { PLACE_CATEGORIES, type AdvancedEventFilters, type CapacityMode, type DiscoveryContentMode, type PriceMode } from "@/lib/event-filters";`,
  "POI panel imports",
);

await replaceOnce(
  panelPath,
  `  const toggleGenre = (genre: string) => {`,
  `  const togglePlaceCategory = (category: string) => {\n    update(\n      "placeCategories",\n      value.placeCategories.includes(category)\n        ? value.placeCategories.filter((item) => item !== category)\n        : [...value.placeCategories, category],\n    );\n  };\n\n  const toggleGenre = (genre: string) => {`,
  "POI category toggle",
);

await replaceOnce(
  panelPath,
  `  return (\n    <div className={compact ? "space-y-3" : "space-y-4 rounded-3xl border bg-surface/40 p-4"}>`,
  `  return (\n    <div className={compact ? "space-y-3" : "space-y-4 rounded-3xl border bg-surface/40 p-4"}>\n      <fieldset className="rounded-2xl border bg-background/45 p-3">\n        <legend className="px-1 text-xs font-semibold">Type de contenu</legend>\n        <div className="mt-2 grid grid-cols-3 gap-1.5">\n          {[\n            ["events", "Événements"],\n            ["places", "Lieux à visiter"],\n            ["all", "Tout"],\n          ].map(([mode, label]) => (\n            <button key={mode} type="button" aria-pressed={value.contentMode === mode} onClick={() => update("contentMode", mode as DiscoveryContentMode)} className="min-h-10 rounded-xl border px-2 text-[11px] font-bold transition-colors hover:bg-accent" style={value.contentMode === mode ? { borderColor: "var(--color-primary)", color: "var(--color-primary)", background: "var(--color-accent)" } : undefined}>{label}</button>\n          ))}\n        </div>\n      </fieldset>\n\n      {value.contentMode !== "events" && (\n        <fieldset className="rounded-2xl border bg-background/45 p-3">\n          <legend className="px-1 text-xs font-semibold">Lieux d’intérêt</legend>\n          <div className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">\n            {PLACE_CATEGORIES.map(([slug, label]) => {\n              const active = value.placeCategories.includes(slug);\n              return <button key={slug} type="button" aria-pressed={active} onClick={() => togglePlaceCategory(slug)} className="min-h-9 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent" style={active ? { borderColor: "var(--color-primary)", color: "var(--color-primary)", background: "var(--color-accent)" } : undefined}><Landmark className="mr-1 inline h-3.5 w-3.5" />{label}</button>;\n            })}\n          </div>\n          <div className="mt-3 grid grid-cols-2 gap-2">\n            <FilterToggle active={value.openNowOnly} icon={Clock3} label="Ouvert maintenant" onClick={() => update("openNowOnly", !value.openNowOnly)} />\n            <FilterToggle active={value.freePlacesOnly} icon={CircleDollarSign} label="Accès gratuit" onClick={() => update("freePlacesOnly", !value.freePlacesOnly)} />\n          </div>\n        </fieldset>\n      )}`,
  "POI filter controls",
);

await writeFile(testPath, `import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\nconst map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");\nconst filters = await readFile(new URL("../src/lib/event-filters.ts", import.meta.url), "utf8");\nconst panel = await readFile(new URL("../src/components/event-filter-panel.tsx", import.meta.url), "utf8");\ntest("mobile map keeps raster fast path", () => { assert.match(map, /shouldUpgradeBasemap = !isMobileRef\\.current/); });\ntest("POI filters are shared", () => { assert.match(filters, /contentMode: DiscoveryContentMode/); assert.match(filters, /placeCategories: string\\[\\]/); });\ntest("POI controls are visible", () => { assert.match(panel, /Lieux à visiter/); assert.match(panel, /Ouvert maintenant/); assert.match(panel, /Accès gratuit/); });\n`);
