import test from "node:test";
import assert from "node:assert/strict";

import { compareFeedSourceCoverage } from "./feed-safety.mjs";
import { feedSourceKey } from "./playback-identity.mjs";

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

test("retiring Streamed removes its 149 sources from the baseline and keeps active-provider loss protection", () => {
  const previousGames = [
    ...Array.from({ length: 149 }, (_, index) => liveGame(`retired-${index}`, [{
      provider: "Streamed",
      embedUrl: `https://embed.st/embed/hotel/live-${index}/1`,
    }])),
    ...Array.from({ length: 100 }, (_, index) => liveGame(`active-${index}`, [source(`active-${index}`)])),
  ];
  const previousFeed = { updatedAt: "2026-09-27T05:55:00Z", games: previousGames };
  const allActiveSourcesRemain = Array.from({ length: 100 }, (_, index) => liveGame(`active-${index}`, [source(`active-${index}`)]));
  const afterRetirement = compareFeedSourceCoverage(previousFeed, allActiveSourcesRemain, now);

  assert.equal(afterRetirement.previousSourceCount, 100);
  assert.equal(afterRetirement.currentSourceCount, 100);
  assert.equal(afterRetirement.missingSourceCount, 0);
  assert.equal(afterRetirement.materialLoss, false);

  const activeProviderRegression = Array.from({ length: 40 }, (_, index) => liveGame(`active-${index}`, [source(`active-${index}`)]));
  const stillStrict = compareFeedSourceCoverage(previousFeed, activeProviderRegression, now);
  assert.equal(stillStrict.previousSourceCount, 100);
  assert.equal(stillStrict.currentSourceCount, 40);
  assert.equal(stillStrict.missingSourceCount, 60);
  assert.equal(stillStrict.materialLoss, true);
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

test("known SD sources are reported and excluded from the source-loss baseline", () => {
  const previousGames = [
    ...Array.from({ length: 60 }, (_, index) => liveGame(`hd-${index}`, [source(`hd-${index}`)])),
    ...Array.from({ length: 40 }, (_, index) => liveGame(`sd-${index}`, [{ ...source(`sd-${index}`), maxHeight: 480 }])),
  ];
  const currentGames = Array.from({ length: 60 }, (_, index) => liveGame(`hd-${index}`, [source(`hd-${index}`)]));
  const result = compareFeedSourceCoverage({ updatedAt: "2026-09-27T05:55:00Z", games: previousGames }, currentGames, now);

  assert.equal(result.previousSourceCount, 60);
  assert.equal(result.currentSourceCount, 60);
  assert.equal(result.previousKnownSdSourceCount, 40);
  assert.equal(result.missingSourceCount, 0);
  assert.equal(result.materialLoss, false);
});

test("current explicit SD evidence exempts only matching prior source identities", () => {
  const previousGames = [
    ...Array.from({ length: 60 }, (_, index) => liveGame(`normal-${index}`, [source(`normal-${index}`)])),
    ...Array.from({ length: 40 }, (_, index) => liveGame(`old-sd-${index}`, [{
      ...source(`old-sd-${index}`),
      maxHeight: 480,
    }])),
  ];
  const currentGames = Array.from({ length: 20 }, (_, index) => liveGame(`normal-${index}`, [source(`normal-${index}`)]));
  const intentionallyExcludedSdSourceKeys = new Set(previousGames
    .filter((game) => game.id.includes("old-sd-"))
    .flatMap((game) => game.sources)
    .map(feedSourceKey));
  const result = compareFeedSourceCoverage(
    { updatedAt: "2026-09-27T05:55:00Z", games: previousGames },
    currentGames,
    now,
    { intentionallyExcludedSdSourceKeys },
  );

  assert.equal(result.previousSourceCount, 60);
  assert.equal(result.currentSourceCount, 20);
  assert.equal(result.previousKnownSdSourceCount, 40);
  assert.equal(result.intentionallyExcludedPriorSourceCount, 40);
  assert.equal(result.missingSourceCount, 40);
  assert.equal(result.lossRatio, 2 / 3);
  assert.equal(result.materialLoss, true);
});
