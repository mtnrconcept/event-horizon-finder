import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const readProjectFile = (path) => readFile(new URL(path, `file://${projectRoot}/`), "utf8");

const criticalRoutes = [
  "/cookies",
  "/faq",
  "/help",
  "/mcp",
  "/privacy",
  "/settings",
  "/social",
  "/terms",
];

const rootShellMarkers = [
  "LanguageProvider",
  "BrandArrival",
  "ClientJourneyTracker",
  "AppFooter",
  "ClientConsentBanner",
];

const routeTree = await readProjectFile("src/routeTree.gen.ts");
const rootRoute = await readProjectFile("src/routes/__root.tsx");

for (const route of criticalRoutes) {
  assert.match(
    routeTree,
    new RegExp(`fullPath: ['\"]${route.replace("/", "\\/")}['\"]`),
    `The generated TanStack route tree is missing ${route}`,
  );
}

for (const marker of rootShellMarkers) {
  assert.match(
    rootRoute,
    new RegExp(`\\b${marker}\\b`),
    `The application shell is missing ${marker}`,
  );
}

assert.match(rootRoute, /Global Party/, "The application shell is missing the Global Party brand");
assert.doesNotMatch(
  rootRoute,
  /EVENTA/,
  "The legacy EVENTA brand has returned to the application shell",
);

console.log(
  `Route recovery contract passed (${criticalRoutes.length} critical routes, ${rootShellMarkers.length} shell components).`,
);
