import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSufficientEspnScheduleCoverage,
  fetchEspnSchedules,
} from "./espn-schedules.mjs";

test("single-day requests recover when multi-day ESPN ranges return HTTP 400", async () => {
  const league = { id: "MLB", path: "baseball/mlb", name: "MLB" };
  const requestedDates = [];
  const [result] = await fetchEspnSchedules([league], ["20260924", "20260925"], {
    concurrency: 2,
    timeoutMs: 1_000,
    maxTotalRequests: 10,
    scheduleBudgetMs: 5_000,
    minRequestIntervalMs: 0,
    transientRetries: 0,
    onFailure: () => {},
    fetcher: async (url) => {
      const date = new URL(url).searchParams.get("dates");
      requestedDates.push(date);
      if (date.includes("-")) return { ok: false, status: 400 };
      return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ events: [] }) };
    },
  });

  assert.deepEqual(requestedDates.sort(), ["20260924", "20260925"]);
  assert.deepEqual(result.successfulDates, ["20260924", "20260925"]);
  assert.deepEqual(result.failedDates, []);
});

test("cross-date duplicate prefers a resumed same-state observation in either date order", async () => {
  const league = { id: "NHL", path: "hockey/nhl", name: "NHL" };
  const delayed = {
    id: "nhl-42", date: "2026-09-24T23:00:00Z", name: "Away at Home",
    status: { type: { state: "in", name: "STATUS_DELAYED", description: "Delayed", detail: "Weather Delay" } },
    competitions: [{ competitors: [
      { homeAway: "home", score: "2", team: { id: "home", displayName: "Home" } },
      { homeAway: "away", score: "1", team: { id: "away", displayName: "Away" } },
    ] }],
  };
  const resumed = {
    ...delayed,
    status: { type: { state: "in", name: "STATUS_IN_PROGRESS", description: "In Progress", shortDetail: "2nd Period" } },
  };

  async function collect(firstDateEvent, secondDateEvent) {
    const [result] = await fetchEspnSchedules([league], ["20260923", "20260924"], {
      concurrency: 1, timeoutMs: 1_000, maxTotalRequests: 2, scheduleBudgetMs: 5_000,
      minRequestIntervalMs: 0, transientRetries: 0, onFailure: () => {},
      fetcher: async (url) => {
        const date = new URL(url).searchParams.get("dates");
        const events = date === "20260923" ? [firstDateEvent] : [secondDateEvent];
        return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ events }) };
      },
    });
    return result.events;
  }

  const delayedFirst = await collect(delayed, resumed);
  const resumedFirst = await collect(resumed, delayed);

  assert.equal(delayedFirst.length, 1);
  assert.equal(resumedFirst.length, 1);
  assert.equal(delayedFirst[0].status.type.shortDetail, "2nd Period");
  assert.equal(resumedFirst[0].status.type.shortDetail, "2nd Period");
  assert.equal(isDelayed(delayedFirst[0]), false);
  assert.equal(isDelayed(resumedFirst[0]), false);
});

function isDelayed(event) {
  return event.status.type.name === "STATUS_DELAYED";
}

test("incomplete ESPN schedule coverage fails closed", () => {
  const dates = ["20260923", "20260924", "20260925"];
  const leagues = [{ id: "MLB", path: "baseball/mlb", name: "MLB" }];
  const results = [{ successfulDates: [dates[2]], failedDates: [dates[0], dates[1]] }];

  assert.throws(
    () => assertSufficientEspnScheduleCoverage(leagues, dates, results),
    /coverage is materially incomplete.*feed files were not written/,
  );
});
