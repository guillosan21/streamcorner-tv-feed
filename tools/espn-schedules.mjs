const ESPN_SITE_API = "https://site.web.api.espn.com/apis/site/v2/sports";
const MAX_SCOREBOARD_BYTES = 3 * 1024 * 1024;
const MAX_CONCURRENCY = 12;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_REQUESTS = 1_000;
const DEFAULT_REQUEST_INTERVAL_MS = 125;
const DEFAULT_BUDGET_MS = 150_000;
const MINIMUM_COVERAGE = 0.95;
const MINIMUM_LEAGUE_COVERAGE = 0.9;
const ESSENTIAL_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function compactDate(date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

/** Covers the prior four UTC days through the next 45 UTC days. */
export function espnScheduleDates(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new TypeError("A valid schedule date is required");
  const first = new Date(instant.getTime() - 4 * DAY_MS);
  const last = new Date(instant.getTime() + 45 * DAY_MS);
  const firstDay = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  const lastDay = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
  const dates = [];
  for (let day = firstDay; day <= lastDay; day += DAY_MS) dates.push(compactDate(new Date(day)));
  return dates;
}

/** Live-only leagues cover yesterday through the current UTC date. */
export function espnLiveScheduleDates(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new TypeError("A valid schedule date is required");
  const first = new Date(instant.getTime() - DAY_MS);
  const firstDay = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  const lastDay = Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
  const dates = [];
  for (let day = firstDay; day <= lastDay; day += DAY_MS) dates.push(compactDate(new Date(day)));
  return dates;
}

async function readBoundedJson(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SCOREBOARD_BYTES) {
    throw new Error(`ESPN scoreboard exceeds ${MAX_SCOREBOARD_BYTES} bytes`);
  }
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let body = "";
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_SCOREBOARD_BYTES) throw new Error(`ESPN scoreboard exceeds ${MAX_SCOREBOARD_BYTES} bytes`);
        body += decoder.decode(value, { stream: true });
      }
      return JSON.parse(body + decoder.decode());
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_SCOREBOARD_BYTES) {
    throw new Error(`ESPN scoreboard exceeds ${MAX_SCOREBOARD_BYTES} bytes`);
  }
  return JSON.parse(body);
}

function isRetryable(error) {
  return error?.status === 429 || [500, 502, 503, 504].includes(error?.status) ||
    error instanceof SyntaxError || ["TimeoutError", "AbortError"].includes(error?.name);
}

function isExplicitDelayedScheduleObservation(event) {
  const type = event?.status?.type || {};
  const state = String(type.state || "").toLowerCase();
  if (state !== "pre" && state !== "in") return false;
  const labels = [type.name, type.description, type.detail, type.shortDetail]
    .map((value) => String(value || "").trim()).filter(Boolean);
  if (labels.some((value) => /\b(?:postponed|rescheduled|cancelled|canceled|final)\b/i.test(value))) return false;
  if (labels.some((value) => /^(?:delayed|delay)\s+penalty\b/i.test(value))) return false;
  if (/^STATUS_(?:WEATHER_)?DELAYED$/i.test(String(type.name || "").trim())) return true;
  if (/^(?:weather\s+)?delay(?:ed)?[.!]?$/i.test(String(type.description || "").trim())) return true;
  return [type.detail, type.shortDetail].some((value) => {
    const text = String(value || "").trim();
    return /^(?:the\s+)?(?:game\s+)?(?:weather\s+)?delayed(?:\s+(?:until|to)\b|\s*[:—–-])/i.test(text) ||
      /^(?:weather\s+)?delay(?:ed)?[.!]?$/i.test(text);
  });
}

function stableEventKey(event) {
  const type = event?.status?.type || {};
  const competitors = (event?.competitions?.[0]?.competitors || []).map((team) => [
    String(team?.homeAway || ""), String(team?.team?.id || ""),
    String(team?.team?.displayName || team?.team?.name || ""), String(team?.score ?? ""),
  ]).sort((first, second) => first.join("\u0000").localeCompare(second.join("\u0000")));
  return JSON.stringify([
    String(event?.date || ""), String(type.state || ""), String(type.name || ""),
    String(type.description || ""), String(type.detail || ""), String(type.shortDetail || ""),
    competitors,
  ]);
}

