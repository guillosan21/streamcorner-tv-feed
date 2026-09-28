const DEFAULT_STALE_AFTER_MINUTES = 10;
const DEFAULT_DISPATCH_COOLDOWN_MINUTES = 5;
const MAX_CLOCK_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const RECENT_RUNS_PAGE_SIZE = 20;
const MAX_RATE_LIMIT_REMAINING = 1_000_000;
const MAX_RATE_LIMIT_LIMIT = 1_000_000;
const MAX_RATE_LIMIT_RESET = 4_102_444_800;
const MAX_RETRY_AFTER_SECONDS = 86_400;
const MAX_GITHUB_ERROR_BODY_BYTES = 2_048;
const GITHUB_RATE_LIMIT_RESOURCES = new Set([
  "core",
  "search",
  "graphql",
  "integration_manifest",
  "code_scanning_upload",
  "actions_runner_registration",
  "scim",
  "source_import",
  "code_scanning_autofix",
  "dependency_snapshots",
]);
const GITHUB_ERROR_CATEGORIES = new Set([
  "primary-rate-limit",
  "secondary-rate-limit",
  "bad-credentials",
  "insufficient-permission",
  "user-agent-required",
  "other-github",
  "non-github/unknown",
]);

const DEFAULT_CONFIG = {
  FEED_STATUS_URL: "https://guillosan21.github.io/streamcorner-tv-feed/status.json",
  GITHUB_OWNER: "guillosan21",
  GITHUB_REPO: "streamcorner-tv-feed",
  GITHUB_WORKFLOW_FILE: "update-feed.yml",
  GITHUB_BRANCH: "main",
};

const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "pending",
  "requested",
]);

function positiveMinutes(value, fallback) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : fallback;
}

