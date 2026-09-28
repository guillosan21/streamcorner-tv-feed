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

function response(body, status = 200, headerValues = {}) {
  const bodyBytes = body === null ? null : new TextEncoder().encode(
    typeof body === "string" ? body : JSON.stringify(body),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = Object.keys(headerValues).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
        return key === undefined ? null : String(headerValues[key]);
      },
    },
    body: bodyBytes === null ? null : {
      getReader() {
        let read = false;
        return {
          async read() {
            if (read) return { done: true };
            read = true;
            return { done: false, value: bodyBytes };
          },
          async cancel() { read = true; },
          releaseLock() {},
        };
      },
    },
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

function assertSafeDiagnostic(result, expectedKeys = ["action", "reason", "stage"]) {
  assert.deepEqual(Object.keys(result).sort(), [...expectedKeys].sort());
  assert.equal(typeof result.stage, "string");
  assert.equal(typeof result.action, "string");
  assert.equal(typeof result.reason, "string");
  assert.doesNotMatch(JSON.stringify(result), /test-token|https?:\/\/|sensitive-response-body|raw-error-detail/i);
}

test("fresh feed does not request workflow runs or dispatch", async () => {
  const { fetchImpl, calls } = stubFetch([
    response({ updatedAt: new Date(NOW - 3 * 60_000).toISOString() }),
  ]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.equal(result.reason, "feed-fresh");
  assert.equal(calls.length, 1);
});

test("configured freshness and cooldown thresholds are honored", async () => {
  const widerFreshWindow = await runWatchdog({ ...ENV, STALE_AFTER_MINUTES: "20" }, {
    fetchImpl: stubFetch([response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() })]).fetchImpl,
    now: () => NOW,
  });
  assert.deepEqual(widerFreshWindow, {
    stage: "freshness-check",
    action: "skipped",
    reason: "feed-fresh",
  });

  const shorterFreshWindow = await runWatchdog({ ...ENV, STALE_AFTER_MINUTES: "5" }, {
    fetchImpl: stubFetch([
      response({ updatedAt: new Date(NOW - 7 * 60_000).toISOString() }),
      response({ workflow_runs: [] }),
      response(null, 204),
    ]).fetchImpl,
    now: () => NOW,
  });
  assert.equal(shorterFreshWindow.action, "dispatched");

  const widerCooldown = await runWatchdog({ ...ENV, DISPATCH_COOLDOWN_MINUTES: "10" }, {
    fetchImpl: stubFetch([
      staleStatus(),
      response({ workflow_runs: [{
        status: "completed",
        updated_at: new Date(NOW - 8 * 60_000).toISOString(),
      }] }),
    ]).fetchImpl,
    now: () => NOW,
  });
  assert.deepEqual(widerCooldown, {
    stage: "github-runs",
    action: "skipped",
    reason: "workflow-run-too-recent",
  });
});

test("timestamp parsing rejects non-string dates and URL construction errors are diagnostic", async () => {
  const invalidStatus = await runWatchdog(ENV, {
    fetchImpl: stubFetch([response({ updatedAt: 0 })]).fetchImpl,
    now: () => NOW,
  });
  assert.equal(invalidStatus.reason, "status-updated-at-invalid");

  const invalidRun = await runWatchdog(ENV, {
    fetchImpl: stubFetch([
      staleStatus(),
      response({ workflow_runs: [{ status: "completed", updated_at: 0 }] }),
    ]).fetchImpl,
    now: () => NOW,
  });
  assert.equal(invalidRun.reason, "latest-run-updated-at-invalid");

  const fetch = stubFetch([staleStatus()]);
  const invalidUrlConfig = await runWatchdog({ ...ENV, GITHUB_OWNER: Symbol("invalid-owner") }, {
    fetchImpl: fetch.fetchImpl,
    now: () => NOW,
  });
  assert.deepEqual(invalidUrlConfig, {
    stage: "github-runs",
    action: "skipped",
    reason: "github-runs-fetch-failed",
  });
  assert.equal(fetch.calls.length, 1);
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

  assert.deepEqual(result, {
    stage: "workflow-dispatch",
    action: "dispatched",
    reason: "feed-stale",
    httpStatus: 204,
  });
  assert.equal(result.action, "dispatched");
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /per_page=20/);
  assert.equal(calls[1].init.headers["user-agent"], "streamcorner-feed-watchdog");
  assert.equal(calls[2].init.method, "POST");
  assert.equal(calls[2].init.headers["user-agent"], "streamcorner-feed-watchdog");
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
  assert.equal(calls[1].init.headers.authorization, undefined);
  assert.equal(calls[1].init.headers["user-agent"], "streamcorner-feed-watchdog");
  assert.equal(calls[0].url, "https://guillosan21.github.io/streamcorner-tv-feed/status.json");
  assert.match(calls[1].url, /repos\/guillosan21\/streamcorner-tv-feed\/actions\/workflows\/update-feed\.yml\/runs/);
  assert.match(calls[2].url, /repos\/guillosan21\/streamcorner-tv-feed\/actions\/workflows\/update-feed\.yml\/dispatches/);
  assert.deepEqual(JSON.parse(calls[2].init.body), { ref: "main" });
  assert.equal(calls[2].init.headers.authorization, "Bearer test-token");
  assert.equal(calls[2].init.headers["user-agent"], "streamcorner-feed-watchdog");
});

