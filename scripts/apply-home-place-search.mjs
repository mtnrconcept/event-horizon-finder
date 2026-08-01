import { readFile, writeFile } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Expected ${label} fragment was not found`);
  return source.replace(before, after);
}

const routePath = new URL("../src/routes/index.tsx", import.meta.url);
let source = await readFile(routePath, "utf8");
const eventCardImport = 'import { EventCard, EventCardSkeleton } from "@/components/event-card";';
if (!source.includes('import { HomePlaceSearchResults } from "@/components/home-place-search-results";')) {
  source = replaceOnce(
    source,
    eventCardImport,
    `${eventCardImport}\nimport { HomePlaceSearchResults } from "@/components/home-place-search-results";`,
    "home place search import",
  );
}
source = source.replace(
  '{landingMode && landingCollections && (',
  '{advancedFilters.contentMode !== "places" && landingMode && landingCollections && (',
);
const placeResults = `      <HomePlaceSearchResults
        enabled={advancedFilters.contentMode !== "events"}
        countryId={countryId}
        regionId={regionId}
        cityId={cityId}
        categories={advancedFilters.placeCategories}
        query={deferredQuery}
        accessibleOnly={advancedFilters.accessibleOnly}
        freeOnly={advancedFilters.freePlacesOnly}
        hasHoursOnly={advancedFilters.openNowOnly}
      />

`;
if (!source.includes("<HomePlaceSearchResults")) {
  source = replaceOnce(source, "      {error && (", `${placeResults}      <div className={advancedFilters.contentMode === "places" ? "hidden" : ""}>\n      {error && (`, "home result list start");
  source = replaceOnce(
    source,
    "      )}\n    </div>\n  );\n}",
    "      )}\n      </div>\n    </div>\n  );\n}",
    "home result list end",
  );
}
await writeFile(routePath, source);

const layerPath = new URL("../src/hooks/usePlaceMapLayer.ts", import.meta.url);
let layer = await readFile(layerPath, "utf8");
if (!layer.includes("clusterClickLockedRef")) {
  layer = replaceOnce(
    layer,
    "  const onSelectRef = useRef(onSelect);\n  onSelectRef.current = onSelect;",
    "  const onSelectRef = useRef(onSelect);\n  const clusterClickLockedRef = useRef(false);\n  onSelectRef.current = onSelect;",
    "place cluster click lock",
  );
  layer = replaceOnce(
    layer,
    "    const openClientCluster = async (event: MapLayerMouseEvent) => {\n      const feature = event.features?.[0];",
    "    const beginClusterExpansion = (event: MapLayerMouseEvent) => {\n      event.originalEvent.preventDefault();\n      event.originalEvent.stopPropagation();\n      if (clusterClickLockedRef.current) return false;\n      clusterClickLockedRef.current = true;\n      const unlock = () => {\n        clusterClickLockedRef.current = false;\n      };\n      map.once(\"moveend\", unlock);\n      window.setTimeout(() => {\n        map.off(\"moveend\", unlock);\n        unlock();\n      }, 1_200);\n      return true;\n    };\n\n    const openClientCluster = async (event: MapLayerMouseEvent) => {\n      if (!beginClusterExpansion(event)) return;\n      const feature = event.features?.[0];",
    "client place cluster single click",
  );
  layer = replaceOnce(
    layer,
    "    const openServerCluster = (event: MapLayerMouseEvent) => {\n      const feature = event.features?.[0];",
    "    const openServerCluster = (event: MapLayerMouseEvent) => {\n      if (!beginClusterExpansion(event)) return;\n      const feature = event.features?.[0];",
    "server place cluster single click",
  );
  layer = replaceOnce(
    layer,
    "    const openPlace = (event: MapLayerMouseEvent) => {\n      const feature = event.features?.[0];",
    "    const openPlace = (event: MapLayerMouseEvent) => {\n      event.originalEvent.preventDefault();\n      event.originalEvent.stopPropagation();\n      const feature = event.features?.[0];",
    "individual place click isolation",
  );
}
await writeFile(layerPath, layer);
