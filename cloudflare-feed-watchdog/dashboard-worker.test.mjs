import assert from "node:assert/strict";
import test from "node:test";
import worker from "./dashboard-worker.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const env = { GITHUB_TOKEN: "test-token" };

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

function assertSafeDiagnostic(result, expectedKeys = ["action", "reason", "stage"]) {
  assert.deepEqual(Object.keys(result).sort(), [...expectedKeys].sort());
  assert.equal(typeof result.stage, "string");
  assert.equal(typeof result.action, "string");
  assert.equal(typeof result.reason, "string");
  assert.doesNotMatch(JSON.stringify(result), /test-token|https?:\/\/|sensitive-response-body|raw-error-detail/i);
}

async function scheduled(responses, workerEnv = env) {
  const oldFetch = globalThis.fetch;
  const oldNow = Date.now;
  const oldLog = console.log;
  const calls = [];
  const diagnostics = [];
  let pending;
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const result = responses.shift();
    if (result instanceof Error) throw result;
    return result;
  };
  Date.now = () => NOW;
  console.log = (line) => diagnostics.push(JSON.parse(line));
  try {
    worker.scheduled({}, workerEnv, { waitUntil(promise) { pending = promise; } });
    await pending;
  } finally {
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
    console.log = oldLog;
  }
  calls.diagnostics = diagnostics;
  return calls;
}

test("requires the GitHub secret and skips a fresh feed", async () => {
  const missingSecret = await scheduled([], {});
  assert.equal(missingSecret.length, 0);
  assert.deepEqual(missingSecret.diagnostics, [{
    stage: "configuration",
    action: "skipped",
    reason: "missing-configuration",
  }]);
  const calls = await scheduled([response({ updatedAt: new Date(NOW - 3 * 60_000).toISOString() })]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls.diagnostics, [{
    stage: "freshness-check",
    action: "skipped",
    reason: "feed-fresh",
  }]);
  assertSafeDiagnostic(calls.diagnostics[0]);
});

test("stale feed dispatches main when no active or recent run exists", async () => {
  const calls = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({ workflow_runs: [] }),
    response(null, 204),
  ]);
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /per_page=20/);
  assert.equal(calls[1].init.headers.authorization, undefined);
  assert.equal(calls[1].init.headers["user-agent"], "streamcorner-feed-watchdog");
  assert.equal(calls[2].init.method, "POST");
  assert.equal(calls[2].init.headers.authorization, "Bearer test-token");
  assert.equal(calls[2].init.headers["user-agent"], "streamcorner-feed-watchdog");
  assert.deepEqual(JSON.parse(calls[2].init.body), { ref: "main" });
  assert.deepEqual(calls.diagnostics, [{
    stage: "workflow-dispatch",
    action: "dispatched",
    reason: "feed-stale",
    httpStatus: 204,
  }]);
});

test("scans the recent page for active runs and cools down from completion", async () => {
  const stale = response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() });
  const overlapping = await scheduled([stale, response({ workflow_runs: [
    { status: "completed", updated_at: new Date(NOW - 12 * 60_000).toISOString() },
    { status: "in_progress", updated_at: new Date(NOW - 20 * 60_000).toISOString() },
  ] })]);
  assert.equal(overlapping.length, 2);
  assert.equal(overlapping[1].init.headers.authorization, undefined);
  assert.equal(overlapping[1].init.headers["user-agent"], "streamcorner-feed-watchdog");

  const longRun = await scheduled([stale, response({ workflow_runs: [{
    status: "completed",
    created_at: new Date(NOW - 45 * 60_000).toISOString(),
    updated_at: new Date(NOW - 2 * 60_000).toISOString(),
  }] })]);
  assert.equal(longRun.length, 2);
  assert.equal(longRun[1].init.headers.authorization, undefined);
});

test("dashboard copy honors freshness and cooldown environment overrides", async () => {
  const widerFreshWindow = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
  ], { ...env, STALE_AFTER_MINUTES: "20" });
  assert.deepEqual(widerFreshWindow.diagnostics[0], {
    stage: "freshness-check",
    action: "skipped",
    reason: "feed-fresh",
  });
  assert.equal(widerFreshWindow.length, 1);

  const shorterFreshWindow = await scheduled([
    response({ updatedAt: new Date(NOW - 7 * 60_000).toISOString() }),
    response({ workflow_runs: [] }),
    response(null, 204),
  ], { ...env, STALE_AFTER_MINUTES: "5" });
  assert.equal(shorterFreshWindow.diagnostics[0].action, "dispatched");
  assert.equal(shorterFreshWindow.length, 3);

  const widerCooldown = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({ workflow_runs: [{
      status: "completed",
      updated_at: new Date(NOW - 8 * 60_000).toISOString(),
    }] }),
  ], { ...env, DISPATCH_COOLDOWN_MINUTES: "10" });
  assert.deepEqual(widerCooldown.diagnostics[0], {
    stage: "github-runs",
    action: "skipped",
    reason: "workflow-run-too-recent",
  });
});

