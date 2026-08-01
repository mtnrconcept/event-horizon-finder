import { readFile, writeFile } from "node:fs/promises";

const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const testPath = new URL("../tests/poi-map-layer.test.ts", import.meta.url);
let source = await readFile(mapPath, "utf8");

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

const poiLoadingEffect = `  const mapReady = mapInstance !== null && readyMap === mapInstance;\n\n  useEffect(() => {\n    const displayPlaces = advancedFilters.contentMode !== "events";\n    setShowEvents(advancedFilters.contentMode !== "places");\n    placeRequestVersionRef.current += 1;\n    const requestVersion = placeRequestVersionRef.current;\n    for (const marker of placeMarkersRef.current) marker.remove();\n    placeMarkersRef.current = [];\n    if (!displayPlaces || !readyMap || !viewportBounds) return;\n\n    const timer = window.setTimeout(() => {\n      let request = (supabase as any)\n        .from("places_of_interest")\n        .select("id,name,category,subcategory,description,address,website,source_url,opening_hours,fee,wheelchair,latitude,longitude")\n        .eq("is_public", true)\n        .gte("latitude", viewportBounds.south)\n        .lte("latitude", viewportBounds.north)\n        .gte("longitude", viewportBounds.west)\n        .lte("longitude", viewportBounds.east)\n        .order("quality_score", { ascending: false })\n        .limit(isMobileRef.current ? 180 : 400);\n\n      if (advancedFilters.placeCategories.length) {\n        request = request.in("category", advancedFilters.placeCategories);\n      }\n      if (advancedFilters.accessibleOnly) {\n        request = request.in("wheelchair", ["yes", "limited", "designated"]);\n      }\n      if (advancedFilters.openNowOnly) {\n        request = request.not("opening_hours", "is", null);\n      }\n      if (advancedFilters.freePlacesOnly) {\n        request = request.or("fee.eq.no,fee.eq.0,fee.ilike.free");\n      }\n      if (deferredQuery.length >= 2) {\n        const safePlaceQuery = deferredQuery.replace(/[%_]/g, "");\n        request = request.ilike("name", "%" + safePlaceQuery + "%");\n      }\n\n      void request.then(({ data, error }: { data: PlaceOfInterestMapRow[] | null; error: { message?: string } | null }) => {\n        if (requestVersion !== placeRequestVersionRef.current || !readyMap || error) return;\n        const markers = (data ?? []).flatMap((place) => {\n          if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) return [];\n          const element = document.createElement("button");\n          element.type = "button";\n          element.className = "grid h-8 w-8 place-items-center rounded-full border-2 border-white bg-emerald-600 text-sm shadow-lg";\n          element.title = place.name;\n          element.setAttribute("aria-label", place.name);\n          element.textContent = "◆";\n\n          const popupContent = document.createElement("article");\n          popupContent.className = "grid max-w-64 gap-1 p-1 text-sm";\n          const title = document.createElement("strong");\n          title.textContent = place.name;\n          popupContent.append(title);\n          const details = [\n            place.address,\n            place.opening_hours,\n            place.fee ? "Tarif : " + place.fee : null,\n          ].filter((detail): detail is string => Boolean(detail));\n          for (const detail of details) {\n            const line = document.createElement("span");\n            line.textContent = detail;\n            popupContent.append(line);\n          }\n          const externalUrl = place.website ?? place.source_url;\n          if (externalUrl) {\n            const link = document.createElement("a");\n            link.href = externalUrl;\n            link.target = "_blank";\n            link.rel = "noopener noreferrer";\n            link.textContent = "Voir le lieu";\n            link.className = "font-bold text-primary underline";\n            popupContent.append(link);\n          }\n          const popup = new maplibregl.Popup({ offset: 18, closeButton: true }).setDOMContent(popupContent);\n          return [new maplibregl.Marker({ element, anchor: "center" }).setLngLat([place.longitude, place.latitude]).setPopup(popup).addTo(readyMap)];\n        });\n        if (requestVersion !== placeRequestVersionRef.current) {\n          for (const marker of markers) marker.remove();\n          return;\n        }\n        placeMarkersRef.current = markers;\n      });\n    }, 280);\n\n    return () => {\n      window.clearTimeout(timer);\n      placeRequestVersionRef.current += 1;\n      for (const marker of placeMarkersRef.current) marker.remove();\n      placeMarkersRef.current = [];\n    };\n  }, [\n    advancedFilters.accessibleOnly,\n    advancedFilters.contentMode,\n    advancedFilters.freePlacesOnly,\n    advancedFilters.openNowOnly,\n    advancedFilters.placeCategories,\n    deferredQuery,\n    readyMap,\n    viewportBounds,\n  ]);\n\n  const { from, to } = useMemo(() => computeRange(range), [range]);`;

replaceOnce(
  `  const mapReady = mapInstance !== null && readyMap === mapInstance;\n  const { from, to } = useMemo(() => computeRange(range), [range]);`,
  poiLoadingEffect,
  "POI loading effect",
);

await writeFile(mapPath, source);

const testSource = `import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\nconst map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");\ntest("places are fetched only in visible bounds", () => { assert.match(map, /from\\("places_of_interest"\\)/); assert.match(map, /gte\\("latitude", viewportBounds\\.south\\)/); assert.match(map, /limit\\(isMobileRef\\.current \? 180 : 400\\)/); });\ntest("place filters affect the query", () => { assert.match(map, /advancedFilters\\.placeCategories/); assert.match(map, /advancedFilters\\.accessibleOnly/); assert.match(map, /advancedFilters\\.freePlacesOnly/); });\ntest("places mode removes event pins", () => { assert.match(map, /setShowEvents\\(advancedFilters\\.contentMode !== "places"\\)/); });\n`;
await writeFile(testPath, testSource);
