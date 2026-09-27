import { readFile } from "node:fs/promises";

/** A usable baseline must have the current feed shape and source-bearing games. */
export function isTrustedFeedBaseline(feed) {
  if (!feed || typeof feed !== "object" || Array.isArray(feed) || feed.feedSchemaVersion !== 2 ||
      !Number.isFinite(Date.parse(feed.updatedAt || "")) || !Array.isArray(feed.games) || feed.games.length === 0) return false;
  const validGames = feed.games.every((game) => game && typeof game === "object" && !Array.isArray(game) &&
    typeof game.id === "string" && Array.isArray(game.sources) && game.sources.every((source) =>
      source && typeof source === "object" && !Array.isArray(source) && typeof source.provider === "string"));
  return validGames && feed.games.some((game) => game.sources.length > 0);
}

export function assertDecoderFallbackHasTrustedBaseline(decoderError, baselineTrusted) {
  if (decoderError && !baselineTrusted) {
    throw new Error("StreamCorner decoder unavailable and no trusted previous feed baseline could be loaded; refusing to publish a potentially incomplete feed");
  }
}

const STRICT_STREAMCORNER_BASELINE_AGE_MS = 15 * 60 * 1000;

/** Enforces lost source identities only when the decoder baseline is recent enough to verify them. */
export function assessStreamCornerDecoderFallback({
  decoderError,
  baselineTrusted,
  baselineUpdatedAt,
  missingSourceCount = 0,
  previousActiveCount = 0,
  now = new Date(),
} = {}) {
  assertDecoderFallbackHasTrustedBaseline(decoderError, baselineTrusted);
  if (!decoderError) {
    return { degraded: false, staleBaseline: false, baselineAgeMs: null, enforcedMissingSourceThreshold: null };
  }

  const nowMs = new Date(now).getTime();
  const baselineMs = Date.parse(baselineUpdatedAt || "");
  if (!Number.isFinite(nowMs) || !Number.isFinite(baselineMs) || baselineMs > nowMs) {
    throw new Error("StreamCorner decoder unavailable and previous feed timestamp is invalid or in the future; refusing to publish");
  }

  const baselineAgeMs = nowMs - baselineMs;
  const staleBaseline = baselineAgeMs > STRICT_STREAMCORNER_BASELINE_AGE_MS;
  const enforcedMissingSourceThreshold = staleBaseline
    ? null
    : Math.max(5, Math.ceil(previousActiveCount * 0.2));
  if (!staleBaseline && missingSourceCount >= enforcedMissingSourceThreshold) {
    throw new Error(`StreamCorner decoder unavailable; refusing feed with ${missingSourceCount} of ${previousActiveCount} still-active prior StreamCorner sources missing`);
  }

  return {
    degraded: true,
    staleBaseline,
    baselineAgeMs,
    missingSourceCount,
    previousActiveCount,
    enforcedMissingSourceThreshold,
  };
}

/** Loads a structurally trusted local/deployed baseline, exposing failure to safety gates. */
export async function loadTrustedFeedBaseline({
  localPath,
  remoteUrl,
  readLocal = readFile,
  fetcher = globalThis.fetch,
  timeoutMs = 15_000,
  cacheBuster = Date.now(),
} = {}) {
  const errors = [];
  try {
    const local = JSON.parse(await readLocal(localPath, "utf8"));
    if (isTrustedFeedBaseline(local)) return { feed: local, trusted: true, source: "local", errors };
    errors.push("local baseline failed schema validation");
  } catch (error) {
    errors.push(`local baseline unavailable: ${String(error?.message || "read or parse failed")}`);
  }

  try {
    if (typeof fetcher !== "function") throw new Error("fetch unavailable");
    const separator = String(remoteUrl || "").includes("?") ? "&" : "?";
    const response = await fetcher(`${remoteUrl}${separator}previous=${encodeURIComponent(cacheBuster)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) throw new Error(`HTTP ${Number(response?.status) || 0}`);
    const remote = await response.json();
    if (!isTrustedFeedBaseline(remote)) throw new Error("remote baseline failed schema validation");
    return { feed: remote, trusted: true, source: "remote", errors };
  } catch (error) {
    errors.push(`remote baseline unavailable: ${String(error?.message || "fetch or parse failed")}`);
  }
  return { feed: {}, trusted: false, source: "none", errors };
}
