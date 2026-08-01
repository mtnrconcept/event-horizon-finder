import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
const compatibilityMigrationPath =
  "supabase/migrations/20260801161900_prepare_ladecadanse_catalog_compatibility.sql";
const catalogMigrationPath =
  "supabase/migrations/20260801162000_ladecadanse_complete_venue_catalog.sql";
const compatibilityMigration = readFileSync(compatibilityMigrationPath, "utf8");

test("the compatibility bootstrap runs before the historical catalog migration", () => {
  assert.ok(compatibilityMigrationPath < catalogMigrationPath);
  assert.match(compatibilityMigration, /add column if not exists data_source_id uuid/);
  assert.match(compatibilityMigration, /add column if not exists domain text/);
  assert.match(compatibilityMigration, /add column if not exists source_provider text/);
  assert.match(compatibilityMigration, /add column if not exists canonical_url text/);
  assert.match(compatibilityMigration, /add column if not exists media_type text/);
  assert.match(compatibilityMigration, /add column if not exists provider text/);
  assert.match(compatibilityMigration, /trg_sync_venue_source_compatibility_v1/);
  assert.match(compatibilityMigration, /trg_sync_venue_media_compatibility_v1/);
});

test("production uses include-all only for the reviewed historical migrations", () => {
  const standardPreview = workflow.indexOf("supabase db push --dry-run 2>&1");
  const includeAllPreview = workflow.indexOf("supabase db push --dry-run --include-all");

  assert.ok(standardPreview >= 0);
  assert.ok(includeAllPreview > standardPreview);
  assert.match(workflow, new RegExp(compatibilityMigrationPath.replaceAll("/", "\\/")));
  assert.match(workflow, new RegExp(catalogMigrationPath.replaceAll("/", "\\/")));
  assert.match(workflow, /Refusing --include-all because an unreviewed historical migration is pending/);
  assert.match(workflow, /SUPABASE_DB_PUSH_FLAGS=--include-all/);
  assert.match(workflow, /supabase db push --include-all/);
  assert.match(workflow, /else\n\s+supabase db push\n\s+fi/);
});