test("public runs GET remains unauthenticated while active and cooldown checks still apply", async () => {
  const active = stubFetch([
    staleStatus(),
    response({ workflow_runs: [{ status: "in_progress" }] }),
  ]);
  const activeResult = await runWatchdog({ GITHUB_TOKEN: "test-token" }, {
    fetchImpl: active.fetchImpl,
    now: () => NOW,
  });
  assert.equal(activeResult.reason, "workflow-run-active");
  assert.equal(active.calls.length, 2);
  assert.equal(active.calls[1].init.headers.authorization, undefined);

  const coolingDown = stubFetch([
    staleStatus(),
    response({ workflow_runs: [{
      status: "completed",
      updated_at: new Date(NOW - 2 * 60_000).toISOString(),
    }] }),
  ]);
  const cooldownResult = await runWatchdog({ GITHUB_TOKEN: "test-token" }, {
    fetchImpl: coolingDown.fetchImpl,
    now: () => NOW,
  });
  assert.equal(cooldownResult.reason, "workflow-run-too-recent");
  assert.equal(coolingDown.calls.length, 2);
  assert.equal(coolingDown.calls[1].init.headers.authorization, undefined);
});

test("GitHub API rate limiting suppresses dispatch", async () => {
  const { fetchImpl, calls } = stubFetch([
    staleStatus(),
    response({}, 429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" }),
  ]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.equal(result.reason, "github-rate-limited");
  assert.equal(result.stage, "github-runs");
  assert.equal(result.httpStatus, 429);
  assert.equal(result.rateLimitRemaining, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.authorization, "Bearer test-token");
  assert.equal(calls[1].init.headers["user-agent"], "streamcorner-feed-watchdog");
});

test("custom repositories keep the authenticated runs GET", async () => {
  const { fetchImpl, calls } = stubFetch([
    staleStatus(),
    response({}, 403, { "x-ratelimit-remaining": "25" }),
  ]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.equal(result.reason, "github-api-failed");
  assert.equal(result.httpStatus, 403);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.authorization, "Bearer test-token");
});

test("secondary-limit-shaped public 403 with remaining quota fails closed", async () => {
  const { fetchImpl, calls } = stubFetch([
    staleStatus(),
    response({}, 403, { "x-ratelimit-remaining": "25", "x-ratelimit-reset": "1800000000" }),
  ]);

  const result = await runWatchdog({ GITHUB_TOKEN: "test-token" }, { fetchImpl, now: () => NOW });

  assert.deepEqual(result, {
    stage: "github-runs",
    action: "skipped",
    reason: "github-api-failed",
    httpStatus: 403,
    rateLimitRemaining: 25,
    rateLimitReset: 1_800_000_000,
    hasGitHubRequestId: false,
    contentTypeJson: false,
    githubErrorCategory: "non-github/unknown",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.authorization, undefined);
  assertSafeDiagnostic(result, ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "rateLimitRemaining", "rateLimitReset", "reason", "stage"]);
});

test("public runs GET HTTP failures do not retry or dispatch", async () => {
  const { fetchImpl, calls } = stubFetch([
    staleStatus(),
    response({ token: "sensitive-response-body" }, 500, { "x-ratelimit-remaining": "12" }),
  ]);

  const result = await runWatchdog({ GITHUB_TOKEN: "test-token" }, { fetchImpl, now: () => NOW });

  assert.deepEqual(result, {
    stage: "github-runs",
    action: "skipped",
    reason: "github-api-failed",
    httpStatus: 500,
    rateLimitRemaining: 12,
    hasGitHubRequestId: false,
    contentTypeJson: false,
    githubErrorCategory: "non-github/unknown",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.authorization, undefined);
  assertSafeDiagnostic(result, ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "rateLimitRemaining", "reason", "stage"]);
});

test("HTML GitHub-runs 403 without a GitHub request ID is safely classified", async () => {
  const { fetchImpl, calls } = stubFetch([
    staleStatus(),
    response("<html>secret proxy page https://private.example/path</html>", 403, {
      "content-type": "text/html; charset=utf-8",
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "50",
      "x-ratelimit-resource": "core",
    }),
  ]);

  const result = await runWatchdog({ GITHUB_TOKEN: "test-token" }, { fetchImpl, now: () => NOW });

  assert.deepEqual(result, {
    stage: "github-runs",
    action: "skipped",
    reason: "github-api-failed",
    httpStatus: 403,
    rateLimitLimit: 60,
    rateLimitRemaining: 50,
    rateLimitResource: "core",
    hasGitHubRequestId: false,
    contentTypeJson: false,
    githubErrorCategory: "non-github/unknown",
  });
  assert.equal(calls.length, 2);
  assertSafeDiagnostic(result, ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "rateLimitLimit", "rateLimitRemaining", "rateLimitResource", "reason", "stage"]);
});

test("bounded JSON message parsing maps only fixed GitHub error categories", async () => {
  const examples = [
    ["API rate limit exceeded for 192.0.2.4", "primary-rate-limit"],
    ["You have exceeded a secondary rate limit. Please wait.", "secondary-rate-limit"],
    ["Bad credentials", "bad-credentials"],
    ["Resource not accessible by personal access token", "insufficient-permission"],
    ["Resource not accessible by integration", "insufficient-permission"],
    ["User-Agent header is required", "user-agent-required"],
    ["User-Agent header is invalid", "user-agent-required"],
    ["Unexpected GitHub error payload", "other-github"],
  ];

  for (const [message, category] of examples) {
    const headers = {
      "content-type": "application/vnd.github+json; charset=utf-8",
      "x-github-request-id": "private-request-id",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "27",
      "x-ratelimit-resource": "search",
    };
    const { fetchImpl } = stubFetch([
      staleStatus(),
      response({ message, private: "https://private.example/body" }, 403, headers),
    ]);
    const result = await runWatchdog({ GITHUB_TOKEN: "test-token" }, { fetchImpl, now: () => NOW });

    assert.equal(result.githubErrorCategory, category);
    assert.equal(result.contentTypeJson, true);
    assert.equal(result.hasGitHubRequestId, true);
    assert.equal(result.rateLimitLimit, 5_000);
    assert.equal(result.rateLimitResource, "search");
    assertSafeDiagnostic(result, ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "rateLimitLimit", "rateLimitRemaining", "rateLimitResource", "reason", "stage"]);
  }
});

