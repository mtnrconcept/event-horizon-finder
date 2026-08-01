import { readFile, writeFile } from "node:fs/promises";

const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const typesPath = new URL("../src/integrations/supabase/types.ts", import.meta.url);
const testPath = new URL("../tests/poi-map-layer.test.ts", import.meta.url);
let source = await readFile(mapPath, "utf8");
let typesSource = await readFile(typesPath, "utf8");

function replaceOnce(before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Expected ${label} fragment was not found`);
  }
  source = source.replace(before, after);
}

replaceOnce(
  `import { useTranslation } from "@/lib/i18n";`,
  `import { useTranslation } from "@/lib/i18n";\nimport { supabase } from "@/integrations/supabase/client";`,
  "Supabase import",
);

replaceOnce(
  `type GeolocationStatus = "requesting" | "ready" | "denied" | "unavailable" | "error";`,
  `type PlaceOfInterestMapRow = {\n  id: string;\n  name: string;\n  category: string;\n  subcategory: string | null;\n  description: string | null;\n  address: string | null;\n  website: string | null;\n  source_url: string | null;\n  opening_hours: string | null;\n  fee: string | null;\n  wheelchair: string | null;\n  latitude: number;\n  longitude: number;\n};\n\ntype GeolocationStatus = "requesting" | "ready" | "denied" | "unavailable" | "error";`,
  "POI row type",
);

replaceOnce(
  `  const hoverPopupRef = useRef<maplibregl.Popup | null>(null);\n  const hoverRequestRef = useRef(0);`,
  `  const hoverPopupRef = useRef<maplibregl.Popup | null>(null);\n  const hoverRequestRef = useRef(0);\n  const placeMarkersRef = useRef<maplibregl.Marker[]>([]);\n  const placeRequestVersionRef = useRef(0);`,
  "POI marker refs",
);

const placesOfInterestTableType = `      places_of_interest: {
        Row: {
          address: string | null;
          category: string;
          city_id: string;
          country_id: string | null;
          created_at: string;
          description: string | null;
          fee: string | null;
          id: string;
          image_url: string | null;
          is_public: boolean;
          last_seen_at: string;
          latitude: number;
          location: unknown;
          longitude: number;
          name: string;
          opening_hours: string | null;
          phone: string | null;
          quality_score: number;
          slug: string;
          source_id: number;
          source_provider: string;
          source_type: string;
          source_url: string | null;
          subcategory: string | null;
          tags: Json;
          updated_at: string;
          venue_id: string | null;
          website: string | null;
          wheelchair: string | null;
        };
        Insert: {
          address?: string | null;
          category: string;
          city_id: string;
          country_id?: string | null;
          created_at?: string;
          description?: string | null;
          fee?: string | null;
          id?: string;
          image_url?: string | null;
          is_public?: boolean;
          last_seen_at?: string;
          latitude: number;
          location?: never;
          longitude: number;
          name: string;
          opening_hours?: string | null;
          phone?: string | null;
          quality_score?: number;
          slug: string;
          source_id: number;
          source_provider?: string;
          source_type: string;
          source_url?: string | null;
          subcategory?: string | null;
          tags?: Json;
          updated_at?: string;
          venue_id?: string | null;
          website?: string | null;
          wheelchair?: string | null;
        };
        Update: {
          address?: string | null;
          category?: string;
          city_id?: string;
          country_id?: string | null;
          created_at?: string;
          description?: string | null;
          fee?: string | null;
          id?: string;
          image_url?: string | null;
          is_public?: boolean;
          last_seen_at?: string;
          latitude?: number;
          location?: never;
          longitude?: number;
          name?: string;
          opening_hours?: string | null;
          phone?: string | null;
          quality_score?: number;
          slug?: string;
          source_id?: number;
          source_provider?: string;
          source_type?: string;
          source_url?: string | null;
          subcategory?: string | null;
          tags?: Json;
          updated_at?: string;
          venue_id?: string | null;
          website?: string | null;
          wheelchair?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "places_of_interest_city_id_fkey";
            columns: ["city_id"];
            isOneToOne: false;
            referencedRelation: "cities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "places_of_interest_country_id_fkey";
            columns: ["country_id"];
            isOneToOne: false;
            referencedRelation: "countries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "places_of_interest_venue_id_fkey";
            columns: ["venue_id"];
            isOneToOne: false;
            referencedRelation: "venues";
            referencedColumns: ["id"];
          },
        ];
      };
