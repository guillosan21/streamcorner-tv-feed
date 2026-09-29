import assert from "node:assert/strict";
import test from "node:test";
import {
  attachScheduleGames,
  deduplicateFeedGames,
  deduplicateFeedSources,
  sameFeedEvent,
} from "./scrape-streams.mjs";
import { parsePizarraMxCatalog } from "./pizarramx.mjs";

function pizarraSource(availableBeforeKickoff = true) {
  return {
    name: "Pizarra MX • Atlas vs Monterrey",
    provider: "Pizarra MX",
    providerSourceRef: `pizarramx:v1~e~${"a".repeat(64)}~${"b".repeat(64)}`,
    availableBeforeKickoff,
  };
}

function pizarraGame(overrides = {}) {
  return {
    id: "pizarra-atlas-monterrey",
    provider: "pizarramx",
    sourceId: "pizarra-42",
    title: "Atlas vs Monterrey",
    league: "Liga MX",
    sport: "Soccer",
    startsAt: "2026-09-26T13:00:00.000Z",
    endsAt: "",
    status: "live",
    scheduleState: "in",
    is24x7: false,
    homeTeam: "Atlas",
    awayTeam: "Monterrey",
    sources: [pizarraSource()],
    ...overrides,
  };
}

function espnGame(id, startsAt, overrides = {}) {
  return {
    id: `espn-liga_mx-${id}`,
    provider: "espn-schedule",
    sourceId: id,
    title: "Monterrey at Atlas",
    league: "Liga MX",
    sport: "Soccer",
    startsAt,
    endsAt: "2026-09-26T22:00:00.000Z",
    status: "upcoming",
    scheduleState: "pre",
    scoreboardLeagueId: "LIGA_MX",
    scoreboardEventId: `espn-liga_mx-${id}`,
    homeTeam: "Atlas",
    awayTeam: "Monterrey",
    sources: [{ name: "TimStreams • ESPN event", provider: "TimStreams", url: `https://cdn.example/${id}.m3u8` }],
    ...overrides,
  };
}

test("live Pizarra marker enables a unique multi-hour ESPN kickoff match", () => {
  const pizarra = pizarraGame();
  const official = espnGame("event-1", "2026-09-26T18:00:00.000Z");
  const attached = attachScheduleGames([pizarra], [official], new Date("2026-09-26T12:00:00.000Z"));

  assert.equal(attached.length, 1);
  assert.equal(attached[0].scoreboardEventId, official.scoreboardEventId);
  assert.equal(attached[0].startsAt, official.startsAt);
  assert.equal(attached[0].scheduleState, "pre");
  assert.equal(attached[0].status, "upcoming");
  assert.deepEqual(new Set(attached[0].sources.map((source) => source.provider)), new Set(["Pizarra MX", "TimStreams"]));
  assert.equal(attached[0].sources.find((source) => source.provider === "Pizarra MX").availableBeforeKickoff, true);

  const undeclaredEarly = pizarraGame({ startsAt: "2026-09-26T17:10:00.000Z", sources: [pizarraSource(false)] });
  const notAttached = attachScheduleGames([undeclaredEarly], [official], new Date("2026-09-26T16:00:00.000Z"));
  assert.equal(notAttached.find((game) => game.provider === "pizarramx").scoreboardEventId || "", "");
});

test("a near same-team doubleheader stays unbound and holds until earliest kickoff minus 15 minutes", () => {
  const pizarra = pizarraGame({ startsAt: "2026-09-26T17:10:00.000Z" });
  const first = espnGame("event-1", "2026-09-26T17:00:00.000Z");
  const second = espnGame("event-2", "2026-09-26T17:30:00.000Z");
  const result = attachScheduleGames([pizarra], [first, second], new Date("2026-09-26T16:00:00.000Z"));
  const held = result.find((game) => game.provider === "pizarramx");

  assert.equal(result.length, 3);
  assert.equal(held.scoreboardEventId || "", "");
  assert.equal(held.doNotAttachToOfficialSchedule, true);
  assert.equal(held.awaitingOfficialKickoffUntil, "2026-09-26T16:45:00.000Z");
  assert.equal(result.filter((game) => game.scoreboardEventId).length, 2);
  assert.equal(result.some((game) => game.sources.some((source) => source.provider === "Pizarra MX") && game.scoreboardEventId), false);
  assert.equal(sameFeedEvent(first, second), false);
});

test("the early-play hold expires at the exact kickoff-minus-15-minute boundary", () => {
  const schedules = [
    espnGame("event-1", "2026-09-26T17:00:00.000Z"),
    espnGame("event-2", "2026-09-26T17:30:00.000Z"),
  ];
  const before = attachScheduleGames(
    [pizarraGame({ startsAt: "2026-09-26T17:10:00.000Z" })],
    schedules,
    new Date("2026-09-26T16:44:59.000Z"),
  ).find((game) => game.provider === "pizarramx");
  const boundary = attachScheduleGames(
    [pizarraGame({ startsAt: "2026-09-26T17:10:00.000Z" })],
    schedules,
    new Date("2026-09-26T16:45:00.000Z"),
  ).find((game) => game.provider === "pizarramx");

  assert.equal(before.awaitingOfficialKickoffUntil, "2026-09-26T16:45:00.000Z");
  assert.equal(boundary.awaitingOfficialKickoffUntil, undefined);
  assert.equal(boundary.doNotAttachToOfficialSchedule, true);
});

