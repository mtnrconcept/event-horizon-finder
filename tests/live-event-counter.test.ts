import assert from "node:assert/strict";
import test from "node:test";

import { normalizePublishedEventCount } from "../src/lib/live-event-counter.ts";

test("normalizes safe realtime counter payloads", () => {
  assert.equal(normalizePublishedEventCount(158_723), 158_723);
  assert.equal(normalizePublishedEventCount("158724"), 158_724);
});

test("rejects malformed or unsafe realtime counter payloads", () => {
  assert.equal(normalizePublishedEventCount(-1), null);
  assert.equal(normalizePublishedEventCount(1.5), null);
  assert.equal(normalizePublishedEventCount("not-a-number"), null);
  assert.equal(normalizePublishedEventCount(Number.MAX_SAFE_INTEGER + 1), null);
});
