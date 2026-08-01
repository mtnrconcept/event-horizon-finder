import { readFile, writeFile } from "node:fs/promises";

const routePath = new URL("../src/routes/index.tsx", import.meta.url);
let source = await readFile(routePath, "utf8");

function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`Expected ${label} fragment was not found`);
  source = source.replace(before, after);
}

const eventCardImport = 'import { EventCard, EventCardSkeleton } from "@/components/event-card";';
if (!source.includes('import { HomePlaceSearchResults } from "@/components/home-place-search-results";')) {
  replaceOnce(
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
  replaceOnce("      {error && (", `${placeResults}      <div className={advancedFilters.contentMode === "places" ? "hidden" : ""}>\n      {error && (`, "home result list start");
  replaceOnce(
    "      )}\n    </div>\n  );\n}",
    "      )}\n      </div>\n    </div>\n  );\n}",
    "home result list end",
  );
}

await writeFile(routePath, source);
