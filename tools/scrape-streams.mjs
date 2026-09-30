import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchTimStreamsGames } from "./timstreams.mjs";
import { collectSportsUpaMainGames, isSportsUpaMainSource } from "./sportsupa.mjs";
import { fetchPpvGames } from "./ppvstreams.mjs";
import { fetchDlStreamsGames, findBroadcastChannelGames } from "./dlstreams.mjs";
import { fetchHighflyGames, attachAddonSources, preferAddonOverPpv } from "./highfly.mjs";
import { feedSourceKey, isValidPizarraMxSourceRef } from "./playback-identity.mjs";
import { loadTrustedFeedBaseline } from "./feed-baseline.mjs";
import { compareFeedSourceCoverage } from "./feed-safety.mjs";
import { assertSufficientEspnScheduleCoverage, espnLiveScheduleDates, espnScheduleDates, fetchEspnSchedules } from "./espn-schedules.mjs";
import { fetchPizarraMxGames, retainPreviousPizarraMxGames } from "./pizarramx.mjs";
import { fetchStreamCornerGames } from "./streamcorner.mjs";
import { filterKnownStandardDefinitionSources, maxHeightFromManifest } from "./stream-quality.mjs";
import { isRetiredSource } from "./retired-snapshot.mjs";

const APP_FEED_OUTPUT = process.env.APP_FEED_OUTPUT || "app/src/main/assets/games.json";
const SCRAPE_OUTPUT = process.env.SCRAPE_OUTPUT || "data/scraped-streams.json";
const STATUS_OUTPUT = process.env.STATUS_OUTPUT || "";
const ESPN_CORE_API = "https://sports.core.api.espn.com/v2/sports";
const ESPN_SITE_API = "https://site.web.api.espn.com/apis/site/v2/sports";
const PREVIOUS_FEED_URL = process.env.PREVIOUS_FEED_URL || "https://guillosan21.github.io/streamcorner-tv-feed/games.json";

const teamLeagues = [
  { id: "NFL", path: "football/nfl", name: "NFL", sport: "American Football", region: "United States", minimum: 28 },
  { id: "NBA", path: "basketball/nba", name: "NBA", sport: "Basketball", region: "United States", minimum: 25 },
  { id: "WNBA", path: "basketball/wnba", name: "WNBA", sport: "Basketball", region: "United States", minimum: 10, exclude: ["JAPAN", "NIGERIA"] },
  { id: "MLB", path: "baseball/mlb", name: "MLB", sport: "Baseball", region: "United States", minimum: 25 },
  { id: "NHL", path: "hockey/nhl", name: "NHL", sport: "Hockey", region: "United States", minimum: 25 },
  { id: "MLS", path: "soccer/usa.1", name: "MLS", sport: "Soccer", region: "United States", minimum: 20, exclude: ["Liga MX All-Stars", "MLS All-Stars"] },
  { id: "NWSL", path: "soccer/usa.nwsl", name: "NWSL", sport: "Soccer", region: "United States", minimum: 10 },
  { id: "LIGA_MX", path: "soccer/mex.1", name: "Liga MX", sport: "Soccer", region: "Mexico", minimum: 14 },
  { id: "PREMIER_LEAGUE", path: "soccer/eng.1", name: "Premier League", sport: "Soccer", region: "European Soccer", minimum: 18 },
  { id: "LA_LIGA", path: "soccer/esp.1", name: "La Liga", sport: "Soccer", region: "European Soccer", minimum: 18 },
  { id: "SERIE_A", path: "soccer/ita.1", name: "Serie A", sport: "Soccer", region: "European Soccer", minimum: 18 },
  { id: "BUNDESLIGA", path: "soccer/ger.1", name: "Bundesliga", sport: "Soccer", region: "European Soccer", minimum: 16 },
  { id: "LIGUE_1", path: "soccer/fra.1", name: "Ligue 1", sport: "Soccer", region: "European Soccer", minimum: 16 },
  { id: "UCL", path: "soccer/uefa.champions", name: "UEFA Champions League", sport: "Soccer", region: "European Soccer", minimum: 20, fallbackPreviousSeason: true },
];
const scheduleLeagues = [
  ...teamLeagues,
  { id: "UEL", path: "soccer/uefa.europa", name: "UEFA Europa League", sport: "Soccer", region: "European Soccer" },
  { id: "EFL_CUP", path: "soccer/eng.league_cup", name: "EFL Cup", sport: "Soccer", region: "European Soccer" },
  // Schedule-only coverage for add-on event matching; not favorite-team catalog entries.
  { id: "NCAAF", path: "football/college-football", name: "NCAA Football", sport: "American Football", liveOnly: true },
  { id: "NCAAF", path: "football/college-football", name: "NCAA Football", sport: "American Football", liveOnly: true, group: 81 },
  { id: "BRA_SERIE_A", path: "soccer/bra.1", name: "Brazilian Serie A", sport: "Soccer", liveOnly: true },
];

function estimatedDurationSeconds(title, league, sport) {
  const value = `${sport} ${league} ${title}`.toLowerCase();
  if (/formula|motorsport|racing/.test(value)) return 6 * 60 * 60;
  if (/golf/.test(value)) return 12 * 60 * 60;
  if (/cricket|tennis|boxing|ufc|mma|wrestling|darts|snooker|cycling/.test(value)) return 8 * 60 * 60;
  if (/baseball|mlb|american football|nfl|cfl/.test(value)) return 6 * 60 * 60;
  if (/basketball|nba|wnba|hockey|nhl|soccer|football/.test(value)) return 4 * 60 * 60;
  return 8 * 60 * 60;
}

function canonicalTeam(value) {
  return String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/\bchiacgo\b/g, "chicago")
    .replace(/\bman city\b/g, "manchester city")
    .replace(/\bpsg\b/g, "paris saint germain")
    .replace(/\bman utd\b|\bman united\b/g, "manchester united")
    .replace(/\bspurs\b/g, "tottenham hotspur")
    .replace(/\bmunchen\b/g, "munich")
    .replace(/\bvfb\b/g, " ")
    .replace(/\breal racing club\b/g, "racing santander")
    .replace(/\bracing de santander\b/g, "racing santander")
    .replace(/\bathletic bilbao\b/g, "athletic")
    .replace(/\b(fc|cf|afc|club|town)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeLeagueLabel(value) {
  return String(value || "").trim().replace(/^(?:2\.\s*Bundesliga|Bundesliga\s*2)$/i, "Bundesliga");
}

function eventSides(game) {
  if (game.homeTeam && game.awayTeam) return [canonicalTeam(game.homeTeam), canonicalTeam(game.awayTeam)];
  const pieces = String(game.title || "").split("|")[0]
    .split(/\s+(?:v(?:s)?\.?|versus|at|@|-|–|—)\s+/i)
    .map(canonicalTeam).filter(Boolean);
  return pieces.length >= 2 ? pieces.slice(-2) : [];
}

function similarTeam(first, second) {
  if (!first || !second) return false;
  if (first === second) return true;
  const ignored = new Set(["team", "club", "fc", "cf", "afc", "sc", "ac", "olympique"]);
  const firstTokens = first.split(" ").filter((token) => token.length >= 3 && !ignored.has(token));
  const secondTokens = second.split(" ").filter((token) => token.length >= 3 && !ignored.has(token));
  if (!firstTokens.length || !secondTokens.length) return false;
  const initials = (tokens) => tokens.map((token) => token[0]).join("");
  if (first.length >= 3 && !first.includes(" ") && first === initials(secondTokens)) return true;
  if (second.length >= 3 && !second.includes(" ") && second === initials(firstTokens)) return true;
  const matched = firstTokens.filter((left) => secondTokens.some((right) =>
    left === right || (Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left))))).length;
  return matched >= Math.min(firstTokens.length, secondTokens.length);
}

