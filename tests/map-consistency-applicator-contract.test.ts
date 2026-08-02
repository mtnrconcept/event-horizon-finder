import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

function runScript(root: string, relativePath: string) {
  return spawnSync(process.execPath, [join(root, relativePath)], {
    cwd: root,
    encoding: "utf8",
  });
}

test("the production map applicator sequence supports the modern discovery layout", async (t) => {
  const worktree = await mkdtemp(join(tmpdir(), "map-consistency-applicator-"));
  t.after(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  await Promise.all(
    ["src", "scripts", "tests"].map((directory) =>
      cp(new URL(`../${directory}`, import.meta.url), join(worktree, directory), {
        recursive: true,
      }),
    ),
  );

  const sequence = [
    "scripts/apply-progressive-basemap.mjs",
    "scripts/apply-today-default-fullscreen-intro.mjs",
    "scripts/apply-map-mobile-performance-and-poi-filters.mjs",
    "scripts/apply-poi-map-layer.mjs",
    "scripts/apply-home-place-search.mjs",
    "scripts/apply-map-consistency-performance.mjs",
  ];

  for (const script of sequence) {
    const result = runScript(worktree, script);
    assert.equal(
      result.status,
      0,
      `${script} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  const secondPass = runScript(worktree, "scripts/apply-map-consistency-performance.mjs");
  assert.equal(
    secondPass.status,
    0,
    `second consistency pass failed\nstdout:\n${secondPass.stdout}\nstderr:\n${secondPass.stderr}`,
  );

  const map = await readFile(join(worktree, "src/routes/map.tsx"), "utf8");
  assert.doesNotMatch(map, /listTotalCount\s*\|\|\s*totalPlaceCount/);
  assert.match(map, /contentMode === "all" && advancedFilters\.priceMode === "free"/);
});