function parseUpdatedAt(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function apiHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "streamcorner-feed-watchdog",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

function publicApiHeaders() {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "streamcorner-feed-watchdog",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

function githubUrl(owner, repository, workflowFile, suffix = "") {
  const workflow = encodeURIComponent(workflowFile);
  return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/workflows/${workflow}${suffix}`;
}

function readHeader(response, name) {
  try {
    return response.headers?.get?.(name);
  } catch {
    return undefined;
  }
}

function boundedHeaderInteger(value, maximum) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= maximum ? number : undefined;
}

function rateLimitInfo(response) {
  const limitHeader = readHeader(response, "x-ratelimit-limit");
  const remainingHeader = readHeader(response, "x-ratelimit-remaining");
  const resetHeader = readHeader(response, "x-ratelimit-reset");
  const retryAfterHeader = readHeader(response, "retry-after");
  const resourceHeader = readHeader(response, "x-ratelimit-resource");
  const requestIdHeader = readHeader(response, "x-github-request-id");
  const contentTypeHeader = readHeader(response, "content-type");
  const rateLimitLimit = boundedHeaderInteger(limitHeader, MAX_RATE_LIMIT_LIMIT);
  const rateLimitRemaining = boundedHeaderInteger(remainingHeader, MAX_RATE_LIMIT_REMAINING);
  const rateLimitReset = boundedHeaderInteger(resetHeader, MAX_RATE_LIMIT_RESET);
  const retryAfterSeconds = boundedHeaderInteger(retryAfterHeader, MAX_RETRY_AFTER_SECONDS);
  const details = {};
  if (rateLimitLimit !== undefined) details.rateLimitLimit = rateLimitLimit;
  if (rateLimitRemaining !== undefined) details.rateLimitRemaining = rateLimitRemaining;
  if (rateLimitReset !== undefined) details.rateLimitReset = rateLimitReset;
  if (retryAfterSeconds !== undefined) details.retryAfterSeconds = retryAfterSeconds;
  const resource = typeof resourceHeader === "string" ? resourceHeader.toLowerCase() : "";
  if (GITHUB_RATE_LIMIT_RESOURCES.has(resource)) {
    details.rateLimitResource = resource;
  }
  details.hasGitHubRequestId = typeof requestIdHeader === "string" && requestIdHeader.trim() !== "";
  details.contentTypeJson = isJsonContentType(contentTypeHeader);

  const remainingIsUnknown = remainingHeader !== undefined
    && remainingHeader !== null
    && rateLimitRemaining === undefined;
  const hasRetryAfter = typeof retryAfterHeader === "string" && retryAfterHeader.trim() !== "";
  return {
    details,
    indicated: response.status === 429 || rateLimitRemaining === 0 || remainingIsUnknown || hasRetryAfter,
  };
}

function isJsonContentType(value) {
  if (typeof value !== "string") return false;
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType === "text/json" || mediaType.endsWith("+json");
}

function cancelWithoutWaiting(target, methodName) {
  try {
    const cancel = target?.[methodName];
    if (typeof cancel !== "function") return;
    const cancellation = cancel.call(target);
    cancellation?.catch?.(() => {});
  } catch {
    // Cancellation must not block or replace the bounded diagnostic path.
  }
}

async function readBoundedBody(response) {
  const declaredLength = boundedHeaderInteger(
    readHeader(response, "content-length"),
    Number.MAX_SAFE_INTEGER,
  );
  if (declaredLength !== undefined && declaredLength > MAX_GITHUB_ERROR_BODY_BYTES) {
    cancelWithoutWaiting(response.body, "cancel");
    return null;
  }

  let reader;
  try {
    reader = response.body?.getReader?.();
  } catch {
    return null;
  }
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  let exceededLimit = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        cancelWithoutWaiting(reader, "cancel");
        return null;
      }
      const available = MAX_GITHUB_ERROR_BODY_BYTES - total;
      if (part.value.byteLength > available) {
        exceededLimit = true;
        cancelWithoutWaiting(reader, "cancel");
        break;
      }
      chunks.push(part.value.slice());
      total += part.value.byteLength;
    }
  } catch {
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Some test streams do not implement releaseLock.
    }
  }

  if (exceededLimit) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function categoryForGitHubMessage(message) {
  const normalized = message.toLowerCase();
  if (normalized.includes("secondary rate limit") || normalized.includes("secondary rate-limit")) {
    return "secondary-rate-limit";
  }
  if (normalized.includes("api rate limit exceeded") || normalized.includes("rate limit exceeded")) {
    return "primary-rate-limit";
  }
  if (normalized.includes("bad credentials")) return "bad-credentials";
  if (
    normalized.includes("resource not accessible by personal access token")
    || normalized.includes("resource not accessible by integration")
    || normalized.includes("insufficient permission")
    || normalized.includes("must have admin rights")
  ) {
    return "insufficient-permission";
  }
  if (
    normalized.includes("user-agent")
    && (normalized.includes("required") || normalized.includes("missing") || normalized.includes("invalid"))
  ) {
    return "user-agent-required";
  }
  return null;
}

async function githubRunsErrorCategory(response, details) {
  if (!details.hasGitHubRequestId) return "non-github/unknown";

  let payload;
  if (details.contentTypeJson) {
    const body = await readBoundedBody(response);
    if (body !== null) {
      try {
        payload = JSON.parse(body);
      } catch {
        // Malformed JSON is classified from the presence of a GitHub request ID.
      }
    }
  }

  const knownCategory = typeof payload?.message === "string"
    ? categoryForGitHubMessage(payload.message)
    : null;
  if (knownCategory) return knownCategory;
  return "other-github";
}

function isRateLimitedResponse(response, info = rateLimitInfo(response)) {
  return response.status === 429
    || ((response.status === 401 || response.status === 403) && info.indicated);
}

function diagnostic(stage, action, reason, httpStatus, rateDetails) {
  const result = { stage, action, reason };
  if (Number.isInteger(httpStatus)) result.httpStatus = httpStatus;
  if (rateDetails) {
    for (const key of [
      "rateLimitLimit",
      "rateLimitRemaining",
      "rateLimitReset",
      "retryAfterSeconds",
      "rateLimitResource",
    ]) {
      if (Number.isInteger(rateDetails[key])) result[key] = rateDetails[key];
      if (key === "rateLimitResource" && typeof rateDetails[key] === "string"
        && GITHUB_RATE_LIMIT_RESOURCES.has(rateDetails[key])) result[key] = rateDetails[key];
    }
    if (typeof rateDetails.hasGitHubRequestId === "boolean") {
      result.hasGitHubRequestId = rateDetails.hasGitHubRequestId;
    }
    if (typeof rateDetails.contentTypeJson === "boolean") result.contentTypeJson = rateDetails.contentTypeJson;
    if (GITHUB_ERROR_CATEGORIES.has(rateDetails.githubErrorCategory)) {
      result.githubErrorCategory = rateDetails.githubErrorCategory;
    }
  }
  return result;
}

/**
 * Check the public feed and dispatch its workflow only when it is stale and no
 * recent or active run can refresh it. Dependencies are injectable for tests.
 */
export async function runWatchdog(env, {
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const config = Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, fallback]) => [
    key,
    env[key] || fallback,
  ]));
  if (!env.GITHUB_TOKEN) {
    return diagnostic("configuration", "skipped", "missing-configuration");
  }

  let statusResponse;
  try {
    statusResponse = await fetchImpl(config.FEED_STATUS_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return diagnostic("feed-status", "skipped", "status-fetch-failed");
  }

  if (!statusResponse.ok) {
    return diagnostic("feed-status", "skipped", "status-http-failed", statusResponse.status);
  }

  let status;
  try {
    status = await statusResponse.json();
  } catch {
    return diagnostic("feed-status", "skipped", "status-json-invalid");
  }

  const updatedAt = parseUpdatedAt(status?.updatedAt);
  if (updatedAt === null) {
    return diagnostic("feed-status", "skipped", "status-updated-at-invalid");
  }

  const nowMs = now();
  const ageMs = nowMs - updatedAt;
  if (ageMs < -MAX_CLOCK_SKEW_MS) {
    return diagnostic("feed-status", "skipped", "status-updated-at-in-future");
  }

  const staleAfterMs = positiveMinutes(env.STALE_AFTER_MINUTES, DEFAULT_STALE_AFTER_MINUTES) * 60_000;
  if (ageMs <= staleAfterMs) {
    return diagnostic("freshness-check", "skipped", "feed-fresh");
  }

  let runsResponse;
  try {
    const runsUrl = new URL(githubUrl(
      config.GITHUB_OWNER,
      config.GITHUB_REPO,
      config.GITHUB_WORKFLOW_FILE,
      "/runs",
    ));
    runsUrl.searchParams.set("branch", config.GITHUB_BRANCH);
    runsUrl.searchParams.set("per_page", String(RECENT_RUNS_PAGE_SIZE));
    const runsHeaders = config.GITHUB_OWNER === DEFAULT_CONFIG.GITHUB_OWNER
      && config.GITHUB_REPO === DEFAULT_CONFIG.GITHUB_REPO
      ? publicApiHeaders()
      : apiHeaders(env.GITHUB_TOKEN);
    runsResponse = await fetchImpl(runsUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: runsHeaders,
    });
  } catch {
    return diagnostic("github-runs", "skipped", "github-runs-fetch-failed");
  }

  if (!runsResponse.ok) {
    const runsRateInfo = rateLimitInfo(runsResponse);
    const githubErrorCategory = await githubRunsErrorCategory(runsResponse, runsRateInfo.details);
    const failureDetails = { ...runsRateInfo.details, githubErrorCategory };
    const rateLimitedByBody = githubErrorCategory === "primary-rate-limit"
      || githubErrorCategory === "secondary-rate-limit";
    return diagnostic(
      "github-runs",
      "skipped",
      isRateLimitedResponse(runsResponse, runsRateInfo) || rateLimitedByBody
        ? "github-rate-limited"
        : "github-api-failed",
      runsResponse.status,
      failureDetails,
    );
  }

  let runsPayload;
  try {
    runsPayload = await runsResponse.json();
  } catch {
    return diagnostic("github-runs", "skipped", "github-runs-json-invalid");
  }

  if (!Array.isArray(runsPayload?.workflow_runs)) {
    return diagnostic("github-runs", "skipped", "github-runs-response-invalid");
  }

  const activeRun = runsPayload.workflow_runs.find((run) => {
    const status = typeof run?.status === "string" ? run.status.toLowerCase() : "";
    return ACTIVE_RUN_STATUSES.has(status);
  });
  if (activeRun) {
    return diagnostic("github-runs", "skipped", "workflow-run-active");
  }

  const latestRun = runsPayload.workflow_runs[0];
  if (latestRun) {
    const runStatus = typeof latestRun.status === "string" ? latestRun.status.toLowerCase() : "";
    if (runStatus !== "completed") {
      return diagnostic("github-runs", "skipped", "latest-run-status-invalid");
    }

    const runUpdatedAt = parseUpdatedAt(latestRun.updated_at);
    if (runUpdatedAt === null) {
      return diagnostic("github-runs", "skipped", "latest-run-updated-at-invalid");
    }

    const runAgeMs = nowMs - runUpdatedAt;
    if (runAgeMs < -MAX_CLOCK_SKEW_MS) {
      return diagnostic("github-runs", "skipped", "latest-run-updated-at-in-future");
    }

    const cooldownMs = positiveMinutes(env.DISPATCH_COOLDOWN_MINUTES, DEFAULT_DISPATCH_COOLDOWN_MINUTES) * 60_000;
    if (runAgeMs <= cooldownMs) {
      return diagnostic("github-runs", "skipped", "workflow-run-too-recent");
    }
  }

  let dispatchResponse;
  try {
    dispatchResponse = await fetchImpl(githubUrl(
      config.GITHUB_OWNER,
      config.GITHUB_REPO,
      config.GITHUB_WORKFLOW_FILE,
      "/dispatches",
    ), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: "POST",
      headers: { ...apiHeaders(env.GITHUB_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({ ref: config.GITHUB_BRANCH }),
    });
  } catch {
    return diagnostic("workflow-dispatch", "failed", "workflow-dispatch-fetch-failed");
  }

  if (!dispatchResponse.ok) {
    return diagnostic(
      "workflow-dispatch",
      "failed",
      "workflow-dispatch-http-failed",
      dispatchResponse.status,
      rateLimitInfo(dispatchResponse).details,
    );
  }

  return diagnostic("workflow-dispatch", "dispatched", "feed-stale", dispatchResponse.status);
}

export default {
  scheduled(_controller, env, context) {
    context.waitUntil(runWatchdog(env).then((result) => {
      console.log(JSON.stringify(result));
    }));
  },
};
