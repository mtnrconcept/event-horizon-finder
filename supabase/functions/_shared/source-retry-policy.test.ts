import assert from "node:assert/strict";
import test from "node:test";

import { failureRetryDelayMs } from "./source-retry-policy.ts";

const HOUR_MS = 3_600_000;

test("permanent source failures back off until the next daily or weekly cycle", () => {
  for (const message of [
    "direct_http_404",
    "direct_http_403",
    "direct_off_domain_url",
    "direct_response_too_large",
    "invalid peer certificate: UnknownIssuer",
    "failed to lookup address information",
  ]) {
    assert.equal(failureRetryDelayMs(message, "daily"), 24 * HOUR_MS);
    assert.equal(failureRetryDelayMs(message, "weekly"), 7 * 24 * HOUR_MS);
  }
});

test("transient upstream failures use a shorter but non-aggressive retry", () => {
  for (const message of ["direct_timeout", "direct_http_429", "direct_http_503", "error sending request"]) {
    assert.equal(failureRetryDelayMs(message, "daily"), 2 * HOUR_MS);
    assert.equal(failureRetryDelayMs(message, "weekly"), 24 * HOUR_MS);
  }
});

test("unknown failures retain the legacy retry policy", () => {
  assert.equal(failureRetryDelayMs("unknown_error", "daily"), 0.5 * HOUR_MS);
  assert.equal(failureRetryDelayMs("unknown_error", "weekly"), 6 * HOUR_MS);
});
