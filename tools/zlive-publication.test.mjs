import test from "node:test";
import assert from "node:assert/strict";
import { parseZLiveEvents } from "./zlive.mjs";
import { deduplicatePlaybackSources } from "./playback-identity.mjs";
import { attachScheduleGames, inspectStreamCapabilities, sourceProvenanceErrors } from "./scrape-streams.mjs";

test("ZLive live catalog events survive publication as opaque references", async () => {
  const now = new Date("2026-11-24T20:00:00Z");
  const games = parseZLiveEvents([{
    id: "event-42", name: "Boston Red Sox at New York Yankees", type: "MLB",
    startTime: "2026-11-24T19:00:00Z", live: true, source: { key: "main", label: "Main" },
    sources: [{ url: "https://example.test/private.m3u8" }],
  }], now);
  const [game] = attachScheduleGames(games, [], now);
  const [source] = game.sources;
  assert.equal(game.status, "live");
  assert.equal(source.providerSourceRef, "zlive:event-42");
  assert.equal(await inspectStreamCapabilities(source), source);
  assert.deepEqual(deduplicatePlaybackSources([source, source]), [source]);
  assert.deepEqual(sourceProvenanceErrors([game]), []);
  const invalid = { ...source, headers: { Authorization: "private" } };
  assert.equal(await inspectStreamCapabilities(invalid), null);
  assert.ok(sourceProvenanceErrors([{ ...game, sources: [invalid] }]).length);
});
