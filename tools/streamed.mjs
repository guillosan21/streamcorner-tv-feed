import { feedSourceKey } from "./playback-identity.mjs";
import { normalizeStreamedHd } from "./stream-quality.mjs";

const API_ORIGIN = "https://streamed.pk";
const API_ROOT = `${API_ORIGIN}/api`;
const MAX_MATCHES = 500;
const MAX_SOURCES_PER_MATCH = 12;
const MAX_STREAMS_PER_SOURCE = 24;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const REQUEST_CONCURRENCY = 8;

const STREAM_SOURCE_IDS = new Set([
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "intel",
]);
const MATCH_ID_REGEX = /^[A-Za-z0-9_-]{1,180}$/;
const STREAM_ID_REGEX = /^[A-Za-z0-9_-]{1,180}$/;
const EMBED_PATH_REGEX = /^\/embed\/(alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|intel)\/([A-Za-z0-9_-]{1,180})(?:\/([1-9][0-9]?))?$/;

const SPORT_LABELS = {
  "american-football": "American Football",
  baseball: "Baseball",
  basketball: "Basketball",
  cricket: "Cricket",
  football: "Soccer",
  hockey: "Ice Hockey",
  mma: "MMA",
  motorsport: "Motorsport",
  rugby: "Rugby",
  tennis: "Tennis",
  volleyball: "Volleyball",
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeText(value, maxLength = 120) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
export function isValidStreamedEmbedUrl(value, expectedSource = "", expectedMatchId = "") {
  try {
    const url = new URL(value);
    const route = EMBED_PATH_REGEX.exec(url.pathname);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "embed.st" &&
      (url.port === "" || url.port === "443") && !url.username && !url.password &&
      !url.search && !url.hash && route !== null &&
      (!expectedSource || route[1] === expectedSource) &&
      (!expectedMatchId || route[2] === expectedMatchId) &&
      (!route[3] || Number(route[3]) <= MAX_STREAMS_PER_SOURCE);
  } catch {
    return false;
  }
}

async function readJsonBounded(response, maximumBytes) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error(`JSON response exceeded ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new Error(`JSON response exceeded ${maximumBytes} bytes`);
  }
  return JSON.parse(text);
}

async function fetchJson(fetchImpl, url, timeoutMs, maximumBytes) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "Sports-TV-Feed/1.0" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (response.url && new URL(response.url).origin !== API_ORIGIN) {
    throw new Error("API response origin changed");
  }
  return readJsonBounded(response, maximumBytes);
}

function validMatch(value) {
  if (!isRecord(value)) return false;
  const id = String(value.id || "");
  const title = safeText(value.title, 180);
  const date = Number(value.date);
  return MATCH_ID_REGEX.test(id) && Boolean(title) && Number.isFinite(date) && date > 0;
}

function validSourceRef(value) {
  return isRecord(value) && STREAM_SOURCE_IDS.has(String(value.source || "").toLowerCase()) &&
    STREAM_ID_REGEX.test(String(value.id || ""));
}

function gameDurationMs(sport) {
  return /cricket|tennis|motorsport|rugby|mma/i.test(sport) ? 8 * 60 * 60 * 1000 : 5 * 60 * 60 * 1000;
}

function sourceLabel(stream, index) {
  const language = safeText(stream.language, 32);
  const hd = stream.hd === true ? " HD" : "";
  const number = Number.isSafeInteger(stream.streamNo) && stream.streamNo > 0 ? ` ${stream.streamNo}` : ` ${index + 1}`;
  return `Streamed • ${[language, `${hd.trim()}${number}`].filter(Boolean).join(" ")}`;
}

function mapGame(match, liveIds, streamsBySource, nowMs, qualityStats) {
  if (!validMatch(match)) return null;
  const startMs = Number(match.date);
  const startsAt = new Date(startMs);
  if (!Number.isFinite(startsAt.getTime())) return null;
  const status = liveIds.has(String(match.id)) ? "live" : startMs > nowMs ? "upcoming" : "";
  if (!status) return null;

  const category = safeText(match.category, 48).toLowerCase();
  const sport = SPORT_LABELS[category] || safeText(match.category, 48) || "Sports";
  const teams = isRecord(match.teams) ? match.teams : {};
  const homeTeam = safeText(teams.home?.name, 100);
  const awayTeam = safeText(teams.away?.name, 100);
  const sources = [];
  const seenEmbeds = new Set();
  const refs = Array.isArray(match.sources) ? match.sources.slice(0, MAX_SOURCES_PER_MATCH) : [];
  for (const ref of refs) {
    if (!validSourceRef(ref)) continue;
    for (const [index, stream] of (streamsBySource.get(`${ref.source}/${ref.id}`) || []).entries()) {
      if (!isRecord(stream) || !isValidStreamedEmbedUrl(stream.embedUrl, ref.source, ref.id)) continue;
      const routeStreamNo = EMBED_PATH_REGEX.exec(new URL(stream.embedUrl).pathname)?.[3];
      if (routeStreamNo && Number.isSafeInteger(stream.streamNo) && Number(routeStreamNo) !== stream.streamNo) continue;
      const hd = normalizeStreamedHd(stream.hd);
      if (seenEmbeds.has(stream.embedUrl)) {
        if (hd === false) {
          const duplicateSourceIndex = sources.findIndex((source) => source.embedUrl === stream.embedUrl);
          if (duplicateSourceIndex >= 0) sources.splice(duplicateSourceIndex, 1);
          qualityStats.excludedHdSourceKeys.add(feedSourceKey({ embedUrl: stream.embedUrl }));
        }
        continue;
      }
      seenEmbeds.add(stream.embedUrl);
      if (hd === false) {
        qualityStats.excludedHdSourceKeys.add(feedSourceKey({ embedUrl: stream.embedUrl }));
        continue;
      }
      sources.push({
        provider: "Streamed",
        embedProvider: "Streamed",
        name: sourceLabel({ ...stream, hd }, index),
        hd,
        url: "",
        embedUrl: stream.embedUrl,
      });
    }
  }
  if (!sources.length) return null;

  const durationMs = gameDurationMs(sport);
  return {
    id: `streamed-${match.id}`,
    provider: "streamed",
    sourceId: String(match.id),
    title: safeText(match.title, 180),
    league: sport,
    sport,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startMs + durationMs).toISOString(),
    status,
    is24x7: false,
    homeTeam,
    awayTeam,
    sources,
  };
}

/**
 * Reads Streamed's documented JSON API only. API-controlled URLs are accepted solely when they
 * match the documented embed.st route; this adapter never loads or evaluates provider scripts.
 */
export async function fetchStreamedGames(now = new Date(), {
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  concurrency = REQUEST_CONCURRENCY,
} = {}) {
  const endpointResults = await Promise.allSettled([
    fetchJson(fetchImpl, `${API_ROOT}/matches/all`, timeoutMs, MAX_JSON_BYTES),
    fetchJson(fetchImpl, `${API_ROOT}/matches/live`, timeoutMs, MAX_JSON_BYTES),
  ]);
  const errors = [];
  const allPayload = endpointResults[0].status === "fulfilled" ? endpointResults[0].value : null;
  const livePayload = endpointResults[1].status === "fulfilled" ? endpointResults[1].value : null;
  if (endpointResults[0].status === "rejected") errors.push(`all matches: ${String(endpointResults[0].reason)}`);
  if (endpointResults[1].status === "rejected") errors.push(`live matches: ${String(endpointResults[1].reason)}`);

  const validArray = (payload, endpoint) => {
    if (!Array.isArray(payload)) {
      errors.push(`${endpoint}: expected an array`);
      return [];
    }
    if (payload.length > MAX_MATCHES) {
      errors.push(`${endpoint}: exceeded ${MAX_MATCHES} matches`);
      return [];
    }
    return payload.filter(validMatch);
  };
  const allMatches = validArray(allPayload, "all matches");
  const liveMatches = validArray(livePayload, "live matches");
  const allMatchesAvailable = endpointResults[0].status === "fulfilled" && Array.isArray(allPayload) &&
    (allPayload.length === 0 || allMatches.length > 0);
  const liveMatchesAvailable = endpointResults[1].status === "fulfilled" && Array.isArray(livePayload) &&
    (livePayload.length === 0 || liveMatches.length > 0);
  const matchesById = new Map(allMatches.map((match) => [String(match.id), match]));
  for (const match of liveMatches) {
    const existing = matchesById.get(String(match.id));
    matchesById.set(String(match.id), existing ? { ...existing, ...match } : match);
  }
  const matches = [...matchesById.values()];
  const liveIds = new Set(liveMatches.map((match) => String(match.id)));

  const refs = [];
  const seenRefs = new Set();
  for (const match of matches) {
    const sourceRefs = Array.isArray(match.sources) ? match.sources.slice(0, MAX_SOURCES_PER_MATCH) : [];
    for (const ref of sourceRefs) {
      if (!validSourceRef(ref)) continue;
      const key = `${ref.source}/${ref.id}`;
      if (seenRefs.has(key)) continue;
      seenRefs.add(key);
      refs.push({ key, source: ref.source, id: ref.id });
    }
  }

  const streamsBySource = new Map();
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency) || 1), refs.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= refs.length) return;
      const ref = refs[index];
      const path = `${API_ROOT}/stream/${encodeURIComponent(ref.source)}/${encodeURIComponent(ref.id)}`;
      try {
        const payload = await fetchJson(fetchImpl, path, timeoutMs, 1024 * 1024);
        if (!Array.isArray(payload)) throw new Error("expected a stream array");
        streamsBySource.set(ref.key, payload.slice(0, MAX_STREAMS_PER_SOURCE));
      } catch (error) {
        if (errors.length < 20) errors.push(`${ref.key}: ${String(error)}`);
      }
    }
  }));

  const nowMs = new Date(now).getTime();
  const qualityStats = { excludedHdSourceKeys: new Set() };
  const games = matches.map((match) => mapGame(match, liveIds, streamsBySource, nowMs, qualityStats)).filter(Boolean);
  const playableSourceCount = games.reduce((count, game) => count + game.sources.length, 0);
  return {
    games,
    allMatchesAvailable,
    liveMatchesAvailable,
    catalogCount: matches.length,
    liveCatalogCount: liveMatches.length,
    playableGameCount: games.length,
    playableSourceCount,
    excludedHdSourceCount: qualityStats.excludedHdSourceKeys.size,
    excludedHdSourceKeys: [...qualityStats.excludedHdSourceKeys],
    streamRequestCount: refs.length,
    errors,
    error: endpointResults.every((result) => result.status === "rejected")
      ? errors.slice(0, 2).join("; ") || "Streamed API unavailable"
      : "",
  };
}