// Only provider-declared early streams get the wide join window; normal Pizarra
// event clocks remain limited to the same rounding tolerance as other feeds.
const MAX_PIZARRA_SCHEDULE_SKEW_MS = 18 * 60 * 60 * 1000;
const MAX_PIZARRA_NORMAL_SCHEDULE_SKEW_MS = 45 * 60 * 1000;
const MAX_PIZARRA_UTC_DAY_SKEW = 1;
const TIME_LIMITED_DLSTREAMS_ATTACHMENTS = Object.freeze([
  {
    scoreboardEventId: "espn-mlb-401907896",
    scoreboardLeagueId: "MLB",
    eventStartsAt: "2026-09-29T21:00:00.000Z",
    expiresAt: "2026-09-30T03:00:00.000Z",
    channelId: "926",
    channelTitle: "ESPN 2 MX",
  },
]);

function isEarlyPizarraEvent(game) {
  return game?.provider === "pizarramx" &&
    (game.sources || []).some((source) => source?.availableBeforeKickoff === true);
}

function hasExplicitDoubleheaderMarker(game) {
  return /\b(?:game|match)\s*[12]\b|\b(?:1st|2nd)\s+(?:game|match)\b|\bdouble[- ]?header\b/i.test(
    `${game.title || ""} ${game.homeTeam || ""} ${game.awayTeam || ""}`);
}

function scheduleSportKey(game) {
  const value = canonicalTeam(game?.sport || "");
  if (["football", "soccer", "association football"].includes(value)) return "soccer";
  if (["nfl", "american football", "football americano"].includes(value)) return "american football";
  if (["mlb", "baseball"].includes(value)) return "baseball";
  if (["nba", "wnba", "basketball"].includes(value)) return "basketball";
  if (["nhl", "hockey", "ice hockey"].includes(value)) return "hockey";
  return value;
}

function scheduleLeagueKey(game) {
  const value = canonicalTeam(game?.league || game?.scoreboardLeagueId || "");
  const aliases = {
    "liga bbva mx": "liga mx",
    "major league baseball": "mlb",
    "uefa champions league": "champions league",
    "uefa europa league": "europa league",
  };
  return aliases[value] || value;
}

function exactCompatibleMatchup(first, second) {
  if (hasExplicitDoubleheaderMarker(first) || hasExplicitDoubleheaderMarker(second)) return false;
  if (!scheduleSportKey(first) || scheduleSportKey(first) !== scheduleSportKey(second)) return false;
  const firstLeague = scheduleLeagueKey(first);
  if (!firstLeague || firstLeague !== scheduleLeagueKey(second)) return false;
  const left = eventSides(first);
  const right = eventSides(second);
  if (left.length !== 2 || right.length !== 2) return false;
  return (left[0] === right[0] && left[1] === right[1]) ||
    (left[0] === right[1] && left[1] === right[0]);
}

function pizarraCompatibleScheduleCandidates(game, scheduleGames) {
  if (game?.provider !== "pizarramx") return [];
  const gameStart = Date.parse(game.startsAt || "");
  if (!Number.isFinite(gameStart)) return [];
  const allowedSkew = isEarlyPizarraEvent(game)
    ? MAX_PIZARRA_SCHEDULE_SKEW_MS
    : MAX_PIZARRA_NORMAL_SCHEDULE_SKEW_MS;
  const gameDay = Math.floor(gameStart / 86_400_000);
  return scheduleGames.filter((candidate) => {
    const candidateStart = Date.parse(candidate?.startsAt || "");
    const state = String(candidate?.scheduleState || "").toLowerCase();
    return String(candidate?.scoreboardEventId || "").trim() && Number.isFinite(candidateStart) &&
      ["pre", "in", "post"].includes(state) &&
      Math.abs(candidateStart - gameStart) <= allowedSkew &&
      Math.abs(Math.floor(candidateStart / 86_400_000) - gameDay) <= MAX_PIZARRA_UTC_DAY_SKEW &&
      exactCompatibleMatchup(game, candidate);
  });
}

export function pizarraScheduleSkewMatches(game, scheduled, sourceGames, scheduleGames) {
  if (game?.provider !== "pizarramx") return false;
  const candidates = pizarraCompatibleScheduleCandidates(game, scheduleGames);
  const scheduledId = String(scheduled?.scoreboardEventId || "").trim();
  if (candidates.length !== 1 || !scheduledId ||
      String(candidates[0].scoreboardEventId).trim() !== scheduledId ||
      !exactCompatibleMatchup(game, candidates[0])) return false;

  const otherPizarraRows = sourceGames.filter((candidate) => candidate.id !== game.id &&
    candidate.provider === "pizarramx" && pizarraCompatibleScheduleCandidates(candidate, [scheduled]).length > 0);
  return otherPizarraRows.length === 0;
}

export function sameFeedEvent(first, second) {
  const firstScoreboardId = String(first.scoreboardEventId || "").trim();
  const secondScoreboardId = String(second.scoreboardEventId || "").trim();
  if ((first.doNotAttachToOfficialSchedule && secondScoreboardId) ||
      (second.doNotAttachToOfficialSchedule && firstScoreboardId)) return false;
  if (firstScoreboardId && secondScoreboardId) return firstScoreboardId.toLowerCase() === secondScoreboardId.toLowerCase();
  if ((first.provider === "pizarramx" && secondScoreboardId) ||
      (second.provider === "pizarramx" && firstScoreboardId)) return false;
  if ((first.provider === "pizarramx" && !firstScoreboardId && first.id !== second.id) ||
      (second.provider === "pizarramx" && !secondScoreboardId && first.id !== second.id)) return false;
  if (hasExplicitDoubleheaderMarker(first) || hasExplicitDoubleheaderMarker(second)) return false;
  if (!first.startsAt || !second.startsAt) return first.id === second.id;
  if (Math.abs(Date.parse(first.startsAt) - Date.parse(second.startsAt)) > 30 * 60 * 1000) return false;
  const left = eventSides(first);
  const right = eventSides(second);
  if (left.length !== 2 || right.length !== 2) return false;
  return (similarTeam(left[0], right[0]) && similarTeam(left[1], right[1])) ||
    (similarTeam(left[0], right[1]) && similarTeam(left[1], right[0]));
}