test("feed and API errors fail closed", async () => {
  const networkFailure = await scheduled([new Error("offline")]);
  assert.equal(networkFailure.length, 1);
  assert.deepEqual(networkFailure.diagnostics[0], {
    stage: "feed-status",
    action: "skipped",
    reason: "status-fetch-failed",
  });
  assert.equal((await scheduled([response({ updatedAt: "bad" })])).length, 1);
  const runsFailure = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({}, 403, { "x-ratelimit-remaining": "0" }),
  ]);
  assert.equal(runsFailure.length, 2);
  assert.deepEqual(runsFailure.diagnostics[0], {
    stage: "github-runs",
    action: "skipped",
    reason: "github-rate-limited",
    httpStatus: 403,
    rateLimitRemaining: 0,
    hasGitHubRequestId: false,
    contentTypeJson: false,
    githubErrorCategory: "non-github/unknown",
  });
});

test("public workflow-runs GET is unauthenticated and a secondary-limit-shaped 403 fails closed", async () => {
  const calls = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({}, 403, { "x-ratelimit-remaining": "42", "x-ratelimit-reset": "1800000000" }),
  ]);

  assert.deepEqual(calls.diagnostics[0], {
    stage: "github-runs",
    action: "skipped",
    reason: "github-api-failed",
    httpStatus: 403,
    rateLimitRemaining: 42,
    rateLimitReset: 1_800_000_000,
    hasGitHubRequestId: false,
    contentTypeJson: false,
    githubErrorCategory: "non-github/unknown",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.authorization, undefined);

  const customRepo = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({}, 403, { "x-ratelimit-remaining": "42" }),
  ], { ...env, GITHUB_OWNER: "other-owner", GITHUB_REPO: "other-feed" });
  assert.equal(customRepo.length, 2);
  assert.equal(customRepo.diagnostics[0].reason, "github-api-failed");
  assert.equal(customRepo[1].init.headers.authorization, "Bearer test-token");
  assert.equal(customRepo[1].init.headers["user-agent"], "streamcorner-feed-watchdog");
});

test("rate-limited public GET fails closed without a retry", async () => {
  const rate = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({}, 429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000", "retry-after": "120" }),
  ]);
  assert.deepEqual(rate.diagnostics[0], {
    stage: "github-runs",
    action: "skipped",
    reason: "github-rate-limited",
    httpStatus: 429,
    rateLimitRemaining: 0,
    rateLimitReset: 1_800_000_000,
    retryAfterSeconds: 120,
    hasGitHubRequestId: false,
    contentTypeJson: false,
    githubErrorCategory: "non-github/unknown",
  });
  assert.equal(rate.length, 2);
});

test("public workflow-runs GET failure does not retry or dispatch", async () => {
  const calls = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({ token: "sensitive-response-body" }, 500, { "x-ratelimit-remaining": "12" }),
  ]);

  assert.deepEqual(calls.diagnostics[0], {
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
  assertSafeDiagnostic(calls.diagnostics[0], ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "rateLimitRemaining", "reason", "stage"]);
});

test("HTML 403 without a GitHub request ID is safely classified", async () => {
  const calls = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response("<html>private proxy body https://private.example/path</html>", 403, {
      "content-type": "text/html; charset=utf-8",
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "50",
      "x-ratelimit-resource": "core",
    }),
  ]);

  assert.deepEqual(calls.diagnostics[0], {
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
  assertSafeDiagnostic(calls.diagnostics[0], ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "rateLimitLimit", "rateLimitRemaining", "rateLimitResource", "reason", "stage"]);
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
    const calls = await scheduled([
      response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
      response({ message, private: "https://private.example/body" }, 403, {
        "content-type": "application/vnd.github+json; charset=utf-8",
        "x-github-request-id": "private-request-id",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "27",
        "x-ratelimit-resource": "search",
      }),
    ]);
    const result = calls.diagnostics[0];

    assert.equal(result.githubErrorCategory, category);
    assert.equal(result.contentTypeJson, true);
    assert.equal(result.hasGitHubRequestId, true);
    assert.equal(result.rateLimitLimit, 5_000);
    assert.equal(result.rateLimitResource, "search");
    assertSafeDiagnostic(result, ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "rateLimitLimit", "rateLimitRemaining", "rateLimitResource", "reason", "stage"]);
    assert.equal(calls.length, 2);
  }
});

test("proxy JSON messages without a GitHub request ID stay unclassified", async () => {
  const calls = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({ message: "Bad credentials", private: "sensitive-response-body" }, 403, {
      "content-type": "application/json",
    }),
  ]);
  const result = calls.diagnostics[0];

  assert.equal(result.githubErrorCategory, "non-github/unknown");
  assert.equal(result.hasGitHubRequestId, false);
  assert.equal(result.contentTypeJson, true);
  assertSafeDiagnostic(result, ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "reason", "stage"]);
});