function uniqueEvents(events) {
  const byId = new Map();
  for (const event of events) {
    const id = String(event?.id || "").trim();
    if (!id) continue;
    const old = byId.get(id);
    const stateRank = (value) => ({ post: 3, in: 2, pre: 1 }[String(value || "").toLowerCase()] || 0);
    const completeness = (value) => (value?.competitions?.[0]?.competitors || []).reduce(
      (sum, team) => sum + (String(team?.score ?? "").trim() ? 1 : 0), 0,
    );
    const incomingStateRank = stateRank(event?.status?.type?.state);
    const oldStateRank = stateRank(old?.status?.type?.state);
    const incomingDelayed = isExplicitDelayedScheduleObservation(event);
    const oldDelayed = isExplicitDelayedScheduleObservation(old);
    const incomingWins = !old || incomingStateRank > oldStateRank ||
      (incomingStateRank === oldStateRank && (
        (incomingDelayed !== oldDelayed && !incomingDelayed) ||
        (incomingDelayed === oldDelayed && completeness(event) > completeness(old)) ||
        (incomingDelayed === oldDelayed && completeness(event) === completeness(old) &&
          stableEventKey(event).localeCompare(stableEventKey(old)) < 0)
      ));
    if (incomingWins) {
      byId.set(id, event);
    }
  }
  return [...byId.values()];
}

/** Fetches each ESPN date independently with bounded concurrency and a total time/request budget. */
export async function fetchEspnSchedules(leagues, dates, {
  fetcher = globalThis.fetch,
  liveOnlyDates = dates,
  concurrency = MAX_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTotalRequests = DEFAULT_MAX_REQUESTS,
  scheduleBudgetMs = DEFAULT_BUDGET_MS,
  minRequestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS,
  transientRetries = 1,
  onFailure = ({ league, date, error }) => console.warn(`Schedule unavailable for ${league.name} on ${date}: ${String(error)}`),
  onProgress = () => {},
} = {}) {
  if (typeof fetcher !== "function") throw new TypeError("An ESPN fetch implementation is required");
  const allDates = [...new Set((Array.isArray(dates) ? dates : []).map(String))].sort();
  const liveDates = [...new Set((Array.isArray(liveOnlyDates) ? liveOnlyDates : []).map(String))].sort();
  if ([...allDates, ...liveDates].some((date) => !/^\d{8}$/.test(date))) throw new TypeError("ESPN dates must use YYYYMMDD");
  const results = (Array.isArray(leagues) ? leagues : []).map(() => ({ events: [], successfulDates: [], failedDates: [] }));
  const jobs = [];
  for (const [leagueIndex, league] of (Array.isArray(leagues) ? leagues : []).entries()) {
    const leagueDates = league?.liveOnly ? liveDates : allDates;
    for (const date of leagueDates) jobs.push({ league, leagueIndex, date });
  }

  const safeConcurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.trunc(Number(concurrency)) || 1));
  const requestLimit = Math.max(0, Math.trunc(Number(maxTotalRequests)) || 0);
  const timeout = Math.max(1, Math.trunc(Number(timeoutMs)) || DEFAULT_TIMEOUT_MS);
  const budget = Math.max(0, Math.trunc(Number(scheduleBudgetMs)) || 0);
  const interval = Math.max(0, Math.trunc(Number(minRequestIntervalMs)) || 0);
  const retries = Math.max(0, Math.trunc(Number(transientRetries)) || 0);
  const deadline = Date.now() + budget;
  let nextRequestAt = Date.now();
  let requestCount = 0;
  let nextJob = 0;
  let completed = 0;

  async function reserveRequest() {
    const scheduled = Math.max(Date.now(), nextRequestAt);
    nextRequestAt = scheduled + interval;
    const wait = scheduled - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (Date.now() >= deadline || requestCount >= requestLimit) return false;
    requestCount += 1;
    return true;
  }

  async function requestDate(job) {
    let lastError = new Error("ESPN schedule budget exhausted");
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (!await reserveRequest()) return { ok: false, error: lastError };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, error: new Error("ESPN schedule time budget exhausted") };
      const params = new URLSearchParams({ dates: job.date, limit: "1000" });
      if (job.league.group) params.set("groups", String(job.league.group));
      try {
        const response = await fetcher(`${ESPN_SITE_API}/${job.league.path}/scoreboard?${params}`, {
          headers: { Accept: "application/json", "User-Agent": "StreamCorner-TV-Feed/1.3" },
          signal: AbortSignal.timeout(Math.min(timeout, remaining)),
        });
        if (!response?.ok) {
          lastError = new Error(`HTTP ${Number(response?.status) || 0}`);
          lastError.status = Number(response?.status) || 0;
          if (attempt < retries && isRetryable(lastError)) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(250 * (2 ** attempt), Math.max(0, deadline - Date.now()))));
            continue;
          }
          return { ok: false, error: lastError };
        }
        const payload = await readBoundedJson(response);
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.events)) {
          lastError = new Error("Malformed ESPN scoreboard payload: expected an events array");
          lastError.code = "ESPN_INVALID_SCOREBOARD";
          if (attempt < retries) continue;
          return { ok: false, error: lastError };
        }
        results[job.leagueIndex].successfulDates.push(job.date);
        results[job.leagueIndex].events.push(...payload.events);
        return { ok: true };
      } catch (error) {
        lastError = error;
        if (attempt < retries && isRetryable(error) && Date.now() < deadline) continue;
        return { ok: false, error };
      }
    }
    return { ok: false, error: lastError };
  }

  async function worker() {
    while (true) {
      const index = nextJob++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      const result = await requestDate(job);
      if (!result.ok) {
        results[job.leagueIndex].failedDates.push(job.date);
        onFailure({ league: job.league, date: job.date, error: result.error });
      }
      completed += 1;
      onProgress({ completed, total: jobs.length, requests: requestCount });
    }
  }

  await Promise.all(Array.from({ length: Math.min(safeConcurrency, jobs.length) }, worker));
  return results.map((result) => ({
    events: uniqueEvents(result.events),
    successfulDates: [...new Set(result.successfulDates)].sort(),
    failedDates: [...new Set(result.failedDates)].sort(),
  }));
}