export function isExplicitEspnDelayedEvent(event) {
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

export function parseExplicitEspnRestartAt(...details) {
  for (const raw of details) {
    const match = /^(?:the\s+)?(?:game\s+)?(?:weather\s+)?delayed\s+(?:until|to)\s+(.+)$/i.exec(String(raw || "").trim());
    if (!match) continue;
    const value = match[1].trim().replace(/\s+at\s+/i, " ");
    // A date, clock, and explicit zone are all mandatory. Never derive this value
    // from event.date or from a bare clock such as "8:00 PM".
    if (!/\b\d{4}\b/.test(value) || !/\b\d{1,2}:\d{2}\b/.test(value) ||
        !/(?:\b(?:UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b|(?:Z|[+-]\d{2}:?\d{2}))$/i.test(value)) continue;
    const epoch = Date.parse(value);
    if (Number.isFinite(epoch)) return new Date(epoch).toISOString();
  }
  return "";
}

const MAX_DELAYED_EVENT_AGE_MS = 48 * 60 * 60 * 1000;

export function isEspnDelayedGameWithinStaleLimit(game, nowMs) {
  if (game?.isDelayed !== true || !["pre", "in"].includes(String(game.scheduleState || "").toLowerCase())) return false;
  const startsAt = Date.parse(game.startsAt || "");
  // Future kickoff instants are not stale; only a delay more than 48 hours beyond
  // its original scheduled start expires.
  return Number.isFinite(startsAt) && nowMs - startsAt <= MAX_DELAYED_EVENT_AGE_MS;
}

export function deduplicateFeedSources(...sourceGroups) {
  const sources = [];
  const byKey = new Map();
  for (const source of sourceGroups.flatMap((group) => Array.isArray(group) ? group : [])) {
    const key = feedSourceKey(source);
    if (!key || !byKey.has(key)) {
      if (key) byKey.set(key, sources.length);
      sources.push(source);
      continue;
    }
    const index = byKey.get(key);
    if (source?.availableBeforeKickoff === true && sources[index]?.availableBeforeKickoff !== true) {
      sources[index] = { ...sources[index], availableBeforeKickoff: true };
    }
  }
  return sources;
}

export function deduplicateFeedGames(rows) {
  let current = rows;
  while (true) {
  const merged = [];
  for (const game of current) {
    const existing = merged.find((candidate) => sameFeedEvent(candidate, game));
    if (!existing) {
      merged.push(game);
      continue;
    }
    const preservedSources = deduplicateFeedSources(existing.sources, game.sources);
    const pendingKickoffHold = [existing.awaitingOfficialKickoffUntil, game.awaitingOfficialKickoffUntil]
      .map((value) => Date.parse(value || ""))
      .filter(Number.isFinite)
      .reduce((latest, value) => Math.max(latest, value), Number.NEGATIVE_INFINITY);
    const doNotAttachToOfficialSchedule = Boolean(existing.doNotAttachToOfficialSchedule || game.doNotAttachToOfficialSchedule);
    const officialStateRank = (row) => ({ pre: 1, in: 2, post: 3 }[String(row.scheduleState || "").toLowerCase()] || 0);
    const authoritativeSchedule = [existing, game]
      .filter((row) => String(row.scoreboardEventId || "").trim())
      .sort((left, right) => officialStateRank(right) - officialStateRank(left))[0];
    const officialFields = authoritativeSchedule ? {
      startsAt: authoritativeSchedule.startsAt,
      endsAt: authoritativeSchedule.endsAt,
      status: authoritativeSchedule.status,
      scheduleState: authoritativeSchedule.scheduleState,
      scoreboardLeagueId: authoritativeSchedule.scoreboardLeagueId,
      scoreboardEventId: authoritativeSchedule.scoreboardEventId,
      homeScore: authoritativeSchedule.homeScore,
      awayScore: authoritativeSchedule.awayScore,
      scoreDetail: authoritativeSchedule.scoreDetail,
      espnBroadcasts: authoritativeSchedule.espnBroadcasts,
      isDelayed: authoritativeSchedule.scheduleState !== "post" && authoritativeSchedule.isDelayed === true,
      restartAt: authoritativeSchedule.scheduleState !== "post" && authoritativeSchedule.isDelayed === true
        ? String(authoritativeSchedule.restartAt || "") : "",
    } : null;
    const authority = (row) => (row.scoreboardLeagueId ? 8 : 0) + (row.scheduleState ? 4 : 0) +
      (String(row.homeLogoUrl || "").includes("espncdn.com") && String(row.awayLogoUrl || "").includes("espncdn.com") ? 2 : 0) +
      (row.venue ? 1 : 0);
    if (authority(game) > authority(existing)) {
      Object.assign(existing, game);
    }
    existing.sources = preservedSources;
    if (Number.isFinite(pendingKickoffHold)) {
      existing.awaitingOfficialKickoffUntil = new Date(pendingKickoffHold).toISOString();
    } else {
      delete existing.awaitingOfficialKickoffUntil;
    }
    if (doNotAttachToOfficialSchedule) existing.doNotAttachToOfficialSchedule = true;
    else delete existing.doNotAttachToOfficialSchedule;
    if (officialFields) {
      Object.assign(existing, officialFields);
      if (String(officialFields.scheduleState || "").toLowerCase() === "in") existing.status = "live";
      else if (String(officialFields.scheduleState || "").toLowerCase() === "pre") existing.status = "upcoming";
    } else if (game.status === "live") {
      existing.status = "live";
    }
    if (!existing.venue && game.venue) existing.venue = game.venue;
    if (!existing.homeLogoUrl && game.homeLogoUrl) existing.homeLogoUrl = game.homeLogoUrl;
    if (!existing.awayLogoUrl && game.awayLogoUrl) existing.awayLogoUrl = game.awayLogoUrl;
    if (!existing.posterUrl && game.posterUrl) existing.posterUrl = game.posterUrl;
  }
  if (merged.length === current.length) return merged;
  current = merged;
  }
}

function countRemainingDuplicatePairs(rows) {
  let count = 0;
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      if (sameFeedEvent(rows[left], rows[right])) count += 1;
    }
  }
  return count;
}

function scheduleMatchForSource(game, scheduled, sourceGames, scheduleGames) {
  const sourceScoreboardId = String(game.scoreboardEventId || "").trim();
  const scheduledScoreboardId = String(scheduled.scoreboardEventId || "").trim();
  if (sourceScoreboardId && scheduledScoreboardId) {
    return sourceScoreboardId.toLowerCase() === scheduledScoreboardId.toLowerCase();
  }
  if (game.provider === "pizarramx") {
    return pizarraScheduleSkewMatches(game, scheduled, sourceGames, scheduleGames);
  }

  const gameTeams = [canonicalTeam(game.homeTeam), canonicalTeam(game.awayTeam)].filter(Boolean).sort().join("|");
  const scheduledTeams = [canonicalTeam(scheduled.homeTeam), canonicalTeam(scheduled.awayTeam)].filter(Boolean).sort().join("|");
  const normalizedTitle = canonicalTeam(game.title);
  const home = canonicalTeam(scheduled.homeTeam);
  const away = canonicalTeam(scheduled.awayTeam);
  const titleMatches = home && away && normalizedTitle.includes(home) && normalizedTitle.includes(away);
  const closeInTime = Math.abs(Date.parse(game.startsAt) - Date.parse(scheduled.startsAt)) <= 45 * 60 * 1000;
  const sameExternalId = game.sourceId && scheduled.sourceId && String(game.sourceId) === String(scheduled.sourceId);
  return sameExternalId || (closeInTime && (gameTeams === scheduledTeams || titleMatches));
}

