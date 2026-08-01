import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("venue detail exposes a lazy upcoming-events tab", async () => {
  const [dialog, tab] = await Promise.all([
    read("src/components/place-detail-dialog.tsx"),
    read("src/components/place-upcoming-events-tab.tsx"),
  ]);
  assert.match(dialog, /PlaceUpcomingEventsTab/);
  assert.match(dialog, /activeTab === "events"/);
  assert.match(dialog, /tr\("Événements"\)/);
  assert.match(tab, /get_place_upcoming_events_v1/);
  assert.match(tab, /to="\/event\/\$slug"/);
  assert.match(tab, /event\.ticket_url/);
});

test("La Décadanse migration links canonical venues, places, media and events", async () => {
  const migration = await read(
    "supabase/migrations/20260801170000_ladecadanse_complete_ingestion.sql",
  );
  assert.match(migration, /create table if not exists public\.venue_sources/);
  assert.match(migration, /create table if not exists public\.venue_media/);
  assert.match(migration, /create or replace function public\.upsert_ladecadanse_venue_v1/);
  assert.match(migration, /create or replace function public\.sync_event_venue_place_v1/);
  assert.match(migration, /create or replace function public\.get_place_upcoming_events_v1/);
  assert.match(migration, /event\.venue_id = selected_place\.venue_id/);
  assert.match(migration, /crawl_delay_seconds', 15/);
  assert.match(migration, /seed_ladecadanse_discovery_v1\(366, true\)/);
});

test("missing venue images use only attributed open-license fallback sources", async () => {
  const media = await read("supabase/functions/ladecadanse-discovery/media.ts");
  assert.match(media, /commons\.wikimedia\.org/);
  assert.match(media, /api\.openverse\.org\/v1\/images/);
  assert.match(media, /cc0,pdm,by,by-sa/);
  assert.match(media, /commonsLicenseAllowed/);
  assert.match(media, /foreign_landing_url/);
  assert.match(media, /isFallback: true/);
  assert.match(
    media,
    /if \(candidate\.media\.length \|\| candidate\.imageUrls\.length\) return candidate/,
  );
});

test("the dedicated worker honours robots and the database-backed crawl delay", async () => {
  const worker = await read("supabase/functions/ladecadanse-discovery/index.ts");
  assert.match(worker, /evaluateRobotsPolicy/);
  assert.match(worker, /reserve_ladecadanse_request_slot_v1/);
  assert.match(worker, /Math\.max\(15/);
  assert.match(worker, /upsert_ladecadanse_venue_v1/);
  assert.match(worker, /upsert_ingested_event_serial_v1/);
  assert.match(worker, /sync_event_venue_place_v1/);
});
