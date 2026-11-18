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
const currentMain = { ...sources[0], embedUrl: "https://streamec.st/embed/ch30.php",
  headers: { Referer: "https://spotsupa.st/" } };

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

test("current Main availability cannot retain a completed official game", () => {
  assert.deepEqual(attachScheduleGames([{...base,sources:[currentMain]}],
    [{...official,scheduleState:"post",status:"ended"}],new Date("2026-10-01T23:00:00Z")),[]);
});

test("past-kickoff current Main rows require ESPN live confirmation", () => {
  const game = () => ({ ...base, sources: [currentMain] });
  const afterKickoff = new Date("2026-10-01T23:00:00Z");
  assert.deepEqual(attachScheduleGames([game()], [], afterKickoff), []);
  const [live] = attachScheduleGames([game()], [{ ...official, scheduleState: "in", status: "live" }], afterKickoff);
  assert.equal(live.status, "live");
  assert.deepEqual(live.sources, [currentMain]);
  const [future] = attachScheduleGames([game()], [], new Date("2026-10-01T16:00:00Z"));
  assert.equal(future.status, "upcoming");
  assert.deepEqual(future.sources, [currentMain]);
});

test("an unconfirmed SportsUpa source does not remove independent coverage", () => {
  const other = {
    provider: "PPV", embedProvider: "PPV", name: "PPV • HD", url: "",
    embedUrl: "https://embedindia.st/embed/example",
  };
  const [mixed] = attachScheduleGames([{ ...base, sources: [currentMain, other] }], [], new Date("2026-10-01T23:00:00Z"));
  assert.deepEqual(mixed.sources, [other]);
});