export function attachScheduleGames(sourceGames, scheduleGames, now = new Date()) {
  const games = [...sourceGames];
  const matchedSourceGames = new Set();
  for (const scheduled of scheduleGames) {
    const scheduledTeams = [canonicalTeam(scheduled.homeTeam), canonicalTeam(scheduled.awayTeam)].filter(Boolean).sort().join("|");
    const matches = games.filter((game) => !matchedSourceGames.has(game.id) && scheduledTeams &&
      scheduleMatchForSource(game, scheduled, sourceGames, scheduleGames));
    if (matches.length) {
      for (const match of matches) {
        matchedSourceGames.add(match.id);
        match.title = scheduled.title;
        match.league = scheduled.league;
        match.sport = scheduled.sport;
        match.startsAt = scheduled.startsAt;
        match.endsAt = scheduled.endsAt;
        match.homeTeam = scheduled.homeTeam;
        match.awayTeam = scheduled.awayTeam;
        if (!isMissingVenue(scheduled.venue)) match.venue = scheduled.venue;
        match.homeLogoUrl ||= scheduled.homeLogoUrl;
        match.awayLogoUrl ||= scheduled.awayLogoUrl;
        match.scheduleState = scheduled.scheduleState;
        match.status = scheduled.status;
        match.isDelayed = scheduled.scheduleState !== "post" && scheduled.isDelayed === true;
        match.restartAt = match.isDelayed ? String(scheduled.restartAt || "") : "";
        match.scoreboardLeagueId = scheduled.scoreboardLeagueId;
        match.scoreboardEventId = scheduled.scoreboardEventId;
        match.homeScore = scheduled.homeScore;
        match.awayScore = scheduled.awayScore;
        match.scoreDetail = scheduled.scoreDetail;
        match.espnBroadcasts = scheduled.espnBroadcasts;
        match.sources = deduplicateFeedSources(match.sources, scheduled.sources);
      }
    } else if (scheduled.scheduleState !== "post") {
      games.push(scheduled);
    }
  }

  const nowMs = Date.parse(now instanceof Date ? now.toISOString() : now);
  for (const game of games) {
    if (game.provider !== "pizarramx") continue;
    delete game.awaitingOfficialKickoffUntil;
    delete game.doNotAttachToOfficialSchedule;
    if (String(game.scoreboardEventId || "").trim()) continue;
    game.doNotAttachToOfficialSchedule = true;
    // Android honors this hold and source flag while its narrower local event
    // matcher waits; keeping the durable guard also prevents later score joins
    // from guessing between same-team doubleheaders.
    if (!Number.isFinite(nowMs) || !isEarlyPizarraEvent(game)) continue;
    const candidates = pizarraCompatibleScheduleCandidates(game, scheduleGames);
    const allFarPre = candidates.length > 0 && candidates.every((candidate) => {
      const start = Date.parse(candidate.startsAt || "");
      return String(candidate.scheduleState || "").toLowerCase() === "pre" &&
        Number.isFinite(start) && start - nowMs > 15 * 60 * 1000;
    });
    if (allFarPre) {
      const earliestStart = Math.min(...candidates.map((candidate) => Date.parse(candidate.startsAt)));
      game.awaitingOfficialKickoffUntil = new Date(earliestStart - 15 * 60 * 1000).toISOString();
    }
  }
  return deduplicateFeedGames(games.filter((game) => game.scheduleState !== "post"));
}

export function attachTimeLimitedDlStreamsSources(games, now = new Date()) {
  const rows = Array.isArray(games) ? games : [];
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return 0;
  let attachedCount = 0;

  for (const override of TIME_LIMITED_DLSTREAMS_ATTACHMENTS) {
    const startMs = Date.parse(override.eventStartsAt);
    const expiresMs = Date.parse(override.expiresAt);
    if (nowMs < startMs || nowMs >= expiresMs) continue;

    const channel = rows.find((game) => game?.id === `dlstreams-${override.channelId}` &&
      game?.provider === "dlstreams" && String(game?.sourceId || "") === override.channelId &&
      game?.title === override.channelTitle && game?.is24x7 === true);
    if (!channel) continue;
    const expectedEmbedUrl = `https://dlstreams.st/stream/stream-${override.channelId}.php`;
    const channelSources = (channel.sources || []).filter((source) =>
      source?.provider === "DLStreams" && source?.embedProvider === "DLStreams" &&
      source?.name === `DLStreams • ${override.channelTitle}` && !source?.url &&
      source?.embedUrl === expectedEmbedUrl);
    if (!channelSources.length) continue;

    for (const game of rows) {
      if (!game || game.is24x7 || game.scoreboardLeagueId !== override.scoreboardLeagueId ||
          game.scheduleState !== "in" || game.status !== "live") continue;
      const matchesScoreboardId = String(game.scoreboardEventId || "") === override.scoreboardEventId;
      const matchesCanonicalEspnIdentity = game.provider === "espn-schedule" && game.id === override.scoreboardEventId;
      if (!matchesScoreboardId && !matchesCanonicalEspnIdentity) continue;

      const startsAtMs = Date.parse(game.startsAt || "");
      const endsAtMs = Date.parse(game.endsAt || "");
      if (startsAtMs !== startMs || !Number.isFinite(endsAtMs) || nowMs >= endsAtMs) continue;
      if (!Array.isArray(game.sources)) game.sources = [];
      for (const source of channelSources) {
        const key = feedSourceKey(source);
        if (!key || game.sources.some((candidate) => feedSourceKey(candidate) === key)) continue;
        game.sources.push({ ...source, headers: { ...(source.headers || {}) } });
        attachedCount += 1;
      }
    }
  }
  return attachedCount;
}

function inferredWebProvider(embedUrl) {
  const host = runCatchingUrlHost(embedUrl);
  if (!host) return "";
  if (host === "timstreams.st" || host.endsWith(".timstreams.st") || /^cdx-\d+\.website$/.test(host)) return "TimStreams";
  if (host === "ppv.st" || host.endsWith(".ppv.st") ||
      host === "embedindia.st" || host.endsWith(".embedindia.st") ||
      host === "embedhd.st" || host.endsWith(".embedhd.st") ||
      host.endsWith(".ppvservices.st") || host.endsWith(".pandecocogaming.sbs") ||
      host.endsWith(".getsugatensho.sbs")) return "PPV";
  if (host === "dlstreams.st" || host.endsWith(".dlstreams.st") || host.endsWith(".romponalis.st")) return "DLStreams";
  return "";
}

function sourceProvenanceErrors(rows) {
  const errors = [];
  for (const game of rows) {
    for (const source of game.sources || []) {
      const provider = String(source.provider || "");
      const embedProvider = String(source.embedProvider || "");
      const inferred = inferredWebProvider(source.embedUrl);
      const rawProviderRef = String(source.providerSourceRef || "");
      const isPizarraRef = provider === "Pizarra MX" && rawProviderRef === rawProviderRef.trim() &&
        isValidPizarraMxSourceRef(rawProviderRef);
      if (isRetiredSource(source)) {
        errors.push(`${game.id}: retired Streamed source cannot be published`);
      }
      if (!["StreamCorner", "TimStreams", "PPV", "Sports Streams", "DLStreams", "Pizarra MX", "SportsUpa"].includes(provider)) {
        errors.push(`${game.id}: invalid provider ${provider || "<empty>"}`);
      }
      if (!String(source.name || "").startsWith(`${provider} • `)) {
        errors.push(`${game.id}: label ${source.name || "<empty>"} disagrees with ${provider || "<empty>"}`);
      }
      if (provider === "SportsUpa" && !isSportsUpaMainSource(source)) {
        errors.push(`${game.id}: SportsUpa requires an affirmative HD canonical Main ingest source`);
      }
      if (provider === "Pizarra MX" && (!isPizarraRef || source.url || source.embedUrl || Object.keys(source.headers || {}).length)) {
        errors.push(`${game.id}: Pizarra MX source must be an exact opaque ref without published transport state`);
      }
      if (inferred && embedProvider !== inferred) {
        errors.push(`${game.id}: ${source.embedUrl} has embedProvider=${embedProvider || "<empty>"}, expected ${inferred}`);
      }
      if (!source.url && inferred && provider !== inferred) {
        errors.push(`${game.id}: web source provider=${provider || "<empty>"}, expected ${inferred}`);
      }
    }
  }
  return errors;
}