test("proxy JSON messages without a GitHub request ID stay unclassified", async () => {
  const result = await runWatchdog({ GITHUB_TOKEN: "test-token" }, {
    fetchImpl: stubFetch([
      staleStatus(),
      response({ message: "Bad credentials", private: "sensitive-response-body" }, 403, {
        "content-type": "application/json",
      }),
    ]).fetchImpl,
    now: () => NOW,
  });

  assert.equal(result.githubErrorCategory, "non-github/unknown");
  assert.equal(result.hasGitHubRequestId, false);
  assert.equal(result.contentTypeJson, true);
  assertSafeDiagnostic(result, ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "reason", "stage"]);
});

test("malformed and oversized error bodies never enter diagnostics", async () => {
  const malformed = await runWatchdog({ GITHUB_TOKEN: "test-token" }, {
    fetchImpl: stubFetch([
      staleStatus(),
      response("{malformed private body", 403, {
        "content-type": "application/json",
        "x-github-request-id": "private-request-id",
      }),
    ]).fetchImpl,
    now: () => NOW,
  });
  assert.equal(malformed.githubErrorCategory, "other-github");
  assert.equal(malformed.contentTypeJson, true);
  assertSafeDiagnostic(malformed, ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "reason", "stage"]);

  const oversizedText = JSON.stringify({ message: "Bad credentials", private: "x".repeat(3_000) });
  const oversized = await runWatchdog({ GITHUB_TOKEN: "test-token" }, {
    fetchImpl: stubFetch([
      staleStatus(),
      response(oversizedText, 403, {
        "content-type": "application/json",
        "content-length": "4096",
      }),
    ]).fetchImpl,
    now: () => NOW,
  });
  assert.equal(oversized.githubErrorCategory, "non-github/unknown");
  assert.equal(oversized.contentTypeJson, true);
  assert.equal(oversized.hasGitHubRequestId, false);
  assertSafeDiagnostic(oversized, ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "reason", "stage"]);

  const streamedText = JSON.stringify({ message: "Bad credentials", private: "https://secret.example/" + "x".repeat(3_000) });
  const streamedBytes = new TextEncoder().encode(streamedText);
  const streamedResponse = response(streamedText, 403, { "content-type": "application/json" });
  streamedResponse.body.getReader = () => {
    let offset = 0;
    return {
      async read() {
        if (offset >= streamedBytes.length) return { done: true };
        const end = Math.min(offset + 1_024, streamedBytes.length);
        const value = streamedBytes.subarray(offset, end);
        offset = end;
        return { done: false, value };
      },
      async cancel() { offset = streamedBytes.length; },
      releaseLock() {},
    };
  };
  const streamed = await runWatchdog({ GITHUB_TOKEN: "test-token" }, {
    fetchImpl: stubFetch([staleStatus(), streamedResponse]).fetchImpl,
    now: () => NOW,
  });
  assert.equal(streamed.githubErrorCategory, "non-github/unknown");
  assert.equal(streamed.contentTypeJson, true);
  assertSafeDiagnostic(streamed, ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "reason", "stage"]);
});

