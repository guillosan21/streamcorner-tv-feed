import assert from "node:assert/strict";
import test from "node:test";
import { runWatchdog } from "./index.mjs";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const ENV = {
  FEED_STATUS_URL: "https://feed.example/status.json",
  GITHUB_OWNER: "example-owner",
  GITHUB_REPO: "example-feed",
  GITHUB_WORKFLOW_FILE: "update-feed.yml",
  GITHUB_BRANCH: "main",
  GITHUB_TOKEN: "test-token",
  STALE_AFTER_MINUTES: "10",
  DISPATCH_COOLDOWN_MINUTES: "5",
};

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

function stubFetch(responses) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

function staleStatus() {
  return response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() });
}

function recentCompletedRun() {
  return response({
    workflow_runs: [{
      status: "completed",
      created_at: new Date(NOW - 30 * 60_000).toISOString(),
      updated_at: new Date(NOW - 2 * 60_000).toISOString(),
    }],
  });
}

test("fresh feed does not request workflow runs or dispatch", async () => {
  const { fetchImpl, calls } = stubFetch([
    response({ updatedAt: new Date(NOW - 3 * 60_000).toISOString() }),
  ]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.equal(result.reason, "feed-fresh");
  assert.equal(calls.length, 1);
});

test("stale feed dispatches the main workflow when no recent run exists", async () => {
  const { fetchImpl, calls } = stubFetch([
    staleStatus(),
    response({ workflow_runs: [{
      status: "completed",
      created_at: new Date(NOW - 30 * 60_000).toISOString(),
      updated_at: new Date(NOW - 8 * 60_000).toISOString(),
    }] }),
    response(null, 204),
  ]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.equal(result.action, "dispatched");
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /per_page=20/);
  assert.equal(calls[2].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[2].init.body), { ref: "main" });
  assert.equal(calls[2].init.headers.authorization, "Bearer test-token");
});

test("active workflow run suppresses dispatch", async () => {
  const { fetchImpl, calls } = stubFetch([
    staleStatus(),
    response({ workflow_runs: [{ status: "in_progress", created_at: new Date(NOW - 12 * 60_000).toISOString() }] }),
  ]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.equal(result.reason, "workflow-run-active");
  assert.equal(calls.length, 2);
});

test("recent completed run suppresses dispatch", async () => {
  const { fetchImpl, calls } = stubFetch([staleStatus(), recentCompletedRun()]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.equal(result.reason, "workflow-run-too-recent");
  assert.equal(calls.length, 2);
});

test("long run that completed within the cooldown suppresses dispatch", async () => {
  const { fetchImpl, calls } = stubFetch([
    staleStatus(),
    response({ workflow_runs: [{
      status: "completed",
      created_at: new Date(NOW - 45 * 60_000).toISOString(),
      updated_at: new Date(NOW - 2 * 60_000).toISOString(),
    }] }),
  ]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.equal(result.reason, "workflow-run-too-recent");
  assert.equal(calls.length, 2);
});

test("an older active run in the recent run page suppresses dispatch", async () => {
  const { fetchImpl, calls } = stubFetch([
    staleStatus(),
    response({ workflow_runs: [
      {
        status: "completed",
        created_at: new Date(NOW - 20 * 60_000).toISOString(),
        updated_at: new Date(NOW - 12 * 60_000).toISOString(),
      },
      {
        status: "in_progress",
        created_at: new Date(NOW - 60 * 60_000).toISOString(),
        updated_at: new Date(NOW - 20 * 60_000).toISOString(),
      },
    ] }),
  ]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.equal(result.reason, "workflow-run-active");
  assert.equal(calls.length, 2);
});

test("public repository settings default in source when only the secret is set", async () => {
  const { fetchImpl, calls } = stubFetch([
    staleStatus(),
    response({ workflow_runs: [] }),
    response(null, 204),
  ]);

  const result = await runWatchdog({ GITHUB_TOKEN: "test-token" }, { fetchImpl, now: () => NOW });

  assert.equal(result.action, "dispatched");
  assert.equal(calls[0].url, "https://guillosan21.github.io/streamcorner-tv-feed/status.json");
  assert.match(calls[1].url, /repos\/guillosan21\/streamcorner-tv-feed\/actions\/workflows\/update-feed\.yml\/runs/);
  assert.match(calls[2].url, /repos\/guillosan21\/streamcorner-tv-feed\/actions\/workflows\/update-feed\.yml\/dispatches/);
  assert.deepEqual(JSON.parse(calls[2].init.body), { ref: "main" });
});

test("GitHub API rate limiting suppresses dispatch", async () => {
  const { fetchImpl, calls } = stubFetch([staleStatus(), response({}, 429)]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.equal(result.reason, "github-rate-limited");
  assert.equal(calls.length, 2);
});

test("invalid public status does not dispatch", async () => {
  const { fetchImpl, calls } = stubFetch([response({ updatedAt: "not-a-date" })]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.equal(result.reason, "status-updated-at-invalid");
  assert.equal(calls.length, 1);
});

test("non-successful dispatch is reported as a failure", async () => {
  const { fetchImpl, calls } = stubFetch([staleStatus(), response({ workflow_runs: [] }), response({}, 500)]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.deepEqual(result, { action: "failed", reason: "github-api-failed", status: 500 });
  assert.equal(calls.length, 3);
});
