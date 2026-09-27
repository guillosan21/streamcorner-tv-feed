import { feedSourceKey } from "./playback-identity.mjs";
import { isKnownStandardDefinition } from "./stream-quality.mjs";

const DEFAULT_MIN_PREVIOUS_SOURCES = 20;
const DEFAULT_MAX_LOSS_RATIO = 0.5;
const RECENT_FEED_MS = 15 * 60 * 1000;

function feedIsRecent(updatedAt, nowMs) {
  const updatedMs = Date.parse(updatedAt || "");
  return Number.isFinite(updatedMs) && updatedMs <= nowMs && nowMs - updatedMs <= RECENT_FEED_MS;
}

function gameIsTimeValid(game, nowMs, recentFeed) {
  if (!game || (game.status !== "live" && game.status !== "upcoming") || game.scheduleState === "post") return false;
  const startsAt = Date.parse(game.startsAt || "");
  const endsAt = Date.parse(game.endsAt || "");
  if (game.status === "upcoming") return Number.isFinite(startsAt) && startsAt > nowMs && (!Number.isFinite(endsAt) || endsAt > nowMs);
  if (Number.isFinite(startsAt) && startsAt > nowMs) return false;
  if (Number.isFinite(endsAt)) return endsAt > nowMs;
  return Boolean(game.is24x7 && recentFeed);
}

function timeValidNonPizarraSources(games, updatedAt, nowMs) {
  const recentFeed = feedIsRecent(updatedAt, nowMs);
  const keys = new Set();
  const knownSdKeys = new Set();
  for (const game of Array.isArray(games) ? games : []) {
    if (!gameIsTimeValid(game, nowMs, recentFeed)) continue;
    for (const source of Array.isArray(game.sources) ? game.sources : []) {
      // The provider migration intentionally replaces legacy StreamCorner identities with
      // Streamed embeds. Keep the loss gate strict for every provider that remains active.
      if (source?.provider === "Pizarra MX" || source?.provider === "StreamCorner") continue;
      const key = feedSourceKey(source);
      if (!key) continue;
      if (isKnownStandardDefinition(source)) knownSdKeys.add(key);
      else keys.add(key);
    }
  }
  return { keys, knownSdKeys, allKeys: new Set([...keys, ...knownSdKeys]) };
}

/** Rejects a refresh that loses most sources still valid by event time. */
export function compareFeedSourceCoverage(previousFeed, currentGames, now = new Date(), {
  minimumPreviousSources = DEFAULT_MIN_PREVIOUS_SOURCES,
  maximumLossRatio = DEFAULT_MAX_LOSS_RATIO,
  intentionallyExcludedSdSourceKeys = [],
} = {}) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error("invalid feed coverage comparison time");
  const previous = timeValidNonPizarraSources(previousFeed?.games, previousFeed?.updatedAt, nowMs);
  const current = timeValidNonPizarraSources(currentGames, new Date(nowMs).toISOString(), nowMs);
  const intentionallyExcluded = new Set(intentionallyExcludedSdSourceKeys);
  const intentionallyExcludedPriorKeys = [...previous.allKeys].filter((key) => intentionallyExcluded.has(key));
  const previousKnownSdKeys = new Set([...previous.knownSdKeys, ...intentionallyExcludedPriorKeys]);
  const coverageBaseline = new Set([...previous.keys].filter((key) => !intentionallyExcluded.has(key)));
  const missingCount = [...coverageBaseline].filter((key) => !current.keys.has(key)).length;
  const lossRatio = coverageBaseline.size ? missingCount / coverageBaseline.size : 0;
  return {
    previousSourceCount: coverageBaseline.size,
    currentSourceCount: current.keys.size,
    missingSourceCount: missingCount,
    lossRatio,
    previousKnownSdSourceCount: previousKnownSdKeys.size,
    currentKnownSdSourceCount: current.knownSdKeys.size,
    intentionallyExcludedPriorSourceCount: intentionallyExcludedPriorKeys.length,
    materialLoss: coverageBaseline.size >= minimumPreviousSources && lossRatio > maximumLossRatio,
  };
}
