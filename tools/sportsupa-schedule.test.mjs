import test from "node:test";
import assert from "node:assert/strict";
import { attachScheduleGames } from "./scrape-streams.mjs";

const sources = [
  { provider: "SportsUpa", embedProvider: "SportsUpa", hd: true, url: "",
    name: "SportsUpa • Main HD 1", embedUrl: "https://embed.st/embed/ingest/example/1/",
    headers: { Referer: "https://sportsupa.st/" } },
  { provider: "SportsUpa", embedProvider: "SportsUpa", hd: true, url: "",
    name: "SportsUpa • Admin HD 1", embedUrl: "https://embed.st/embed/admin/example/1",
    headers: { Referer: "https://sportsupa.st/" } },
];
const base = {
  id: "sportsupa-example", provider: "SportsUpa", title: "Away at Home",
  homeTeam: "Home", awayTeam: "Away", sport: "baseball", league: "MLB",
  startsAt: "2026-10-01T20:00:00Z", status: "upcoming",
};
const official = { ...base, id: "espn-example", provider: "espn",
  scoreboardEventId: "official-example", scheduleState: "pre", sources: [] };

test("Main and Admin merge into one official card without inferring live from available sources", () => {
  const result = attachScheduleGames(sources.map(source => ({ ...base, sources: [source] })),
    [official], new Date("2026-10-01T16:00:00Z"));
  assert.equal(result.length, 1);
  assert.equal(result[0].scoreboardEventId, "official-example");
  assert.equal(result[0].status, "upcoming");
  assert.equal(result[0].sources.length, 2);
  assert.deepEqual(new Set(result[0].sources.map(source => source.embedUrl)),
    new Set(sources.map(source => source.embedUrl)));
});

test("Admin availability cannot retain a completed official game", () => {
  const result = attachScheduleGames([{ ...base, sources: [sources[1]] }],
    [{ ...official, scheduleState: "post", status: "ended" }],
    new Date("2026-10-01T23:00:00Z"));
  assert.deepEqual(result, []);
});