`;

if (!typesSource.includes("      places_of_interest: {")) {
  const tableAnchor = "    Tables: {\n";
  if (!typesSource.includes(tableAnchor)) {
    throw new Error("Expected Supabase Tables anchor was not found");
  }
  typesSource = typesSource.replace(tableAnchor, `${tableAnchor}${placesOfInterestTableType}`);
}

const poiLoadingEffect = `  const mapReady = mapInstance !== null && readyMap === mapInstance;\n\n  useEffect(() => {\n    const displayPlaces = advancedFilters.contentMode !== "events";\n    setShowEvents(advancedFilters.contentMode !== "places");\n    placeRequestVersionRef.current += 1;\n    const requestVersion = placeRequestVersionRef.current;\n    for (const marker of placeMarkersRef.current) marker.remove();\n    placeMarkersRef.current = [];\n    if (!displayPlaces || !readyMap || !viewportBounds) return;\n\n    const timer = window.setTimeout(() => {\n      let request = supabase\n        .from("places_of_interest")\n        .select("id,name,category,subcategory,description,address,website,source_url,opening_hours,fee,wheelchair,latitude,longitude")\n        .eq("is_public", true)\n        .gte("latitude", viewportBounds.south)\n        .lte("latitude", viewportBounds.north)\n        .gte("longitude", viewportBounds.west)\n        .lte("longitude", viewportBounds.east)\n        .order("quality_score", { ascending: false })\n        .limit(isMobileRef.current ? 180 : 400);\n\n      if (advancedFilters.placeCategories.length) {\n        request = request.in("category", advancedFilters.placeCategories);\n      }\n      if (advancedFilters.accessibleOnly) {\n        request = request.in("wheelchair", ["yes", "limited", "designated"]);\n      }\n      if (advancedFilters.openNowOnly) {\n        request = request.not("opening_hours", "is", null);\n      }\n      if (advancedFilters.freePlacesOnly) {\n        request = request.or("fee.eq.no,fee.eq.0,fee.ilike.free");\n      }\n      if (deferredQuery.length >= 2) {\n        const safePlaceQuery = deferredQuery.replace(/[%_]/g, "");\n        request = request.ilike("name", "%" + safePlaceQuery + "%");\n      }\n\n      void request.then(({ data, error }) => {\n        if (requestVersion !== placeRequestVersionRef.current || !readyMap || error) return;\n        const places = (data ?? []) as PlaceOfInterestMapRow[];\n        const markers = places.flatMap((place) => {\n          if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) return [];\n          const element = document.createElement("button");\n          element.type = "button";\n          element.className = "grid h-8 w-8 place-items-center rounded-full border-2 border-white bg-emerald-600 text-sm shadow-lg";\n          element.title = place.name;\n          element.setAttribute("aria-label", place.name);\n          element.textContent = "◆";\n\n          const popupContent = document.createElement("article");\n          popupContent.className = "grid max-w-64 gap-1 p-1 text-sm";\n          const title = document.createElement("strong");\n          title.textContent = place.name;\n          popupContent.append(title);\n          const details = [\n            place.address,\n            place.opening_hours,\n            place.fee ? "Tarif : " + place.fee : null,\n          ].filter((detail): detail is string => Boolean(detail));\n          for (const detail of details) {\n            const line = document.createElement("span");\n            line.textContent = detail;\n            popupContent.append(line);\n          }\n          const externalUrl = place.website ?? place.source_url;\n          if (externalUrl) {\n            const link = document.createElement("a");\n            link.href = externalUrl;\n            link.target = "_blank";\n            link.rel = "noopener noreferrer";\n            link.textContent = "Voir le lieu";\n            link.className = "font-bold text-primary underline";\n            popupContent.append(link);\n          }\n          const popup = new maplibregl.Popup({ offset: 18, closeButton: true }).setDOMContent(popupContent);\n          return [new maplibregl.Marker({ element, anchor: "center" }).setLngLat([place.longitude, place.latitude]).setPopup(popup).addTo(readyMap)];\n        });\n        if (requestVersion !== placeRequestVersionRef.current) {\n          for (const marker of markers) marker.remove();\n          return;\n        }\n        placeMarkersRef.current = markers;\n      });\n    }, 280);\n\n    return () => {\n      window.clearTimeout(timer);\n      placeRequestVersionRef.current += 1;\n      for (const marker of placeMarkersRef.current) marker.remove();\n      placeMarkersRef.current = [];\n    };\n  }, [\n    advancedFilters.accessibleOnly,\n    advancedFilters.contentMode,\n    advancedFilters.freePlacesOnly,\n    advancedFilters.openNowOnly,\n    advancedFilters.placeCategories,\n    deferredQuery,\n    readyMap,\n    viewportBounds,\n  ]);\n\n  const { from, to } = useMemo(() => computeRange(range), [range]);`;

replaceOnce(
  `  const mapReady = mapInstance !== null && readyMap === mapInstance;\n  const { from, to } = useMemo(() => computeRange(range), [range]);`,
  poiLoadingEffect,
  "POI loading effect",
);

await writeFile(mapPath, source);
await writeFile(typesPath, typesSource);

const testSource = `import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\n\nconst map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");\nconst types = await readFile(new URL("../src/integrations/supabase/types.ts", import.meta.url), "utf8");\n\ntest("places are fetched only in visible bounds", () => {\n  assert.match(map, /from\\("places_of_interest"\\)/);\n  assert.match(map, /gte\\("latitude", viewportBounds\\.south\\)/);\n  assert.match(map, /limit\\(isMobileRef\\.current \\? 180 : 400\\)/);\n});\n\ntest("place filters affect the query", () => {\n  assert.match(map, /advancedFilters\\.placeCategories/);\n  assert.match(map, /advancedFilters\\.accessibleOnly/);\n  assert.match(map, /advancedFilters\\.freePlacesOnly/);\n});\n\ntest("places mode removes event pins", () => {\n  assert.match(map, /setShowEvents\\(advancedFilters\\.contentMode !== "places"\\)/);\n});\n\ntest("places use generated Supabase types without any casts", () => {\n  assert.match(types, /places_of_interest:/);\n  assert.doesNotMatch(map, /supabase as any/);\n});\n`;
await writeFile(testPath, testSource);
