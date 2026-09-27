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

test("incomplete ESPN schedule coverage fails closed", () => {
  const dates = ["20260923", "20260924", "20260925"];
  const leagues = [{ id: "MLB", path: "baseball/mlb", name: "MLB" }];
  const results = [{ successfulDates: [dates[2]], failedDates: [dates[0], dates[1]] }];

  assert.throws(
    () => assertSufficientEspnScheduleCoverage(leagues, dates, results),
    /coverage is materially incomplete.*feed files were not written/,
  );
});
