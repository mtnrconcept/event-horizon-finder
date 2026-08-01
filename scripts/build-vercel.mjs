import { spawnSync } from "node:child_process";

const steps = [
  ["node", ["--check", "scripts/apply-progressive-basemap.mjs"]],
  ["node", ["--check", "scripts/apply-today-default-fullscreen-intro.mjs"]],
  ["node", ["--check", "scripts/apply-map-mobile-performance-and-poi-filters.mjs"]],
  ["node", ["--check", "scripts/apply-poi-map-layer.mjs"]],
  ["node", ["scripts/apply-progressive-basemap.mjs"]],
  ["node", ["scripts/apply-today-default-fullscreen-intro.mjs"]],
  ["node", ["scripts/apply-map-mobile-performance-and-poi-filters.mjs"]],
  ["node", ["scripts/apply-poi-map-layer.mjs"]],
  [
    "node",
    [
      "--test",
      "tests/map-mobile-performance-poi-filters.test.ts",
      "tests/poi-map-layer.test.ts",
      "tests/place-discovery.test.ts",
      "tests/place-map-experience-contract.test.ts",
    ],
  ],
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "build:vercel"]],
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
