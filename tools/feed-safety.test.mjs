import test from "node:test";
import assert from "node:assert/strict";

import { compareFeedSourceCoverage } from "./feed-safety.mjs";

const now = new Date("2026-09-27T06:00:00Z");

function source(index, provider = "DLStreams") {
  return { provider, url: `https://media.example/${index}.m3u8`, clearKey: "" };
}

function liveGame(index, sources) {
  return {
    id: `event-${index}`,
    status: "live",
    startsAt: "2026-09-27T05:00:00Z",
    endsAt: "2026-09-27T08:00:00Z",
    sources,
  };
}

test("coverage guard counts only time-valid non-Pizarra sources and blocks material loss", () => {
  const previousGames = Array.from({ length: 100 }, (_, index) => liveGame(index, [source(index)]));
  previousGames.push(
    { ...liveGame("expired", [source("expired")]), endsAt: "2026-09-27T05:30:00Z" },
    { ...liveGame("upcoming-expired", [source("upcoming-expired")]), status: "upcoming", startsAt: "2026-09-27T05:30:00Z" },
  );
  const currentGames = Array.from({ length: 40 }, (_, index) => liveGame(index, [source(index)]));
  currentGames.push(liveGame("pizarra", [{ ...source("new-ref", "Pizarra MX"), url: "", providerSourceRef: `pizarramx:v1~e~${"a".repeat(64)}~${"b".repeat(64)}` }]));
  const result = compareFeedSourceCoverage({ updatedAt: "2026-09-27T05:55:00Z", games: previousGames }, currentGames, now);

  assert.equal(result.previousSourceCount, 100);
  assert.equal(result.currentSourceCount, 40);
  assert.equal(result.missingSourceCount, 60);
  assert.equal(result.lossRatio, 0.6);
  assert.equal(result.materialLoss, true);
});

test("Pizarra refs cannot mask a non-Pizarra source regression", () => {
  const previousGames = Array.from({ length: 40 }, (_, index) => liveGame(index, [source(index)]));
  const currentGames = Array.from({ length: 15 }, (_, index) => liveGame(index, [source(index)]));
  currentGames.push(liveGame("pizarra", Array.from({ length: 40 }, (_, index) => ({
    provider: "Pizarra MX",
    url: "",
    providerSourceRef: `pizarramx:v1~e~${String(index).padStart(64, "a")}~${"b".repeat(64)}`,
  }))));
  const result = compareFeedSourceCoverage({ updatedAt: "2026-09-27T05:55:00Z", games: previousGames }, currentGames, now);

  assert.equal(result.previousSourceCount, 40);
  assert.equal(result.currentSourceCount, 15);
  assert.equal(result.materialLoss, true);
});

test("provider migration skips only legacy StreamCorner identities in the loss baseline", () => {
  const previousGames = [
    ...Array.from({ length: 100 }, (_, index) => liveGame(`legacy-${index}`, [source(`old-${index}`, "StreamCorner")])),
    ...Array.from({ length: 100 }, (_, index) => liveGame(`other-${index}`, [source(`other-${index}`)])),
  ];
  const currentGames = Array.from({ length: 80 }, (_, index) => liveGame(`other-${index}`, [source(`other-${index}`)]));
  const result = compareFeedSourceCoverage({ updatedAt: "2026-09-27T05:55:00Z", games: previousGames }, currentGames, now);

  assert.equal(result.previousSourceCount, 100);
  assert.equal(result.currentSourceCount, 80);
  assert.equal(result.missingSourceCount, 20);
  assert.equal(result.materialLoss, false);
});

test("expired prior events do not become a source-loss baseline", () => {
  const oldFeed = {
    updatedAt: "2026-09-26T06:00:00Z",
    games: Array.from({ length: 80 }, (_, index) => ({
      ...liveGame(index, [source(index)]),
      endsAt: "2026-09-27T05:30:00Z",
    })),
  };
  const currentGames = Array.from({ length: 80 }, (_, index) => liveGame(index, [source(index)]));
  const result = compareFeedSourceCoverage(oldFeed, currentGames, now);
  assert.equal(result.previousSourceCount, 0);
  assert.equal(result.materialLoss, false);
});