test("ESPN pre, in, and post states remain authoritative for a uniquely joined Pizarra source", () => {
  for (const [scheduleState, status, expectedCount] of [
    ["pre", "upcoming", 1],
    ["in", "live", 1],
    ["post", "upcoming", 0],
  ]) {
    const official = espnGame("event-1", "2026-09-26T18:00:00.000Z", { scheduleState, status });
    const result = attachScheduleGames(
      [pizarraGame()],
      [official],
      new Date("2026-09-26T12:00:00.000Z"),
    );
    assert.equal(result.length, expectedCount, `schedule state ${scheduleState}`);
    if (!expectedCount) continue;
    assert.equal(result[0].scheduleState, scheduleState);
    assert.equal(result[0].status, status);
    assert.deepEqual(new Set(result[0].sources.map((source) => source.provider)), new Set(["Pizarra MX", "TimStreams"]));
  }
});

test("ESPN pre remains authoritative when event dedup sees a provider live hint", () => {
  const official = espnGame("event-1", "2026-09-26T18:00:00.000Z");
  const providerLive = {
    ...official,
    id: "timstreams-atlas-monterrey",
    provider: "timstreams",
    scoreboardLeagueId: "",
    scoreboardEventId: "",
    scheduleState: "in",
    status: "live",
    sources: [{ name: "TimStreams • Live", provider: "TimStreams", url: "https://cdn.example/live.m3u8" }],
  };

  for (const rows of [[official, providerLive], [providerLive, official]]) {
    const merged = deduplicateFeedGames(rows);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].scoreboardEventId, official.scoreboardEventId);
    assert.equal(merged[0].scheduleState, "pre");
    assert.equal(merged[0].status, "upcoming");
  }
});

test("untimed manual Pizarra stays Upcoming and separate from a timed ESPN matchup", () => {
  const untimed = pizarraGame({
    id: "pizarramx-manual-untimed",
    sourceId: "manual-untimed",
    startsAt: "",
    status: "upcoming",
    scheduleState: "pre",
    sources: [{
      ...pizarraSource(true),
      providerSourceRef: `pizarramx:v1~m~${"c".repeat(64)}~${"d".repeat(64)}`,
    }],
  });
  const official = espnGame("timed-event", "2026-09-26T18:00:00.000Z");

  const result = attachScheduleGames([untimed], [official], new Date("2026-09-26T12:00:00.000Z"));
  const manual = result.find((game) => game.provider === "pizarramx");
  const scheduled = result.find((game) => game.scoreboardEventId === official.scoreboardEventId);

  assert.equal(result.length, 2);
  assert.equal(manual.startsAt, "");
  assert.equal(manual.status, "upcoming");
  assert.equal(manual.scheduleState, "pre");
  assert.equal(manual.sources[0].availableBeforeKickoff, true);
  assert.equal(manual.doNotAttachToOfficialSchedule, true);
  assert.equal(scheduled.startsAt, official.startsAt);
  assert.equal(scheduled.status, "upcoming");
  assert.equal(scheduled.scheduleState, "pre");
  assert.equal(sameFeedEvent(manual, scheduled), false);
});

test("authoritative ESPN live state overrides a future provider timing correction", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const pizarra = parsePizarraMxCatalog({
    partidos: [{
      id: "pizarra-future-live", competition: "Liga MX", home: "Atlas", away: "Monterrey",
      status: "live", kickoff: "2026-09-26T18:00:00Z",
    }],
    detalles: { "pizarra-future-live": { directo: [{
      fuente: "Canal 5",
      embed: '<iframe src="https://exmxbxe.cfd/future-live" title="source"></iframe>',
    }] } },
  }, [], now)[0];
  const officialLive = espnGame("live-despite-future-start", "2026-09-26T18:00:00Z", {
    status: "live",
    scheduleState: "in",
  });

  assert.equal(pizarra.status, "upcoming");
  assert.equal(pizarra.scheduleState, "pre");
  assert.equal(pizarra.sources[0].availableBeforeKickoff, true);

  const result = attachScheduleGames([pizarra], [officialLive], now);
  assert.equal(result.length, 1);
  assert.equal(result[0].scoreboardEventId, officialLive.scoreboardEventId);
  assert.equal(result[0].status, "live");
  assert.equal(result[0].scheduleState, "in");
});

test("source and event dedup preserve early-availability and ambiguity markers", () => {
  const withoutMarker = pizarraSource(false);
  const withMarker = pizarraSource(true);
  assert.equal(deduplicateFeedSources([withoutMarker], [withMarker])[0].availableBeforeKickoff, true);

  const first = pizarraGame({
    awaitingOfficialKickoffUntil: "2026-09-26T16:45:00.000Z",
    doNotAttachToOfficialSchedule: true,
    sources: [withoutMarker],
  });
  const second = pizarraGame({ sources: [withMarker] });
  const merged = deduplicateFeedGames([first, second]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sources[0].availableBeforeKickoff, true);
  assert.equal(merged[0].awaitingOfficialKickoffUntil, "2026-09-26T16:45:00.000Z");
  assert.equal(merged[0].doNotAttachToOfficialSchedule, true);
});
