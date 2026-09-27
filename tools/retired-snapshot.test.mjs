import test from "node:test";
import assert from "node:assert/strict";

import { assertRetiredSnapshotMatchesCurrent, deriveRetiredSourceSnapshot } from "./retired-snapshot.mjs";

function fixture() {
  return {
    feed: {
      updatedAt: "2026-09-27T20:11:04.460Z",
      catalogCounts: { streamed: 81, ppv: 4, dlstreams: 20 },
      teams: [{ id: "team-1", name: "Home" }],
      games: [
        {
          id: "live-1",
          title: "Home vs Away",
          sources: [
            { provider: "Streamed", embedProvider: "Streamed", embedUrl: "https://embed.st/embed/hotel/live-1/1" },
            { provider: "PPV", name: "PPV • English", embedUrl: "https://ppv.st/player/live-1" },
          ],
        },
        {
          id: "schedule-1",
          title: "Away vs Other",
          sources: [{ provider: "Streamed", embedUrl: "https://embed.st/embed/hotel/schedule-1/1" }],
        },
      ],
      scores: [{ eventId: "live-1", homeScore: 2, awayScore: 1 }],
    },
    status: {
      updatedAt: "2026-09-27T20:11:04.460Z",
      gameCount: 2,
      qualityFilteredSourceCount: 20,
      qualityFilteredSourcesByProvider: { Streamed: 19, DLStreams: 1 },
      sourceCoverage: { previousSourceCount: 147, currentSourceCount: 186, missingSourceCount: 53 },
      streamedErrors: [],
      streamedCatalogCounts: { matches: 81, playableSources: 150 },
    },
  };
}

test("snapshot derivation removes only retired source and status metrics", () => {
  const { feed, status } = fixture();
  const result = deriveRetiredSourceSnapshot(feed, status);

  assert.equal(result.removedSourceCount, 2);
  assert.deepEqual(result.removedSourceProviderCounts, { Streamed: 2 });
  assert.equal(result.feed.updatedAt, feed.updatedAt);
  assert.equal(result.status.updatedAt, status.updatedAt);
  assert.equal(result.feed.games.length, 2);
  assert.deepEqual(result.feed.games[0].sources, [feed.games[0].sources[1]]);
  assert.deepEqual(result.feed.games[1].sources, []);
  assert.deepEqual(result.feed.scores, feed.scores);
  assert.deepEqual(result.feed.teams, feed.teams);
  assert.deepEqual(result.feed.catalogCounts, { ppv: 4, dlstreams: 20 });
  assert.equal(result.status.qualityFilteredSourceCount, 1);
  assert.deepEqual(result.status.qualityFilteredSourcesByProvider, { DLStreams: 1 });
  assert.deepEqual(result.status.sourceCoverage, status.sourceCoverage);
  assert.equal("streamedErrors" in result.status, false);
  assert.equal("streamedCatalogCounts" in result.status, false);
});

test("snapshot validator rejects unrelated game, source, score, status, and timestamp edits", () => {
  const { feed, status } = fixture();
  const expected = deriveRetiredSourceSnapshot(feed, status);
  assert.doesNotThrow(() => assertRetiredSnapshotMatchesCurrent(feed, status, expected.feed, expected.status));

  const edits = [
    (candidate) => { candidate.feed.games[0].title = "Changed title"; },
    (candidate) => { candidate.feed.games[0].sources[0].embedUrl = "https://other.example/player"; },
    (candidate) => { candidate.feed.scores[0].homeScore = 3; },
    (candidate) => { candidate.status.gameCount = 999; },
    (candidate) => { candidate.status.updatedAt = "2026-09-27T20:12:00.000Z"; },
  ];
  for (const edit of edits) {
    const candidate = structuredClone(expected);
    edit(candidate);
    assert.throws(
      () => assertRetiredSnapshotMatchesCurrent(feed, status, candidate.feed, candidate.status),
      /preserve .* timestamps|changes beyond retired source and metric removal/,
    );
  }
});