function collapsePpvMirrors(rows) {
  let removed = 0;
  for (const game of rows) {
    const ppvSources = (game.sources || []).filter((source) => source.provider === "PPV");
    if (ppvSources.length <= 1) continue;
    const canonical = [...ppvSources].sort((first, second) => {
      const priority = (source) => {
        const host = runCatchingUrlHost(source.embedUrl);
        const canonicalPath = /^https:\/\/embedindia\.st\/embed\//i.test(String(source.embedUrl || ""));
        const hasSignedSession = (() => {
          try { return Boolean(new URL(source.embedUrl).searchParams.get("gid")); } catch { return false; }
        })();
        return (hasSignedSession ? 32 : 0) + (canonicalPath ? 8 : 0) + (host === "embedindia.st" ? 4 : 0) +
          (!/\bstream\s*\d+\b/i.test(String(source.name || "")) ? 2 : 0);
      };
      return priority(second) - priority(first);
    })[0];
    let inserted = false;
    game.sources = game.sources.filter((source) => {
      if (source.provider !== "PPV") return true;
      if (!inserted && source === canonical) { inserted = true; return true; }
      return false;
    });
    if (!inserted) game.sources.push(canonical);
    removed += ppvSources.length - 1;
  }
  return removed;
}

function isMissingVenue(value) {
  return !String(value || "").trim() || /^(?:venue\s+)?tba$/i.test(String(value).trim());
}

