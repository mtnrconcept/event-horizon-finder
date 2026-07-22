import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/components/performance-monitor.tsx", import.meta.url),
  "utf8",
);

test("performance monitor measures LCP, CLS and INP", () => {
  assert.match(source, /largest-contentful-paint/);
  assert.match(source, /layout-shift/);
  assert.match(source, /interactionId/);
});

test("performance monitor emits a local browser event and does not fetch", () => {
  assert.match(source, /global-party:performance/);
  assert.doesNotMatch(source, /fetch\(/);
  assert.doesNotMatch(source, /supabase/);
});
