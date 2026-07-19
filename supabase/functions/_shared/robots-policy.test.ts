import assert from "node:assert/strict";
import test from "node:test";

import {
  createRobotsCacheMetadata,
  evaluateRobotsPolicy,
  isRobotsCacheFresh,
  parseRobotsTxt,
  robotsUrlFor,
} from "./robots-policy.ts";

test("the most specific user-agent group wins over the wildcard group", () => {
  const robots = parseRobotsTxt(`
    User-agent: *
    Disallow: /private
    Crawl-delay: 1

    User-agent: GlobalPartyBot
    Disallow: /bot-only
    Allow: /bot-only/open
    Crawl-delay: 2.5
  `);

  assert.equal(
    evaluateRobotsPolicy(robots, "https://events.example.com/private", "GlobalPartyBot/1.0")
      .allowed,
    true,
  );
  const blocked = evaluateRobotsPolicy(
    robots,
    "https://events.example.com/bot-only/closed",
    "GlobalPartyBot/1.0",
  );
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.matchedUserAgent, "globalpartybot");
  assert.equal(blocked.crawlDelaySeconds, 2.5);
  assert.equal(
    evaluateRobotsPolicy(robots, "https://events.example.com/private", "OtherCrawler").allowed,
    false,
  );
});

test("equally specific groups combine and the longest matching rule decides", () => {
  const robots = parseRobotsTxt(`
    User-agent: GlobalPartyBot
    Disallow: /events/

    User-agent: GlobalPartyBot
    Allow: /events/public/
  `);

  assert.equal(
    evaluateRobotsPolicy(robots, "https://events.example.com/events/private/show", "GlobalPartyBot")
      .allowed,
    false,
  );
  const allowed = evaluateRobotsPolicy(
    robots,
    "https://events.example.com/events/public/show",
    "GlobalPartyBot",
  );
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.matchedRule?.pattern, "/events/public/");
});

test("Allow wins a specificity tie and wildcard/end anchors are supported", () => {
  const robots = parseRobotsTxt(`
    User-agent: *
    Disallow: /same
    Allow: /same
    Disallow: /*.pdf$
    Disallow: /search?private=*
  `);

  assert.equal(
    evaluateRobotsPolicy(robots, "https://events.example.com/same", "Crawler").allowed,
    true,
  );
  assert.equal(
    evaluateRobotsPolicy(robots, "https://events.example.com/flyer.pdf", "Crawler").allowed,
    false,
  );
  assert.equal(
    evaluateRobotsPolicy(robots, "https://events.example.com/flyer.pdf?download=1", "Crawler")
      .allowed,
    true,
  );
  assert.equal(
    evaluateRobotsPolicy(robots, "https://events.example.com/search?private=yes", "Crawler")
      .allowed,
    false,
  );
});

test("Unicode and percent-encoded paths compare as the same octets", () => {
  const robots = parseRobotsTxt(`
    User-agent: *
    Disallow: /café
    Sitemap: https://events.example.com/sitemap.xml
  `);
  assert.deepEqual(robots.sitemaps, ["https://events.example.com/sitemap.xml"]);
  assert.equal(
    evaluateRobotsPolicy(robots, "https://events.example.com/caf%C3%A9", "Crawler").allowed,
    false,
  );
});

test("an empty Disallow allows crawling and malformed targets fail closed", () => {
  const robots = parseRobotsTxt("User-agent: *\nDisallow:\n");
  assert.equal(
    evaluateRobotsPolicy(robots, "https://events.example.com/anything", "Crawler").allowed,
    true,
  );
  assert.equal(evaluateRobotsPolicy(robots, "not a URL", "Crawler").allowed, false);
});

test("robots URL and cache metadata stay origin-scoped and expire within 24 hours", () => {
  assert.equal(
    robotsUrlFor("https://events.example.com/calendar?page=2"),
    "https://events.example.com/robots.txt",
  );
  assert.equal(robotsUrlFor("http://127.0.0.1/events"), null);

  const metadata = createRobotsCacheMetadata({
    pageUrl: "https://events.example.com/calendar",
    fetchedAt: "2026-07-19T10:00:00.000Z",
    httpStatus: 200,
    cacheControl: "public, max-age=172800",
    etag: ' W/"rules-v1"\r\n',
  });
  assert.ok(metadata);
  assert.equal(metadata.expiresAt, "2026-07-20T10:00:00.000Z");
  assert.equal(metadata.etag, 'W/"rules-v1"');
  assert.equal(isRobotsCacheFresh(metadata, "2026-07-20T09:59:59.999Z"), true);
  assert.equal(isRobotsCacheFresh(metadata, "2026-07-20T10:00:00.000Z"), false);

  const unavailable = createRobotsCacheMetadata({
    pageUrl: "https://events.example.com/calendar",
    fetchedAt: "2026-07-19T10:00:00.000Z",
    httpStatus: 503,
  });
  assert.equal(unavailable?.expiresAt, "2026-07-19T10:15:00.000Z");

  const noStore = createRobotsCacheMetadata({
    pageUrl: "https://events.example.com/calendar",
    fetchedAt: "2026-07-19T10:00:00.000Z",
    httpStatus: 200,
    cacheControl: "no-store, max-age=86400",
  });
  assert.equal(noStore?.expiresAt, "2026-07-19T10:00:00.000Z");
});
