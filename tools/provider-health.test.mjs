import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderHealth } from "./provider-health.mjs";

test("reports all six providers and distinguishes collector failure from empty catalogs", () => {
  const health = buildProviderHealth({ collectors: {
    timstreams: { error: "request failed" }, ppv: { error: "request failed" },
  }, sportsUpaFailures: { main: true, admin: true } });
  assert.deepEqual(Object.keys(health), ["StreamCorner", "TimStreams", "PPV", "DLStreams", "SportsUpa", "Sports Streams"]);
  for (const provider of ["TimStreams", "PPV", "SportsUpa"]) assert.equal(health[provider].state, "unavailable");
  for (const provider of ["StreamCorner", "DLStreams", "Sports Streams"]) assert.equal(health[provider].state, "no-playable-sources");
});

test("unmatched Sports Streams catalog entries are not classified as an outage", () => {
  const health = buildProviderHealth({ catalogCounts: { highfly: 2 }, collectors: { highfly: { errors: [], unmatched: 2 } } });
  assert.equal(health["Sports Streams"].catalogCount, 2);
  assert.equal(health["Sports Streams"].sourceCount, 0);
  assert.equal(health["Sports Streams"].state, "no-playable-sources");
});

test("uses only final published sources and distinguishes partial collector failures", () => {
  const health = buildProviderHealth({
    catalogCounts: { sportsupaMain: 3, sportsupaAdmin: 2, dlstreams: 9, ppv: 8 },
    games: [{ provider: "PPV", sources: [{ provider: "SportsUpa" }, { provider: "DLStreams" }] }],
    collectors: { dlstreams: { error: "failed", playableCount: 90 }, ppv: { playableCount: 80 } },
    sportsUpaFailures: { admin: true },
  });
  assert.deepEqual([health.SportsUpa.state, health.SportsUpa.catalogCount, health.SportsUpa.sourceCount], ["degraded", 5, 1]);
  assert.equal(health.DLStreams.state, "degraded");
  assert.equal(health.DLStreams.sourceCount, 1);
  assert.equal(health.PPV.state, "no-playable-sources");
  assert.equal(health.PPV.sourceCount, 0);
  assert.equal(buildProviderHealth({ sportsUpaFailures: { main: true } }).SportsUpa.state, "degraded");
});

test("source references are available without claiming playback verification", () => {
  const health = buildProviderHealth({ games: [{ sources: [{ provider: "PPV" }] }] });
  assert.equal(health.PPV.state, "available");
  assert.match(health.PPV.diagnostic, /playback is not verified/);
});

test("StreamCorner collection evidence distinguishes empty supported catalogs from transport failures", () => {
  const empty = buildProviderHealth({ collectors: { streamcorner: {
    collectionFailed: false, error: "no direct HLS/DASH or native ingest sources passed validation ()",
  } } });
  assert.equal(empty.StreamCorner.state, "no-playable-sources");
  const partial = buildProviderHealth({ catalogCounts: { streamcorner: 3 }, collectors: {
    streamcorner: { collectionFailed: true, error: "" },
  } });
  assert.equal(partial.StreamCorner.state, "degraded");
  assert.equal(buildProviderHealth({ collectors: { streamcorner: { collectionFailed: true } } }).StreamCorner.state, "unavailable");
});

test("diagnostics never serialize raw failures, URLs, tokens, or extra collector properties", () => {
  const secret = "https://private.example/catalog?token=private-token";
  const health = buildProviderHealth({ collectors: {
    streamcorner: { error: secret, warning: secret, decoderUrl: secret },
    timstreams: { error: secret }, ppv: { error: secret }, dlstreams: { error: secret },
    highfly: { errors: [secret], config: secret },
  }, sportsUpaFailures: { main: true, admin: true } });
  assert.doesNotMatch(JSON.stringify(health), /https:|private|token|decoderUrl|config/);
  for (const row of Object.values(health)) {
    assert.deepEqual(Object.keys(row), ["state", "catalogCount", "sourceCount", "diagnostic"]);
    assert.equal(row.diagnostic, "Collector failed; no current catalog or published source references.");
  }
});