test("malformed and oversized GitHub error bodies never enter diagnostics", async () => {
  const malformed = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response("{malformed private body", 403, {
      "content-type": "application/json",
      "x-github-request-id": "private-request-id",
    }),
  ]);
  assert.equal(malformed.diagnostics[0].githubErrorCategory, "other-github");
  assert.equal(malformed.diagnostics[0].contentTypeJson, true);
  assertSafeDiagnostic(malformed.diagnostics[0], ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "reason", "stage"]);

  const oversizedText = JSON.stringify({ message: "Bad credentials", private: "x".repeat(3_000) });
  const oversized = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response(oversizedText, 403, {
      "content-type": "application/json",
      "content-length": "4096",
    }),
  ]);
  assert.equal(oversized.diagnostics[0].githubErrorCategory, "non-github/unknown");
  assert.equal(oversized.diagnostics[0].contentTypeJson, true);
  assert.equal(oversized.diagnostics[0].hasGitHubRequestId, false);
  assertSafeDiagnostic(oversized.diagnostics[0], ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "reason", "stage"]);

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
  const streamed = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    streamedResponse,
  ]);
  assert.equal(streamed.diagnostics[0].githubErrorCategory, "non-github/unknown");
  assert.equal(streamed.diagnostics[0].contentTypeJson, true);
  assertSafeDiagnostic(streamed.diagnostics[0], ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "reason", "stage"]);
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
  const calls = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    oversizedResponse,
  ]);
  const result = calls.diagnostics[0];

  assert.equal(result.githubErrorCategory, "other-github");
  assert.equal(cancellationCalled, true);
  assert.equal(cancellationAwaited, false);
  assert.equal(subarrayCalled, false);
  assertSafeDiagnostic(result, ["action", "contentTypeJson", "githubErrorCategory", "hasGitHubRequestId", "httpStatus", "reason", "stage"]);
});

test("workflow dispatch 403 stays authenticated and logs only allowlisted rate fields", async () => {
  const calls = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({ workflow_runs: [] }),
    response({ token: "sensitive-response-body" }, 403, {
      "x-ratelimit-remaining": "19",
      "x-ratelimit-reset": "1800000000",
      "retry-after": "Wed, 21 Oct 2030 07:28:00 GMT",
    }),
  ]);

  assert.deepEqual(calls.diagnostics[0], {
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
  assertSafeDiagnostic(calls.diagnostics[0], ["action", "contentTypeJson", "hasGitHubRequestId", "httpStatus", "rateLimitRemaining", "rateLimitReset", "reason", "stage"]);
});

test("status and runs HTTP failures report their stage and status", async () => {
  const statusFailure = await scheduled([response({}, 502)]);
  assert.deepEqual(statusFailure.diagnostics[0], {
    stage: "feed-status",
    action: "skipped",
    reason: "status-http-failed",
    httpStatus: 502,
  });

  const runsFailure = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({}, 429),
  ]);
  assert.deepEqual(runsFailure.diagnostics[0], {
    stage: "github-runs",
    action: "skipped",
    reason: "github-rate-limited",
    httpStatus: 429,
    hasGitHubRequestId: false,
    contentTypeJson: false,
    githubErrorCategory: "non-github/unknown",
  });
});

test("dispatch HTTP and thrown failures are distinct and redacted", async () => {
  const httpFailure = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({ workflow_runs: [] }),
    response({ secret: "sensitive-response-body", token: "test-token" }, 500),
  ]);
  assert.deepEqual(httpFailure.diagnostics[0], {
    stage: "workflow-dispatch",
    action: "failed",
    reason: "workflow-dispatch-http-failed",
    httpStatus: 500,
    hasGitHubRequestId: false,
    contentTypeJson: false,
  });

  const thrownFailure = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({ workflow_runs: [] }),
    new Error("Bearer test-token https://private.example/path sensitive-response-body raw-error-detail"),
  ]);
  assert.deepEqual(thrownFailure.diagnostics[0], {
    stage: "workflow-dispatch",
    action: "failed",
    reason: "workflow-dispatch-fetch-failed",
  });
  assertSafeDiagnostic(thrownFailure.diagnostics[0]);
});

test("dashboard copy rejects non-string timestamps and diagnoses URL construction errors", async () => {
  const invalidStatus = await scheduled([response({ updatedAt: 0 })]);
  assert.deepEqual(invalidStatus.diagnostics[0], {
    stage: "feed-status",
    action: "skipped",
    reason: "status-updated-at-invalid",
  });
  assert.equal(invalidStatus.length, 1);

  const invalidRun = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
    response({ workflow_runs: [{ status: "completed", updated_at: 0 }] }),
  ]);
  assert.deepEqual(invalidRun.diagnostics[0], {
    stage: "github-runs",
    action: "skipped",
    reason: "latest-run-updated-at-invalid",
  });
  assert.equal(invalidRun.length, 2);

  const invalidUrl = await scheduled([
    response({ updatedAt: new Date(NOW - 11 * 60_000).toISOString() }),
  ], { ...env, GITHUB_OWNER: Symbol("invalid-owner") });
  assert.deepEqual(invalidUrl.diagnostics[0], {
    stage: "github-runs",
    action: "skipped",
    reason: "github-runs-fetch-failed",
  });
  assert.equal(invalidUrl.length, 1);
  assertSafeDiagnostic(invalidUrl.diagnostics[0]);
});
