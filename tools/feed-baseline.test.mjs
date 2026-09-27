import test from "node:test";
import assert from "node:assert/strict";

import {
  assessStreamCornerDecoderFallback,
  assertDecoderFallbackHasTrustedBaseline,
  isTrustedFeedBaseline,
  loadTrustedFeedBaseline,
} from "./feed-baseline.mjs";

const trustedFeed = {
  feedSchemaVersion: 2,
  updatedAt: "2026-09-27T06:00:00.000Z",
  games: [{ id: "event-1", sources: [{ provider: "DLStreams" }] }],
};

test("trusted baseline loader falls back from a local read failure to a valid remote feed", async () => {
  let requestedUrl = "";
  const result = await loadTrustedFeedBaseline({
    localPath: "local.json",
    remoteUrl: "https://feed.example/games.json",
    cacheBuster: "test",
    readLocal: async () => { throw new Error("file unavailable"); },
    fetcher: async (url, init) => {
      requestedUrl = url;
      assert.ok(init.signal);
      return new Response(JSON.stringify(trustedFeed), { status: 200 });
    },
  });

  assert.equal(requestedUrl, "https://feed.example/games.json?previous=test");
  assert.equal(result.trusted, true);
  assert.equal(result.source, "remote");
  assert.deepEqual(result.feed, trustedFeed);
  assert.match(result.errors[0], /local baseline unavailable/);
});

test("unavailable local and remote baselines are not trusted", async () => {
  const result = await loadTrustedFeedBaseline({
    localPath: "local.json",
    remoteUrl: "https://feed.example/games.json",
    readLocal: async () => { throw new Error("file unavailable"); },
    fetcher: async () => new Response("unavailable", { status: 503 }),
  });

  assert.equal(result.trusted, false);
  assert.equal(result.source, "none");
  assert.deepEqual(result.feed, {});
  assert.match(result.errors[1], /remote baseline unavailable: HTTP 503/);
  assert.throws(() => assertDecoderFallbackHasTrustedBaseline("HTTP 403", result.trusted), /refusing to publish/);
  assert.doesNotThrow(() => assertDecoderFallbackHasTrustedBaseline("", result.trusted));
});

test("untrusted local schema and invalid remote JSON shape fail closed", async () => {
  assert.equal(isTrustedFeedBaseline({ ...trustedFeed, games: [{}] }), false);
  const result = await loadTrustedFeedBaseline({
    localPath: "local.json",
    remoteUrl: "https://feed.example/games.json",
    readLocal: async () => JSON.stringify({ games: [] }),
    fetcher: async () => new Response(JSON.stringify({ feedSchemaVersion: 2, updatedAt: trustedFeed.updatedAt, games: [{}] }), { status: 200 }),
  });

  assert.equal(result.trusted, false);
  assert.equal(result.source, "none");
  assert.match(result.errors[0], /local baseline failed schema validation/);
  assert.match(result.errors[1], /remote baseline unavailable: remote baseline failed schema validation/);
  assert.throws(() => assertDecoderFallbackHasTrustedBaseline("HTTP 403", result.trusted), /no trusted previous feed baseline/);
});

test("empty and all-source-free baselines fail closed during decoder outage", async () => {
  const unusableFeeds = [
    { ...trustedFeed, games: [] },
    { ...trustedFeed, games: [{ id: "schedule-only", sources: [] }, { id: "also-schedule-only", sources: [] }] },
  ];
  for (const unusableFeed of unusableFeeds) {
    assert.equal(isTrustedFeedBaseline(unusableFeed), false);
    const result = await loadTrustedFeedBaseline({
      localPath: "local.json",
      remoteUrl: "https://feed.example/games.json",
      readLocal: async () => JSON.stringify(unusableFeed),
      fetcher: async () => new Response(JSON.stringify(unusableFeed), { status: 200 }),
    });
    assert.equal(result.trusted, false);
    assert.throws(() => assertDecoderFallbackHasTrustedBaseline("HTTP 403", result.trusted), /refusing to publish/);
  }
});

test("valid local baseline avoids a remote request", async () => {
  const result = await loadTrustedFeedBaseline({
    localPath: "local.json",
    remoteUrl: "https://feed.example/games.json",
    readLocal: async () => JSON.stringify(trustedFeed),
    fetcher: async () => assert.fail("remote should not be requested"),
  });
  assert.equal(result.trusted, true);
  assert.equal(result.source, "local");
  assert.equal(isTrustedFeedBaseline(trustedFeed), true);
  assert.doesNotThrow(() => assertDecoderFallbackHasTrustedBaseline("HTTP 403", result.trusted));
  const assessment = assessStreamCornerDecoderFallback({
    decoderError: "HTTP 403",
    baselineTrusted: result.trusted,
    baselineUpdatedAt: "2026-09-27T08:55:00.000Z",
    missingSourceCount: 2,
    previousActiveCount: 15,
    now: new Date("2026-09-27T09:00:00.000Z"),
  });
  assert.equal(assessment.staleBaseline, false);
  assert.equal(assessment.enforcedMissingSourceThreshold, 5);
});

test("recent trusted StreamCorner baseline strictly blocks 15 missing active source keys", () => {
  const now = new Date("2026-09-27T09:00:00.000Z");
  assert.throws(() => assessStreamCornerDecoderFallback({
    decoderError: "HTTP 403",
    baselineTrusted: true,
    baselineUpdatedAt: "2026-09-27T08:55:00.000Z",
    missingSourceCount: 15,
    previousActiveCount: 15,
    now,
  }), /15 of 15 still-active prior StreamCorner sources missing/);
});

test("stale trusted baseline skips only decoder-specific source assertion and reports degradation", () => {
  const now = new Date("2026-09-27T09:00:00.000Z");
  const result = assessStreamCornerDecoderFallback({
    decoderError: "HTTP 403",
    baselineTrusted: true,
    baselineUpdatedAt: "2026-09-24T05:00:00.000Z",
    missingSourceCount: 15,
    previousActiveCount: 15,
    now,
  });

  assert.equal(result.degraded, true);
  assert.equal(result.staleBaseline, true);
  assert.equal(result.baselineAgeMs, 76 * 60 * 60 * 1000);
  assert.equal(result.missingSourceCount, 15);
  assert.equal(result.enforcedMissingSourceThreshold, null);
});

test("decoder outage fails closed for untrusted, invalid-time, and future-time baselines", () => {
  const now = new Date("2026-09-27T09:00:00.000Z");
  const common = { decoderError: "HTTP 403", now, missingSourceCount: 15, previousActiveCount: 15 };
  assert.throws(() => assessStreamCornerDecoderFallback({
    ...common, baselineTrusted: false, baselineUpdatedAt: "2026-09-27T08:55:00.000Z",
  }), /no trusted previous feed baseline/);
  for (const baselineUpdatedAt of ["not-a-date", "2026-09-27T09:00:01.000Z"]) {
    assert.throws(() => assessStreamCornerDecoderFallback({
      ...common, baselineTrusted: true, baselineUpdatedAt,
    }), /timestamp is invalid or in the future/);
  }
});