export function assessEspnScheduleCoverage(leagues, dates, results, {
  minimumCoverage = MINIMUM_COVERAGE,
  minimumLeagueCoverage = MINIMUM_LEAGUE_COVERAGE,
  essentialDays = ESSENTIAL_DAYS,
} = {}) {
  const expectedDates = [...new Set((Array.isArray(dates) ? dates : []).map(String))].sort();
  const scheduledLeagues = (Array.isArray(leagues) ? leagues : [])
    .map((league, leagueIndex) => ({ league, leagueIndex }))
    .filter(({ league }) => !league?.liveOnly);
  const expectedSlots = scheduledLeagues.length * expectedDates.length;
  const essentialDates = new Set(expectedDates.slice(0, Math.max(0, Math.trunc(essentialDays) || 0)));
  let successfulSlots = 0;
  let failedSlots = 0;
  let essentialMissingSlots = 0;
  const incompleteLeagues = [];
  const successfulByDate = new Map(expectedDates.map((date) => [date, 0]));

  for (const { league, leagueIndex } of scheduledLeagues) {
    const successfulDates = new Set((results?.[leagueIndex]?.successfulDates || []).map(String));
    const failedDates = new Set((results?.[leagueIndex]?.failedDates || []).map(String));
    const leagueSuccesses = expectedDates.filter((date) => successfulDates.has(date)).length;
    const leagueCoverage = expectedDates.length ? leagueSuccesses / expectedDates.length : 0;
    successfulSlots += leagueSuccesses;
    for (const date of expectedDates) if (successfulDates.has(date)) successfulByDate.set(date, successfulByDate.get(date) + 1);
    failedSlots += expectedDates.filter((date) => failedDates.has(date) && !successfulDates.has(date)).length;
    essentialMissingSlots += [...essentialDates].filter((date) => !successfulDates.has(date)).length;
    if (leagueCoverage < minimumLeagueCoverage) {
      incompleteLeagues.push({
        league: String(league?.name || league?.id || "unknown league"),
        coverage: leagueCoverage,
        missingDates: expectedDates.length - leagueSuccesses,
      });
    }
  }

  const incompleteDates = expectedDates.filter((date) =>
    !scheduledLeagues.length || successfulByDate.get(date) / scheduledLeagues.length < minimumLeagueCoverage);
  const coverage = expectedSlots ? successfulSlots / expectedSlots : 0;
  const complete = expectedSlots > 0 && coverage >= minimumCoverage &&
    incompleteLeagues.length === 0 && incompleteDates.length === 0 && essentialMissingSlots === 0;
  return {
    expectedSlots,
    successfulSlots,
    failedSlots,
    missingSlots: expectedSlots - successfulSlots,
    coverage,
    essentialMissingSlots,
    incompleteLeagues,
    incompleteDates,
    complete,
  };
}

export function assertSufficientEspnScheduleCoverage(leagues, dates, results, options = {}) {
  const report = assessEspnScheduleCoverage(leagues, dates, results, options);
  if (!report.complete) {
    const percent = Math.round(report.coverage * 100);
    throw new Error(
      `ESPN schedule coverage is materially incomplete (${percent}% overall; ${report.missingSlots}/${report.expectedSlots} date slots missing; ` +
      `${report.essentialMissingSlots} recent/essential slots missing; ${report.incompleteLeagues.length} league(s) and ` +
      `${report.incompleteDates.length} date(s) below threshold); feed files were not written`,
    );
  }
  return report;
}
