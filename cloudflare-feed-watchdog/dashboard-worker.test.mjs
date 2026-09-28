import assert from "node:assert/strict";
import test from "node:test";
import worker from "./dashboard-worker.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const env = { GITHUB_TOKEN: "test-token" };

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

async function scheduled(responses, workerEnv = env) {
  const oldFetch = globalThis.fetch;
  const oldNow = Date.now;
  const calls = [];
  let pending;
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const result = responses.shift();
    if (result instanceof Error) throw result;
    return result;
  };
  Date.now = () => NOW;
  try {
    worker.scheduled({}, workerEnv, { waitUntil(promise) { pending = promise; } });
    await pending;
  } finally {
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
  }
  return calls;
}

test("requires the GitHub secret and skips a fresh feed", async () => {
  assert.equal((await scheduled([], {})).length, 0);
  const calls = await scheduled([response({ updatedAt: new Date(NOW - 3 * 60_000).toISOString() })]);
  assert.equal(calls.length, 1);
});

test("stale feed dispatches main when no active or recent run exists", async () => {
  const calls = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({ workflow_runs: [] }),
    response(null, 204),
  ]);
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /per_page=20/);
  assert.equal(calls[2].init.method, "POST");
  assert.equal(calls[2].init.headers.authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(calls[2].init.body), { ref: "main" });
});

test("scans the recent page for active runs and cools down from completion", async () => {
  const stale = response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() });
  const overlapping = await scheduled([stale, response({ workflow_runs: [
    { status: "completed", updated_at: new Date(NOW - 12 * 60_000).toISOString() },
    { status: "in_progress", updated_at: new Date(NOW - 20 * 60_000).toISOString() },
  ] })]);
  assert.equal(overlapping.length, 2);

  const longRun = await scheduled([stale, response({ workflow_runs: [{
    status: "completed",
    created_at: new Date(NOW - 45 * 60_000).toISOString(),
    updated_at: new Date(NOW - 2 * 60_000).toISOString(),
  }] })]);
  assert.equal(longRun.length, 2);
});

test("feed and API errors fail closed", async () => {
  assert.equal((await scheduled([new Error("offline")])).length, 1);
  assert.equal((await scheduled([response({ updatedAt: "bad" })])).length, 1);
  assert.equal((await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({}, 403),
  ])).length, 2);
});