test("oversized single chunk is not retained through a subarray or awaited cancellation", async () => {
  const oversizedBytes = new TextEncoder().encode(JSON.stringify({
    message: "Bad credentials",
    private: "x".repeat(4_000),
  }));
  let subarrayCalled = false;
  oversizedBytes.subarray = (...args) => {
    subarrayCalled = true;
    return Uint8Array.prototype.subarray.apply(oversizedBytes, args);
  };
  let read = false;
  let cancellationCalled = false;
  let cancellationAwaited = false;
  const oversizedResponse = response(null, 403, {
    "content-type": "application/json",
    "x-github-request-id": "private-request-id",
  });
  oversizedResponse.body = {
    getReader() {
      return {
        async read() {
          if (read) return { done: true };
          read = true;
          return { done: false, value: oversizedBytes };
        },
        cancel() {
          cancellationCalled = true;
          return {
            then(resolve) {
              cancellationAwaited = true;
              resolve();
            },
            catch() {},
          };
        },
        releaseLock() {},
      };
    },
  };
  const result = await runWatchdog({ GITHUB_TOKEN: "test-token" }, {
    fetchImpl: stubFetch([staleStatus(), oversizedResponse]).fetchImpl,
    now: () => NOW,
  });

  assert.equal(result.githubErrorCategory, "other-github");
  assert.equal(cancellationCalled, true);
  assert.equal(cancellationAwaited, false);
  assert.equal(subarrayCalled, false);
  assertSafeDiagnostic(result, ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "reason", "stage"]);
});

test("workflow dispatch 403 remains authenticated and logs only allowlisted rate fields", async () => {
  const { fetchImpl, calls } = stubFetch([
    staleStatus(),
    response({ workflow_runs: [] }),
    response({ token: "sensitive-response-body" }, 403, {
      "x-ratelimit-remaining": "19",
      "x-ratelimit-reset": "1800000000",
      "retry-after": "Wed, 21 Oct 2030 07:28:00 GMT",
    }),
  ]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.deepEqual(result, {
    stage: "workflow-dispatch",
    action: "failed",
    reason: "workflow-dispatch-http-failed",
    httpStatus: 403,
    rateLimitRemaining: 19,
    rateLimitReset: 1_800_000_000,
    hasGitHubRequestId: false,
    contentTypeJson: false,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].init.headers.authorization, "Bearer test-token");
  assert.equal(calls[2].init.headers["user-agent"], "streamcorner-feed-watchdog");
  assertSafeDiagnostic(result, ["action", "contentTypeJson", "hasGitHubRequestId", "httpStatus", "rateLimitRemaining", "rateLimitReset", "reason", "stage"]);
});

test("status and runs HTTP failures include only a safe stage and status", async () => {
  const statusFailure = await runWatchdog(ENV, {
    fetchImpl: stubFetch([response({}, 503)]).fetchImpl,
    now: () => NOW,
  });
  assert.deepEqual(statusFailure, {
    stage: "feed-status",
    action: "skipped",
    reason: "status-http-failed",
    httpStatus: 503,
  });

  const runsFailure = await runWatchdog(ENV, {
    fetchImpl: stubFetch([staleStatus(), response({}, 429)]).fetchImpl,
    now: () => NOW,
  });
  assert.deepEqual(runsFailure, {
    stage: "github-runs",
    action: "skipped",
    reason: "github-rate-limited",
    httpStatus: 429,
    hasGitHubRequestId: false,
    contentTypeJson: false,
    githubErrorCategory: "non-github/unknown",
  });
});

test("thrown dispatch errors are distinct and redacted", async () => {
  const privateDetails = new Error("Bearer test-token https://private.example/path sensitive-response-body raw-error-detail");
  const { fetchImpl } = stubFetch([staleStatus(), response({ workflow_runs: [] }), privateDetails]);

  const result = await runWatchdog(ENV, { fetchImpl, now: () => NOW });

  assert.deepEqual(result, {
    stage: "workflow-dispatch",
    action: "failed",
    reason: "workflow-dispatch-fetch-failed",
  });
  assertSafeDiagnostic(result);
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

  assert.deepEqual(result, {
    stage: "workflow-dispatch",
    action: "failed",
    reason: "workflow-dispatch-http-failed",
    httpStatus: 500,
    hasGitHubRequestId: false,
    contentTypeJson: false,
  });
  assert.equal(calls.length, 3);
});
