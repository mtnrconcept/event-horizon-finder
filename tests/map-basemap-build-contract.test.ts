import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const vercelConfig = JSON.parse(
  await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
) as { buildCommand?: string };

test("Vercel applies the progressive basemap patch before building", () => {
  assert.equal(
    vercelConfig.buildCommand,
    "node scripts/apply-progressive-basemap.mjs && npm run build:vercel",
  );
});
