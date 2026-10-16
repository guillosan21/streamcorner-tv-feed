import test from "node:test";
import assert from "node:assert/strict";
import { espnEventInfo } from "./event-info.mjs";
test("ESPN overall record, football week, broadcasts, and event note", () => {
  const info = espnEventInfo({ week: { number: 6 }, season: { slug: "regular-season" } }, {
    competitors: [{ homeAway: "home", records: [{ type: "home", summary: "3-0" }, { type: "total", summary: "4-1" }] },
      { homeAway: "away", records: [{ name: "overall", summary: "0-5" }] }],
    broadcasts: [{ names: ["CBS", "cbs"] }], geoBroadcasts: [{ type: { shortName: "Radio" }, media: { shortName: "RADIO" } }],
    notes: [{ type: "event", headline: "NFL London Games" }],
  });
  assert.deepEqual(info, { stage: "Week 6", note: "NFL London Games", phase: "Regular season", channels: ["CBS"], homeRecord: "4-1", awayRecord: "0-5" });
});
test("explicit postseason round and note; do not invent records or phase", () => {
  const info = espnEventInfo({ week: { number: 0 }, season: { slug: "post-season" } }, {
    type: { abbreviation: "SEMI" }, notes: [{ type: "event", headline: "ALCS - Game 4" }],
    series: { competitors: [{ wins: 2 }] }, competitors: [{ homeAway: "home", records: [{ type: "home", summary: "2-0" }] }],
  });
  assert.equal(info.stage, "Semifinal"); assert.equal(info.note, "ALCS - Game 4"); assert.equal(info.phase, "Postseason");
  assert.equal(info.homeRecord, ""); assert.equal(espnEventInfo({}, {}).stage, "");
  assert.equal(espnEventInfo({ week: { number: 1001 } }, {}).stage, "");
});
test("publisher deduplication keeps records aligned even when state and row authorities disagree", async () => {
  const { deduplicateFeedGames } = await import("./scrape-streams.mjs");
  const base = { title: "Away at Home", league: "NFL", sport: "American Football", startsAt: "2026-10-16T20:00:00Z",
    endsAt: "2026-10-17T00:00:00Z", status: "upcoming", scoreboardEventId: "espn-nfl-1", scoreboardLeagueId: "NFL", sources: [] };
  const cached = { ...base, id: "a", homeTeam: "Home", awayTeam: "Away", scheduleState: "pre",
    homeLogoUrl: "https://a.espncdn.com/home.png", awayLogoUrl: "https://a.espncdn.com/away.png",
    eventInfo: { stage: "Week 6", homeRecord: "4-1", awayRecord: "0-5", channels: ["CBS"] } };
  const current = { ...base, id: "b", title: "Home at Away", homeTeam: "Away", awayTeam: "Home", scheduleState: "in", status: "live",
    eventInfo: { stage: "Week 7", homeRecord: "0-5", awayRecord: "4-1", channels: ["FOX"] } };
  const result = deduplicateFeedGames([cached, current])[0];
  assert.equal(result.homeTeam, "Home"); assert.equal(result.awayTeam, "Away");
  assert.equal(result.eventInfo.homeRecord, "4-1"); assert.equal(result.eventInfo.awayRecord, "0-5");
  assert.ok(result.eventInfo.channels.length);
  const withoutInfo = { ...cached, eventInfo: undefined };
  assert.equal(deduplicateFeedGames([withoutInfo, current])[0].eventInfo.homeRecord, "4-1");
});