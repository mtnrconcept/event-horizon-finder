import { readFile, writeFile } from "node:fs/promises";

const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const filtersPath = new URL("../src/lib/event-filters.ts", import.meta.url);
const panelPath = new URL("../src/components/event-filter-panel.tsx", import.meta.url);
const i18nPath = new URL("../src/lib/i18n.tsx", import.meta.url);
const testPath = new URL("../tests/map-mobile-performance-poi-filters.test.ts", import.meta.url);

async function replaceOnce(path, before, after, label) {
  const source = await readFile(path, "utf8");
  if (!source.includes(before)) throw new Error(`Expected ${label} fragment was not found`);
  await writeFile(path, source.replace(before, after));
}

function dictionaryMarker(locale) {
  return locale === "fr" ? "const fr = {" : `const ${locale}: Dictionary = {`;
}

async function insertPoiTranslations() {
  let source = await readFile(i18nPath, "utf8");
  const translations = {
    fr: {
      contentType: "Type de contenu",
      contentEvents: "Événements",
      contentPlaces: "Lieux à visiter",
      contentAll: "Tout",
      places: "Lieux d’intérêt",
      placeAttraction: "Attractions et monuments",
      placeCulture: "Musées, art et patrimoine",
      placeNature: "Parcs, jardins et nature",
      placeFamily: "Famille et loisirs",
      placeSports: "Sports et plein air",
      placeFood: "Marchés et gastronomie",
      openNow: "Ouvert maintenant",
      freeAccess: "Accès gratuit",
    },
    en: {
      contentType: "Content type",
      contentEvents: "Events",
      contentPlaces: "Places to visit",
      contentAll: "All",
      places: "Places of interest",
      placeAttraction: "Attractions and landmarks",
      placeCulture: "Museums, art and heritage",
      placeNature: "Parks, gardens and nature",
      placeFamily: "Family and leisure",
      placeSports: "Sports and outdoors",
      placeFood: "Markets and gastronomy",
      openNow: "Open now",
      freeAccess: "Free admission",
    },
    pl: {
      contentType: "Typ treści",
      contentEvents: "Wydarzenia",
      contentPlaces: "Miejsca do odwiedzenia",
      contentAll: "Wszystko",
      places: "Ciekawe miejsca",
      placeAttraction: "Atrakcje i zabytki",
      placeCulture: "Muzea, sztuka i dziedzictwo",
      placeNature: "Parki, ogrody i natura",
      placeFamily: "Rodzina i rozrywka",
      placeSports: "Sport i aktywność na świeżym powietrzu",
      placeFood: "Targi i gastronomia",
      openNow: "Otwarte teraz",
      freeAccess: "Bezpłatny wstęp",
    },
    it: {
      contentType: "Tipo di contenuto",
      contentEvents: "Eventi",
      contentPlaces: "Luoghi da visitare",
      contentAll: "Tutto",
      places: "Luoghi di interesse",
      placeAttraction: "Attrazioni e monumenti",
      placeCulture: "Musei, arte e patrimonio",
      placeNature: "Parchi, giardini e natura",
      placeFamily: "Famiglia e tempo libero",
      placeSports: "Sport e attività all’aperto",
      placeFood: "Mercati e gastronomia",
      openNow: "Aperto ora",
      freeAccess: "Ingresso gratuito",
    },
    ru: {
      contentType: "Тип контента",
      contentEvents: "События",
      contentPlaces: "Места для посещения",
      contentAll: "Всё",
      places: "Интересные места",
      placeAttraction: "Достопримечательности и памятники",
      placeCulture: "Музеи, искусство и наследие",
      placeNature: "Парки, сады и природа",
      placeFamily: "Семья и досуг",
      placeSports: "Спорт и активный отдых",
      placeFood: "Рынки и гастрономия",
      openNow: "Открыто сейчас",
      freeAccess: "Бесплатный вход",
    },
    es: {
      contentType: "Tipo de contenido",
      contentEvents: "Eventos",
      contentPlaces: "Lugares para visitar",
      contentAll: "Todo",
      places: "Lugares de interés",
      placeAttraction: "Atracciones y monumentos",
      placeCulture: "Museos, arte y patrimonio",
      placeNature: "Parques, jardines y naturaleza",
      placeFamily: "Familia y ocio",
      placeSports: "Deportes y actividades al aire libre",
      placeFood: "Mercados y gastronomía",
      openNow: "Abierto ahora",
      freeAccess: "Acceso gratuito",
    },
  };

  const locales = Object.keys(translations);
  for (const [index, locale] of locales.entries()) {
    const start = source.indexOf(dictionaryMarker(locale));
    const nextMarker = locales[index + 1] ? dictionaryMarker(locales[index + 1]) : "const dictionaries";
    const end = source.indexOf(nextMarker, start + 1);
    if (start < 0 || end < 0) throw new Error(`Translation dictionary ${locale} was not found`);

    const dictionary = source.slice(start, end);
    const anchor = dictionary.match(/  "filters\.confirmedVenue": [^\n]+,\n/)?.[0];
    if (!anchor) throw new Error(`filters.confirmedVenue anchor was not found for ${locale}`);

    const lines = Object.entries(translations[locale])
      .map(([key, value]) => `  "filters.${key}": ${JSON.stringify(value)},`)
      .join("\n");
    const updatedDictionary = dictionary.replace(anchor, `${anchor}${lines}\n`);
    source = `${source.slice(0, start)}${updatedDictionary}${source.slice(end)}`;
  }

  await writeFile(i18nPath, source);
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
  `export const PLACE_CATEGORIES = [\n  ["attraction", "filters.placeAttraction"],\n  ["culture", "filters.placeCulture"],\n  ["nature", "filters.placeNature"],\n  ["family", "filters.placeFamily"],\n  ["sports-outdoors", "filters.placeSports"],\n  ["food-drink", "filters.placeFood"],\n] as const;\n\nexport type DiscoveryContentMode = "events" | "places" | "all";\n\nexport interface AdvancedEventFilters {\n  contentMode: DiscoveryContentMode;\n  placeCategories: string[];\n  openNowOnly: boolean;\n  freePlacesOnly: boolean;\n  priceMode: PriceMode;`,
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

await insertPoiTranslations();

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
  `  return (\n    <div className={compact ? "space-y-3" : "space-y-4 rounded-3xl border bg-surface/40 p-4"}>\n      <fieldset className="rounded-2xl border bg-background/45 p-3">\n        <legend className="px-1 text-xs font-semibold">{t("filters.contentType")}</legend>\n        <div className="mt-2 grid grid-cols-3 gap-1.5">\n          {([\n            ["events", "filters.contentEvents"],\n            ["places", "filters.contentPlaces"],\n            ["all", "filters.contentAll"],\n          ] as const).map(([mode, labelKey]) => (\n            <button key={mode} type="button" aria-pressed={value.contentMode === mode} onClick={() => update("contentMode", mode as DiscoveryContentMode)} className="min-h-10 rounded-xl border px-2 text-[11px] font-bold transition-colors hover:bg-accent" style={value.contentMode === mode ? { borderColor: "var(--color-primary)", color: "var(--color-primary)", background: "var(--color-accent)" } : undefined}>{t(labelKey)}</button>\n          ))}\n        </div>\n      </fieldset>\n\n      {value.contentMode !== "events" && (\n        <fieldset className="rounded-2xl border bg-background/45 p-3">\n          <legend className="px-1 text-xs font-semibold">{t("filters.places")}</legend>\n          <div className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">\n            {PLACE_CATEGORIES.map(([slug, labelKey]) => {\n              const active = value.placeCategories.includes(slug);\n              return <button key={slug} type="button" aria-pressed={active} onClick={() => togglePlaceCategory(slug)} className="min-h-9 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent" style={active ? { borderColor: "var(--color-primary)", color: "var(--color-primary)", background: "var(--color-accent)" } : undefined}><Landmark className="mr-1 inline h-3.5 w-3.5" />{t(labelKey)}</button>;\n            })}\n          </div>\n          <div className="mt-3 grid grid-cols-2 gap-2">\n            <FilterToggle active={value.openNowOnly} icon={Clock3} label={t("filters.openNow")} onClick={() => update("openNowOnly", !value.openNowOnly)} />\n            <FilterToggle active={value.freePlacesOnly} icon={CircleDollarSign} label={t("filters.freeAccess")} onClick={() => update("freePlacesOnly", !value.freePlacesOnly)} />\n          </div>\n        </fieldset>\n      )}`,
  "POI filter controls",
);

await writeFile(
  testPath,
  `import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\nconst map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");\nconst filters = await readFile(new URL("../src/lib/event-filters.ts", import.meta.url), "utf8");\nconst panel = await readFile(new URL("../src/components/event-filter-panel.tsx", import.meta.url), "utf8");\nconst i18n = await readFile(new URL("../src/lib/i18n.tsx", import.meta.url), "utf8");\ntest("mobile map keeps raster fast path", () => { assert.match(map, /shouldUpgradeBasemap = !isMobileRef\\.current/); });\ntest("POI filters are shared", () => { assert.match(filters, /contentMode: DiscoveryContentMode/); assert.match(filters, /placeCategories: string\\[\\]/); });\ntest("POI controls use translated labels", () => { assert.match(panel, /filters\\.contentPlaces/); assert.match(panel, /filters\\.openNow/); assert.match(panel, /filters\\.freeAccess/); assert.match(i18n, /filters\\.placeAttraction/); });\n`,
);
