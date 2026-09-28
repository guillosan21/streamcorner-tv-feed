const DEFAULT_STALE_AFTER_MINUTES = 10;
const DEFAULT_DISPATCH_COOLDOWN_MINUTES = 5;
const MAX_CLOCK_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const RECENT_RUNS_PAGE_SIZE = 20;

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
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

function githubUrl(owner, repository, workflowFile, suffix = "") {
  const workflow = encodeURIComponent(workflowFile);
  return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/workflows/${workflow}${suffix}`;
}

function apiFailureReason(response) {
  if (response.status === 403 || response.status === 429) {
    return "github-rate-limited";
  }
  return "github-api-failed";
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
    return { action: "skipped", reason: "missing-configuration", missing: ["GITHUB_TOKEN"] };
  }

  let statusResponse;
  try {
    statusResponse = await fetchImpl(config.FEED_STATUS_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return { action: "skipped", reason: "status-fetch-failed" };
  }

  if (!statusResponse.ok) {
    return { action: "skipped", reason: "status-http-failed", status: statusResponse.status };
  }

  let status;
  try {
    status = await statusResponse.json();
  } catch {
    return { action: "skipped", reason: "status-json-invalid" };
  }

  const updatedAt = parseUpdatedAt(status?.updatedAt);
  if (updatedAt === null) {
    return { action: "skipped", reason: "status-updated-at-invalid" };
  }

  const nowMs = now();
  const ageMs = nowMs - updatedAt;
  if (ageMs < -MAX_CLOCK_SKEW_MS) {
    return { action: "skipped", reason: "status-updated-at-in-future" };
  }

  const staleAfterMs = positiveMinutes(env.STALE_AFTER_MINUTES, DEFAULT_STALE_AFTER_MINUTES) * 60_000;
  if (ageMs <= staleAfterMs) {
    return { action: "skipped", reason: "feed-fresh", ageMs };
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
    runsResponse = await fetchImpl(runsUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: apiHeaders(env.GITHUB_TOKEN),
    });
  } catch {
    return { action: "skipped", reason: "github-runs-fetch-failed" };
  }

  if (!runsResponse.ok) {
    return { action: "skipped", reason: apiFailureReason(runsResponse), status: runsResponse.status };
  }

  let runsPayload;
  try {
    runsPayload = await runsResponse.json();
  } catch {
    return { action: "skipped", reason: "github-runs-json-invalid" };
  }

  if (!Array.isArray(runsPayload?.workflow_runs)) {
    return { action: "skipped", reason: "github-runs-response-invalid" };
  }

  const activeRun = runsPayload.workflow_runs.find((run) => {
    const status = typeof run?.status === "string" ? run.status.toLowerCase() : "";
    return ACTIVE_RUN_STATUSES.has(status);
  });
  if (activeRun) {
    return {
      action: "skipped",
      reason: "workflow-run-active",
      runStatus: activeRun.status.toLowerCase(),
    };
  }

  const latestRun = runsPayload.workflow_runs[0];
  if (latestRun) {
    const runStatus = typeof latestRun.status === "string" ? latestRun.status.toLowerCase() : "";
    if (runStatus !== "completed") {
      return { action: "skipped", reason: "latest-run-status-invalid" };
    }

    const runUpdatedAt = parseUpdatedAt(latestRun.updated_at);
    if (runUpdatedAt === null) {
      return { action: "skipped", reason: "latest-run-updated-at-invalid" };
    }

    const runAgeMs = nowMs - runUpdatedAt;
    if (runAgeMs < -MAX_CLOCK_SKEW_MS) {
      return { action: "skipped", reason: "latest-run-updated-at-in-future" };
    }

    const cooldownMs = positiveMinutes(env.DISPATCH_COOLDOWN_MINUTES, DEFAULT_DISPATCH_COOLDOWN_MINUTES) * 60_000;
    if (runAgeMs <= cooldownMs) {
      return { action: "skipped", reason: "workflow-run-too-recent", runAgeMs };
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
    return { action: "failed", reason: "workflow-dispatch-fetch-failed" };
  }

  if (!dispatchResponse.ok) {
    return { action: "failed", reason: apiFailureReason(dispatchResponse), status: dispatchResponse.status };
  }

  return { action: "dispatched", reason: "feed-stale", ageMs };
}

export default {
  scheduled(_controller, env, context) {
    context.waitUntil(runWatchdog(env).then((result) => {
      console.log(JSON.stringify(result));
    }));
  },
};
