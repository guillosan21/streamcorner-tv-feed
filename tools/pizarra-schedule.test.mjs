import assert from "node:assert/strict";
import test from "node:test";
import {
  attachScheduleGames,
  attachTimeLimitedDlStreamsSources,
  deduplicateFeedGames,
  deduplicateFeedSources,
  isEspnDelayedGameWithinStaleLimit,
  isExplicitEspnDelayedEvent,
  parseExplicitEspnRestartAt,
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

test("ESPN delay classification is limited to explicit pre/in event statuses", () => {
  assert.equal(isExplicitEspnDelayedEvent({ status: { type: { state: "pre", name: "STATUS_DELAYED" } } }), true);
  assert.equal(isExplicitEspnDelayedEvent({ status: { type: { state: "in", description: "Weather Delay" } } }), true);
  assert.equal(isExplicitEspnDelayedEvent({ status: { type: { state: "in", detail: "Delayed penalty" } } }), false);
  assert.equal(isExplicitEspnDelayedEvent({ status: { type: { state: "in", name: "STATUS_DELAYED", detail: "Delayed penalty" } } }), false);
  assert.equal(isExplicitEspnDelayedEvent({ status: { type: { state: "post", name: "STATUS_DELAYED" } } }), false);
  assert.equal(isExplicitEspnDelayedEvent({ status: { type: { state: "pre", description: "Postponed" } } }), false);
});

test("ESPN restart times require a complete date, time, and zone", () => {
  assert.equal(parseExplicitEspnRestartAt("Delayed until 8:00 PM"), "");
  assert.equal(parseExplicitEspnRestartAt("Weather Delay"), "");
  assert.equal(parseExplicitEspnRestartAt("Delayed until Sep 30, 2026 at 8:00 PM EDT"), "2026-10-01T00:00:00.000Z");
});

test("delayed schedule rows survive original estimated end only within a bounded stale window", () => {
  const now = Date.parse("2026-09-30T00:00:00.000Z");
  const fresh = { isDelayed: true, scheduleState: "pre", startsAt: "2026-09-29T22:00:00.000Z" };
  assert.equal(isEspnDelayedGameWithinStaleLimit(fresh, now), true);
  assert.equal(isEspnDelayedGameWithinStaleLimit({ ...fresh, startsAt: "2026-10-01T22:00:00.000Z" }, now), true);
  assert.equal(isEspnDelayedGameWithinStaleLimit({ ...fresh, startsAt: "2026-09-27T22:00:00.000Z" }, now), false);
  assert.equal(isEspnDelayedGameWithinStaleLimit({ ...fresh, scheduleState: "in", startsAt: "2026-09-27T22:00:00.000Z" }, now), false);
  assert.equal(isEspnDelayedGameWithinStaleLimit({ ...fresh, scheduleState: "post" }, now), false);
  assert.equal(isEspnDelayedGameWithinStaleLimit({ ...fresh, isDelayed: false }, now), false);
});

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

function attestedDlStreamsChannel(overrides = {}) {
  return {
    id: "dlstreams-926",
    provider: "dlstreams",
    sourceId: "926",
    title: "ESPN 2 MX",
    league: "Mexico Sports",
    sport: "Sports",
    startsAt: "2026-09-29T20:59:00.000Z",
    endsAt: "2026-09-30T22:00:00.000Z",
    status: "live",
    is24x7: true,
    sources: [{
      provider: "DLStreams",
      embedProvider: "DLStreams",
      name: "DLStreams • ESPN 2 MX",
      url: "",
      clearKey: "",
      embedUrl: "https://dlstreams.st/stream/stream-926.php",
      headers: { Referer: "https://dlstreams.st/watch.php?id=926" },
    }],
    ...overrides,
  };
}

function astrosPpvCard(overrides = {}) {
  return {
    id: "ppv-29614",
    provider: "ppv",
    sourceId: "29614",
    title: "Chicago White Sox at Houston Astros",
    league: "MLB",
    sport: "Baseball",
    startsAt: "2026-09-29T21:00:00.000Z",
    endsAt: "2026-09-30T03:00:00.000Z",
    status: "live",
    scheduleState: "in",
    scoreboardLeagueId: "MLB",
    scoreboardEventId: "espn-mlb-401907896",
    espnBroadcasts: ["ESPN2"],
    sources: [{ provider: "PPV", name: "PPV • Chicago White Sox at Houston Astros", embedUrl: "https://ppv.st/event/29614" }],
    ...overrides,
  };
}

test("temporary DLStreams attestation attaches only channel 926 to the existing reconciled Astros card", () => {
  const card = astrosPpvCard();
  const channel = attestedDlStreamsChannel();
  const games = [card, channel];

  assert.equal(attachTimeLimitedDlStreamsSources(games, new Date("2026-09-29T22:00:00.000Z")), 1);
  assert.equal(games.length, 2);
  assert.equal(card.id, "ppv-29614");
  assert.equal(card.sources.filter((source) => source.provider === "DLStreams").length, 1);
  assert.deepEqual(card.sources.find((source) => source.provider === "DLStreams"), channel.sources[0]);
  assert.equal(channel.sources.length, 1);

  const repeat = attachTimeLimitedDlStreamsSources(games, new Date("2026-09-29T22:00:00.000Z"));
  assert.equal(repeat, 0);

  const canonicalEspnGame = astrosPpvCard({
    id: "espn-mlb-401907896",
    provider: "espn-schedule",
    scoreboardEventId: "",
  });
  assert.equal(attachTimeLimitedDlStreamsSources([canonicalEspnGame, channel], new Date("2026-09-29T22:00:00.000Z")), 1);
});

test("temporary DLStreams attestation rejects unrelated channels, games, and time/state windows", () => {
  const now = new Date("2026-09-29T22:00:00.000Z");
  const rejectedCases = [
    { event: astrosPpvCard({ scoreboardEventId: "espn-mlb-401907895" }), channel: attestedDlStreamsChannel() },
    { event: astrosPpvCard(), channel: attestedDlStreamsChannel({ id: "dlstreams-925", sourceId: "925" }) },
    { event: astrosPpvCard(), channel: attestedDlStreamsChannel({ title: "ESPN 2 USA" }) },
    { event: astrosPpvCard({ startsAt: "2026-09-29T20:00:00.000Z" }), channel: attestedDlStreamsChannel() },
    { event: astrosPpvCard({ status: "upcoming", scheduleState: "pre" }), channel: attestedDlStreamsChannel() },
    { event: astrosPpvCard({ status: "live", scheduleState: "post" }), channel: attestedDlStreamsChannel() },
  ];
  for (const { event, channel } of rejectedCases) {
    assert.equal(attachTimeLimitedDlStreamsSources([event, channel], now), 0);
    assert.equal(event.sources.some((source) => source.provider === "DLStreams"), false);
  }

  for (const instant of ["2026-09-29T20:59:59.999Z", "2026-09-30T03:00:00.000Z"]) {
    const event = astrosPpvCard();
    const channel = attestedDlStreamsChannel();
    assert.equal(attachTimeLimitedDlStreamsSources([event, channel], new Date(instant)), 0, instant);
  }
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