async function fetchEspnEventVenue(league, eventId) {
  try {
    const response = await fetch(`${ESPN_SITE_API}/${league.path}/summary?event=${encodeURIComponent(eventId)}`, {
      headers: { Accept: "application/json", "User-Agent": "StreamCorner-TV-Feed/1.3" }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return "";
    const payload = await response.json();
    const venueData = payload?.header?.competitions?.[0]?.venue || payload?.gameInfo?.venue || {};
    const address = venueData.address || {};
    const location = [address.city, address.state, address.country].filter(Boolean).join(", ");
    return [String(venueData.fullName || "").trim(), location].filter(Boolean).join(" • ");
  } catch {
    return "";
  }
}

async function fetchMajorLeagueSchedules(now) {
  const historyStart = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
  const scheduleDates = espnScheduleDates(now);
  const liveScheduleDates = espnLiveScheduleDates(now);
  const scheduleResults = await fetchEspnSchedules(scheduleLeagues, scheduleDates, {
    liveOnlyDates: liveScheduleDates,
    concurrency: 12,
    timeoutMs: 8_000,
    maxTotalRequests: 1_000,
    scheduleBudgetMs: 150_000,
    minRequestIntervalMs: 125,
    transientRetries: 1,
    onProgress: ({ completed: count, total, requests }) => {
      if (count % 20 === 0 || count === total) console.log(`ESPN daily schedules: ${count}/${total} dates (${requests} requests)`);
    },
  });
  const scheduleCoverage = assertSufficientEspnScheduleCoverage(scheduleLeagues, scheduleDates, scheduleResults);
  const games = [];
  const scores = [];
  const completed = [];
  for (const [leagueIndex, league] of scheduleLeagues.entries()) {
      const events = scheduleResults[leagueIndex]?.events || [];
      for (const event of events) {
        const competition = event?.competitions?.[0] || {};
        const scheduleState = String(event?.status?.type?.state || "").toLowerCase();
        const isDelayed = isExplicitEspnDelayedEvent(event);
        if (league.liveOnly && scheduleState !== "in" && !isDelayed) continue;
        const startsAt = new Date(event.date);
        if (!Number.isFinite(startsAt.getTime())) continue;
        const delayedWithinStaleLimit = isDelayed && isEspnDelayedGameWithinStaleLimit({
          isDelayed: true, scheduleState, startsAt: startsAt.toISOString(),
        }, now.getTime());
        const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
        const home = competitors.find((item) => item.homeAway === "home") || {};
        const away = competitors.find((item) => item.homeAway === "away") || {};
        const homeTeam = String(home.team?.displayName || home.team?.name || "").trim();
        const awayTeam = String(away.team?.displayName || away.team?.name || "").trim();
        const title = String(event.name || `${awayTeam} vs ${homeTeam}`).trim();
        const endSeconds = Math.floor(startsAt.getTime() / 1000) + estimatedDurationSeconds(title, league.name, league.sport);
        const nowSeconds = Math.floor(now.getTime() / 1000);
        const address = competition.venue?.address || {};
        const location = [address.city, address.state, address.country].filter(Boolean).join(", ");
        const venueName = String(competition.venue?.fullName || "").trim();
        let venue = [venueName, location].filter(Boolean).join(" • ");
        if (isMissingVenue(venue) && event.id && homeTeam && awayTeam && !/\btbd\b/i.test(`${homeTeam} ${awayTeam}`)) {
          venue = await fetchEspnEventVenue(league, event.id) || venue;
        }
        const homeScore = String(home.score ?? "").trim();
        const awayScore = String(away.score ?? "").trim();
        const scoreDetail = String(event?.status?.type?.shortDetail || event?.status?.type?.detail || event?.status?.displayClock || "").trim();
        const restartAt = isDelayed
          ? parseExplicitEspnRestartAt(event?.status?.type?.detail, event?.status?.type?.shortDetail)
          : "";
        const espnBroadcasts = [...new Set((Array.isArray(competition.broadcasts) ? competition.broadcasts : [])
          .flatMap((broadcast) => Array.isArray(broadcast?.names) ? broadcast.names : [])
          .map((name) => String(name || "").trim()).filter(Boolean))];
        const scheduledGame = {
          id: `espn-${league.id.toLowerCase()}-${event.id}`,
          provider: "espn-schedule",
          sourceId: String(event.id || ""),
          title, league: league.name, sport: league.sport,
          startsAt: startsAt.toISOString(), endsAt: new Date(endSeconds * 1000).toISOString(),
          status: scheduleState === "in" ? "live" : "upcoming", scheduleState, is24x7: false,
          scoreboardLeagueId: league.id,
          scoreboardEventId: event.id ? `espn-${league.id.toLowerCase()}-${event.id}` : "",
          isDelayed: isDelayed && scheduleState !== "post",
          ...(restartAt ? { restartAt } : {}),
          espnBroadcasts,
          homeScore, awayScore, scoreDetail,
          homeTeam, awayTeam,
          homeLogoUrl: String(home.team?.logo || "").replace(/^http:/, "https:"),
          awayLogoUrl: String(away.team?.logo || "").replace(/^http:/, "https:"),
          posterUrl: "", categoryLogoUrl: "", venue, sources: [],
        };
        if ((scheduleState === "in" || scheduleState === "post" || (scheduleState === "pre" && isDelayed)) &&
            startsAt >= historyStart && (!isDelayed || delayedWithinStaleLimit)) {
          scores.push({
            id: `espn-${league.id.toLowerCase()}-${event.id}`,
            leagueId: league.id, league: league.name, sport: league.sport,
            startsAt: startsAt.toISOString(), state: scheduleState, statusDetail: scoreDetail,
            isDelayed: isDelayed && scheduleState !== "post",
            ...(restartAt ? { restartAt } : {}),
            homeTeam, awayTeam, homeScore, awayScore,
            homeLogoUrl: String(home.team?.logo || "").replace(/^http:/, "https:"),
            awayLogoUrl: String(away.team?.logo || "").replace(/^http:/, "https:"),
            venue,
          });
        }
        if (scheduleState === "post") { completed.push(scheduledGame); continue; }
        if (endSeconds <= nowSeconds && !delayedWithinStaleLimit) continue;
        games.push(scheduledGame);
      }
  }
  return { games, scores, completed, scheduleDates, scheduleResults, scheduleCoverage };
}

function activeGameAt(game, nowMs) {
  if (game?.scheduleState === "post") return false;
  if (game?.is24x7) return true;
  if (game?.isDelayed) return isEspnDelayedGameWithinStaleLimit(game, nowMs);
  const startsAt = Date.parse(game?.startsAt || "");
  const endsAt = Date.parse(game?.endsAt || "");
  if (game?.status === "upcoming") return Number.isFinite(startsAt) && startsAt > nowMs && (!Number.isFinite(endsAt) || endsAt > nowMs);
  return game?.status === "live" && Number.isFinite(endsAt) && endsAt > nowMs;
}

async function inspectStreamCapabilities(source, provider = "") {
  if (source.provider === "SportsUpa") return isSportsUpaMainSource(source) ? source : null;
  if (source.provider === "Pizarra MX" && isValidPizarraMxSourceRef(source.providerSourceRef) &&
      !source.url && !source.embedUrl && !Object.keys(source.headers || {}).length) return source;
  if (!source.url) {
    if (!source.embedUrl) return null;
    // TimStreams already verifies the underlying live manifest before returning
    // its stable watch page. Other embedded providers are checked for an online
    // HTTPS response so dead event pages do not appear as selectable broadcasts.
    if (provider === "timstreams" || provider === "dlstreams" || source.provider === "DLStreams") return source;
    try {
      const embedHost = runCatchingUrlHost(source.embedUrl);
      const isPpvSource = provider === "ppv" || source.name.startsWith("PPV •") ||
        embedHost === "embedindia.st" || embedHost.endsWith(".embedindia.st") || embedHost.endsWith(".pandecocogaming.sbs");
      const response = await fetch(source.embedUrl, {
        headers: {
          Accept: "text/html",
          "User-Agent": "StreamCorner-TV-Feed/1.13",
          ...(isPpvSource ? { Referer: "https://ppv.st/" } : {}),
        },
        redirect: "follow", signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return null;
      const body = await response.text();
      return body.trim().length >= 200 ? source : null;
    } catch {
      return null;
    }
  }
  try {
    const response = await fetch(source.url, {
      headers: { Accept: "application/dash+xml,application/vnd.apple.mpegurl,application/x-mpegURL,*/*", "User-Agent": "StreamCorner-TV-Feed/1.5", ...(source.headers || {}) },
      redirect: "follow", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    const manifest = await response.text();
    if (!/^\s*(?:#EXTM3U|<\?xml[\s\S]*?<MPD|<MPD)/i.test(manifest)) return null;
    const maxHeight = maxHeightFromManifest(manifest);
    const videoRange = /dvhe|dvh1|dolby[ -]?vision/i.test(manifest) ? "DOLBY VISION"
      : /\bhlg\b|arib-std-b67|transferCharacteristics\s*=\s*["']18["']|VIDEO-RANGE\s*=\s*HLG/i.test(manifest) ? "HLG HDR"
      : /smpte2084|st2084|transferCharacteristics\s*=\s*["']16["']|VIDEO-RANGE\s*=\s*PQ/i.test(manifest) ? "HDR10/PQ" : "";
    const audioFormat = /ec\+3|eac3[-_.]?joc|\bjoc\b|dolby[ -]?atmos/i.test(manifest) ? "DOLBY ATMOS"
      : /ec-3|eac3|e-ac-3/i.test(manifest) ? "DOLBY DIGITAL+" : "";
    return { ...source, maxHeight, videoRange, audioFormat };
  } catch {
    return null;
  }
}
function runCatchingUrlHost(value) {
  try { return new URL(value).host.toLowerCase(); } catch { return ""; }
}
const NON_SPORTS_ENTERTAINMENT = /family guy|the simpsons|south park|rick and morty|cartoon|anime|movie|cinema|sitcom|tv show|reality tv/i;
const SPORTS_24X7_SIGNAL = /sports?|espn|dazn|bein|nfl|nba|wnba|mlb|nhl|mls|ncaa|uefa|fifa|football|basketball|baseball|hockey|soccer|tennis|golf|racing|motorsport|boxing|mma|ufc|wwe|aew|wrestling|cricket|rugby|cycling|snooker|darts|lacrosse/i;

function isSupportedSportsEntry(game) {
  const description = `${game.title} ${game.league} ${game.sport}`;
  if (NON_SPORTS_ENTERTAINMENT.test(description)) return false;
  return !game.is24x7 || SPORTS_24X7_SIGNAL.test(description);
}

async function main() {
const tempDirectory = await mkdtemp(join(tmpdir(), "streamcorner-scrape-"));

try {
  let previousFeedPromise;
  let previousFeedTrusted = false;
  async function loadPreviousFeed() {
    if (previousFeedPromise) return previousFeedPromise;
    previousFeedPromise = loadTrustedFeedBaseline({
      localPath: APP_FEED_OUTPUT,
      remoteUrl: PREVIOUS_FEED_URL,
    }).then(({ feed, trusted, source }) => {
      previousFeedTrusted = trusted;
      if (trusted) console.log(`Loaded trusted previous feed baseline from ${source}`);
      else console.warn("No trusted previous feed baseline is available");
      return feed;
    });
    return previousFeedPromise;
  }

  async function loadPreviousTeams() {
    const previous = await loadPreviousFeed();
    return Array.isArray(previous.teams) ? previous.teams : [];
  }

  async function fetchTeamCatalog() {
    const previous = await loadPreviousTeams();
    const previousByLeague = new Map();
    for (const team of previous) {
      const saved = previousByLeague.get(team.leagueId) || [];
      saved.push(team);
      previousByLeague.set(team.leagueId, saved);
    }
    const catalog = [];
    const errors = [];
    for (const league of teamLeagues) {
      try {
        let season = new Date().getUTCFullYear();
        const [apiSport, apiLeague] = league.path.split("/");
        const loadRefs = async () => {
          const response = await fetch(`${ESPN_CORE_API}/${apiSport}/leagues/${apiLeague}/seasons/${season}/teams?limit=100`, {
            headers: { Accept: "application/json", "User-Agent": "StreamCorner-TV-Feed/1.2" }, signal: AbortSignal.timeout(20_000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          return Array.isArray(payload?.items) ? payload.items.map((item) => String(item?.$ref || "").replace(/^http:/, "https:")).filter(Boolean) : [];
        };
        let refs = await loadRefs();
        if (refs.length < league.minimum && league.fallbackPreviousSeason) { season -= 1; refs = await loadRefs(); }
        if (refs.length < league.minimum) throw new Error(`only ${refs.length} teams`);
        const rows = [];
        for (let offset = 0; offset < refs.length; offset += 12) {
          const batch = await Promise.all(refs.slice(offset, offset + 12).map(async (ref) => {
            const teamResponse = await fetch(ref, { signal: AbortSignal.timeout(20_000) });
            if (!teamResponse.ok) throw new Error(`team returned HTTP ${teamResponse.status}`);
            return teamResponse.json();
          }));
          rows.push(...batch);
        }
        const eligibleRows = rows.filter((team) => !league.exclude?.includes(String(team.displayName || team.name || "").trim()));
        catalog.push(...eligibleRows.map((team) => ({
          id: `${league.id}:${String(team.id || team.displayName).trim()}`,
          name: String(team.displayName || team.name || "").trim(),
          leagueId: league.id,
          leagueName: league.name,
          sport: league.sport,
          region: league.region,
          logoUrl: String((team.logos || []).find((logo) => logo.rel?.includes("primary_logo_on_black_color"))?.href || (team.logos || []).find((logo) => logo.rel?.includes("default"))?.href || "").trim().replace(/^http:/, "https:"),
        })).filter((team) => team.name));
      } catch (error) {
        const saved = previousByLeague.get(league.id) || [];
        if (saved.length >= league.minimum) catalog.push(...saved);
        else errors.push(`${league.name}: ${String(error)}`);
      }
    }
    const teams = [...new Map(catalog.map((team) => [team.id, team])).values()]
      .sort((a, b) => a.region.localeCompare(b.region) || a.leagueName.localeCompare(b.leagueName) || a.name.localeCompare(b.name));
    if (errors.length) throw new Error(`Team catalog update incomplete: ${errors.join("; ")}`);
    return { teams, errors };
  }

  const now = new Date();
  const catalogCounts = {};
  let games = [];

  console.log("Fetching StreamCorner catalog from current provider domain");
  const streamCorner = await fetchStreamCornerGames(now, estimatedDurationSeconds);
  catalogCounts.streamcorner = Object.values(streamCorner.catalogCounts).reduce((sum, count) => sum + count, 0);
  if (streamCorner.error) console.warn(`StreamCorner unavailable: ${streamCorner.error}`);
  if (streamCorner.warning) console.warn(`StreamCorner runtime: ${streamCorner.warning}`);
  games.push(...streamCorner.games.filter(isSupportedSportsEntry));

  console.log("Fetching TimStreams catalog");
  const timStreams = await fetchTimStreamsGames(now, estimatedDurationSeconds);
  catalogCounts.timstreams = timStreams.catalogCount;
  if (timStreams.error) console.warn(`TimStreams unavailable: ${timStreams.error}`);
  games.push(...timStreams.games.filter(isSupportedSportsEntry));
  console.log("Fetching PPV catalog");
  const ppv = await fetchPpvGames(now);
  catalogCounts.ppv = ppv.catalogCount;
  if (ppv.error) console.warn(`PPV unavailable: ${ppv.error}`);
  games.push(...ppv.games.filter(isSupportedSportsEntry));
  console.log("Fetching DLStreams catalog");
  const dlStreams = await fetchDlStreamsGames(now);
  catalogCounts.dlstreams = dlStreams.catalogCount;
  if (dlStreams.error) console.warn(`DLStreams unavailable: ${dlStreams.error}`);
  const retainedDlStreams = dlStreams.error
    ? (Array.isArray((await loadPreviousFeed()).games) ? (await loadPreviousFeed()).games : [])
        .filter((game) => game?.is24x7 && game?.sources?.some((source) => source.provider === "DLStreams"))
    : [];
  if (retainedDlStreams.length) catalogCounts.dlstreams = retainedDlStreams.length;
  games.push(...(dlStreams.games.length ? dlStreams.games : retainedDlStreams).filter(isSupportedSportsEntry));

  console.log("Fetching Pizarra MX catalog");
  const pizarraMx = await fetchPizarraMxGames(now);
  catalogCounts.pizarramx = pizarraMx.catalogCount;
  let pizarramxRetainedGameCount = 0;
  if (pizarraMx.error) console.warn(`Pizarra MX unavailable: ${pizarraMx.error}`);
  games.push(...pizarraMx.games.filter(isSupportedSportsEntry));
  if (pizarraMx.error) {
    const previousFeed = await loadPreviousFeed();
    const previousCards = Array.isArray(previousFeed.games)
      ? previousFeed.games.filter((game) => game?.provider === "pizarramx") : [];
    const retained = retainPreviousPizarraMxGames(previousFeed, now).filter(isSupportedSportsEntry);
    if (previousCards.length) {
      const previousUpdatedAt = Date.parse(previousFeed.updatedAt || "");
      const fallbackAgeMs = now.getTime() - previousUpdatedAt;
      if (!Number.isFinite(previousUpdatedAt) || fallbackAgeMs < 0 || fallbackAgeMs > 15 * 60 * 1000 || !retained.length) {
        throw new Error(`Pizarra MX unavailable and its prior cards are too stale or invalid to carry forward (${retained.length}/${previousCards.length} retained)`);
      }
      pizarramxRetainedGameCount = retained.length;
      games.push(...retained);
      console.warn(`Pizarra MX retained ${retained.length} recent prior card(s) after fetch failure`);
    }
  }

  console.log("Fetching SportsUpa HD Main catalog");
  try {
    const sportsUpa = await collectSportsUpaMainGames({ now });
    catalogCounts.sportsupaMain = sportsUpa.length;
    games.push(...sportsUpa.filter(isSupportedSportsEntry));
  } catch {
    catalogCounts.sportsupaMain = 0;
    console.warn("SportsUpa Main catalog unavailable; omitted without changing other providers");
  }

  console.log("Fetching ESPN schedules and scoreboards");
  const schedule = await fetchMajorLeagueSchedules(now);
  console.log(`ESPN schedule coverage accepted: ${Math.round(schedule.scheduleCoverage.coverage * 100)}% (${schedule.scheduleCoverage.successfulSlots}/${schedule.scheduleCoverage.expectedSlots} league/date slots)`);
  const scheduledGames = [...new Map([...schedule.games, ...schedule.completed]
    .map((game) => [String(game.scoreboardEventId || game.id), game])).values()];
  games = attachScheduleGames(games, scheduledGames, now);
  console.log("Fetching Sports Streams catalog");
  const highfly = await fetchHighflyGames(now);
  catalogCounts.highfly = highfly.catalogCount;
  if (highfly.errors.length) console.warn(`Sports Streams: ${highfly.errors.join("; ")}`);
  const addonMatches = attachAddonSources(highfly.games, games, (game, event) => {
    const sides = eventSides(event);
    const sportKey = (value) => String(value).toLowerCase().replaceAll("-", " ")
      .replace(/^football$/, "soccer").replace(/^nfl$/, "american football").replace(/^mlb$/, "baseball");
      if (sportKey(game.sport) !== sportKey(event.sport)) return false;
      const other = eventSides(game);
      return sides.length === 2 && other.length === 2 &&
        ((similarTeam(sides[0], other[0]) && similarTeam(sides[1], other[1])) ||
         (similarTeam(sides[0], other[1]) && similarTeam(sides[1], other[0])));
  });
  let espnBroadcastSourceCount = 0;
  const channelGames = games.filter((game) => game.is24x7 && game.sources?.some((source) => source.provider === "DLStreams"));
  for (const game of games) {
    if (game.is24x7 || !Array.isArray(game.espnBroadcasts) || !game.espnBroadcasts.length) continue;
    for (const channel of findBroadcastChannelGames(game.espnBroadcasts, channelGames)) {
      for (const source of channel.sources || []) {
        const key = feedSourceKey(source);
        if (!key) continue;
        const exists = (game.sources || []).some((candidate) => feedSourceKey(candidate) === key);
        if (!exists) {
          game.sources.push({ ...source });
          espnBroadcastSourceCount += 1;
        }
      }
    }
  }
  const temporaryDlStreamsBroadcastSourceCount = attachTimeLimitedDlStreamsSources(games, now);
  espnBroadcastSourceCount += temporaryDlStreamsBroadcastSourceCount;
  const collapsedPpvMirrorCount = collapsePpvMirrors(games);
  const duplicateEventPairCount = countRemainingDuplicatePairs(games);
  if (duplicateEventPairCount > 0) throw new Error(`feed still contains ${duplicateEventPairCount} mergeable duplicate event pair(s)`);
  games.sort((a, b) => (Date.parse(a.startsAt) || 0) - (Date.parse(b.startsAt) || 0));

  const liveSources = games.filter((game) => game.status === "live").flatMap((game) => game.sources.map((source, index) => ({ game, source, index })));
  let capabilityIndex = 0;
  await Promise.all(Array.from({ length: Math.min(8, liveSources.length) }, async () => {
    while (true) {
      const jobIndex = capabilityIndex++;
      if (jobIndex >= liveSources.length) return;
      const item = liveSources[jobIndex];
      item.game.sources[item.index] = await inspectStreamCapabilities(item.source, item.game.provider);
    }
  }));
  games.forEach((game) => { game.sources = game.sources.filter(Boolean); });
  const qualityFilter = filterKnownStandardDefinitionSources(games);
  const qualityFilteredSourceCount = qualityFilter.excludedSourceCount;
  const intentionallyExcludedSdSourceKeys = qualityFilter.excludedSourceKeys;
  const qualityFilteredSourcesByProvider = qualityFilter.excludedSourcesByProvider;
  // Only a successfully verified add-on source may replace a working PPV entry.
  const addonPpvDuplicatesRemoved = await preferAddonOverPpv(games);
  games.forEach((game) => {
    const seen = new Set();
    const rank = (source) => ({ StreamCorner: 0, "Sports Streams": 1, TimStreams: 2, PPV: 3, DLStreams: 4 })[source.provider] ?? 5;
    game.sources = game.sources.sort((a, b) => rank(a) - rank(b))
      .filter((source) => {
        const key = feedSourceKey(source);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  });
  games = games.filter((game) => !["highfly", "streamcorner"].includes(game.provider) || game.sources.length);
  const provenanceErrors = sourceProvenanceErrors(games);
  if (provenanceErrors.length) {
    throw new Error(`source provenance validation failed (${provenanceErrors.length}): ${provenanceErrors.slice(0, 5).join("; ")}`);
  }

  const sourceCoverage = compareFeedSourceCoverage(await loadPreviousFeed(), games, now, {
    intentionallyExcludedSdSourceKeys,
    finalEventIds: schedule.scores.filter((score) => score.state === "post").map((score) => score.id),
  });
  if (sourceCoverage.materialLoss) {
    throw new Error(`refusing feed after material time-valid source loss (${sourceCoverage.currentSourceCount}/${sourceCoverage.previousSourceCount} active sources remain)`);
  }

  const directStreams = games.flatMap((game) => game.sources
    .filter((source) => source.url)
    .map((source) => ({
      gameId: game.id,
      title: game.title,
      sourceName: source.name,
      url: source.url,
      clearKey: source.clearKey,
    })));
  const m3u8 = directStreams.filter((stream) => /\.m3u8(?:$|\?)/i.test(stream.url));

  const teamCatalog = await fetchTeamCatalog();
  const feed = {
    updatedAt: now.toISOString(),
    feedSchemaVersion: 2,
    eventsDeduplicated: true,
    finalEventsFiltered: true,
    catalogCounts,
    teams: teamCatalog.teams,
    games,
    scores: schedule.scores,
  };
  const scrape = {
    sourceCoverage,
    qualityFilteredSourceCount,
    qualityFilteredSourcesByProvider,
    scheduleCoverage: schedule.scheduleCoverage,
    pizarramxError: pizarraMx.error,
    pizarramxRetainedGameCount,
    highflyCatalogCount: highfly.catalogCount,
    highflySourceCount: games.flatMap((game) => game.sources).filter((source) => source.provider === "Sports Streams").length,
    addonPpvDuplicatesRemoved,
    espnBroadcastSourceCount,
    temporaryDlStreamsBroadcastSourceCount,
    ambiguousAddonEvents: addonMatches.ambiguous,
    unmatchedAddonEvents: addonMatches.unmatched,
    highflyErrors: highfly.errors,
    streamCornerError: streamCorner.error,
    streamCornerWarning: streamCorner.warning,
    streamCornerDecoderUrl: streamCorner.decoderUrl,
    scrapedAt: now.toISOString(),
    timStreamsApiUrl: timStreams.apiUrl,
    timStreamsResolvedStreamCount: timStreams.resolvedStreamCount,
    ppvApiUrl: ppv.apiUrl,
    ppvPlayableCount: ppv.playableCount,
    dlStreamsPlayableCount: dlStreams.playableCount,
    catalogCounts,
    gameCount: games.length,
    directStreamCount: directStreams.length,
    m3u8Count: m3u8.length,
    m3u8,
    otherDirectStreams: directStreams.filter((stream) => !/\.m3u8(?:$|\?)/i.test(stream.url)),
  };

  await mkdir(dirname(APP_FEED_OUTPUT), { recursive: true });
  await mkdir(dirname(SCRAPE_OUTPUT), { recursive: true });
  await writeFile(APP_FEED_OUTPUT, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
  await writeFile(SCRAPE_OUTPUT, `${JSON.stringify(scrape, null, 2)}\n`, "utf8");

  if (STATUS_OUTPUT) {
    await mkdir(dirname(STATUS_OUTPUT), { recursive: true });
    await writeFile(STATUS_OUTPUT, `${JSON.stringify({
      updatedAt: now.toISOString(),
      gameCount: games.length,
      directStreamCount: directStreams.length,
      m3u8Count: m3u8.length,
      sourceCoverage,
      qualityFilteredSourceCount,
      qualityFilteredSourcesByProvider,
      scheduleCoverage: schedule.scheduleCoverage,
      streamCornerError: streamCorner.error,
      streamCornerWarning: streamCorner.warning,
      streamCornerSourceCount: games.flatMap((game) => game.sources).filter((source) => source.provider === "StreamCorner").length,
      streamCornerDecoderUrl: streamCorner.decoderUrl,
      pizarramxError: pizarraMx.error,
      pizarramxRetainedGameCount,
      timStreamsResolvedStreamCount: timStreams.resolvedStreamCount,
      ppvPlayableCount: ppv.playableCount,
      dlStreamsPlayableCount: dlStreams.playableCount,
      teamCount: teamCatalog.teams.length,
      scoreCount: schedule.scores.length,
      liveScoreCount: schedule.scores.filter((score) => score.state === "in").length,
      duplicateEventPairCount,
      sourceProvenanceErrorCount: provenanceErrors.length,
      collapsedPpvMirrorCount,
      highflySourceCount: games.flatMap((game) => game.sources).filter((source) => source.provider === "Sports Streams").length,
      addonPpvDuplicatesRemoved,
      espnBroadcastSourceCount,
      temporaryDlStreamsBroadcastSourceCount,
      unmatchedAddonEvents: addonMatches.unmatched,
      highflyErrors: highfly.errors,
      teamCatalogErrors: teamCatalog.errors,
    }, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    sourceCoverage,
    qualityFilteredSourceCount,
    qualityFilteredSourcesByProvider,
    scheduleCoverage: schedule.scheduleCoverage,
    streamCornerError: streamCorner.error,
    pizarramxError: pizarraMx.error,
    pizarramxRetainedGameCount,
    catalogCounts,
    gameCount: games.length,
    directStreamCount: directStreams.length,
    m3u8Count: m3u8.length,
    timStreamsResolvedStreamCount: timStreams.resolvedStreamCount,
    ppvPlayableCount: ppv.playableCount,
    dlStreamsPlayableCount: dlStreams.playableCount,
    teamCount: teamCatalog.teams.length,
    scoreCount: schedule.scores.length,
    liveScoreCount: schedule.scores.filter((score) => score.state === "in").length,
    duplicateEventPairCount,
    sourceProvenanceErrorCount: provenanceErrors.length,
    collapsedPpvMirrorCount,
    highflySourceCount: games.flatMap((game) => game.sources).filter((source) => source.provider === "Sports Streams").length,
    addonPpvDuplicatesRemoved,
    espnBroadcastSourceCount,
    temporaryDlStreamsBroadcastSourceCount,
    unmatchedAddonEvents: addonMatches.unmatched,
    highflyErrors: highfly.errors,
    teamCatalogErrors: teamCatalog.errors,
    feedOutput: APP_FEED_OUTPUT,
    scrapeOutput: SCRAPE_OUTPUT,
  }, null, 2));
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
