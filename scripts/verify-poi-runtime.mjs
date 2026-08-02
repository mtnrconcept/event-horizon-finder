import { readFile } from "node:fs/promises";

const map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");
const requiredMarkers = [
  "usePlaceMapDiscovery",
  "usePlaceMapLayer",
  "PlaceSearchResults",
  "PlaceDetailDialog",
  "placeDiscovery.pinBatch",
];

for (const marker of requiredMarkers) {
  if (!map.includes(marker)) {
    throw new Error(`Committed POI runtime is missing marker: ${marker}`);
  }
}
