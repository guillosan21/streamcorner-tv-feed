import test from "node:test";
import assert from "node:assert/strict";

import {
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
});

test("empty and all-source-free baselines are not trusted", async () => {
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
});
