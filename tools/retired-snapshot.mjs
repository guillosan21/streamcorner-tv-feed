import { isDeepStrictEqual } from "node:util";
import { isSportsUpaAdminSource } from "./sportsupa.mjs";

export function isRetiredSource(source) {
  const labels = [source?.provider, source?.embedProvider, String(source?.name || "").split("•", 1)[0]];
  if (labels.some((label) => String(label || "").trim().toLowerCase() === "streamed")) return true;
  if (String(source?.providerSourceRef || "").toLowerCase().startsWith("streamed:")) return true;
  if (isSportsUpaAdminSource(source)) return false;
  return [source?.url, source?.embedUrl].some((value) => {
    try {
      const parsed = new URL(String(value || ""));
      return parsed.hostname.toLowerCase() === "embed.st" &&
        !parsed.pathname.toLowerCase().startsWith("/embed/ingest/") &&
        (parsed.pathname.toLowerCase().startsWith("/embed/admin/") ||
         /^\/embed\/[a-z0-9_-]{1,64}\/[a-z0-9_-]{1,128}\/[0-9]{1,2}\/?$/i.test(parsed.pathname));
    } catch {
      return false;
    }
  });
}

export function deriveRetiredSourceSnapshot(feed, status) {
  const sanitizedFeed = structuredClone(feed);
  const sanitizedStatus = structuredClone(status);
  let removedSourceCount = 0;
  let removedGameCount = 0;
  const removedSourceProviderCounts = {};

  for (const game of Array.isArray(sanitizedFeed.games) ? sanitizedFeed.games : []) {
    if (!Array.isArray(game.sources)) continue;
    game.sources = game.sources.filter((source) => {
      if (!isRetiredSource(source)) return true;
      removedSourceCount += 1;
      const provider = typeof source?.provider === "string" && source.provider ? source.provider : "Unknown";
      removedSourceProviderCounts[provider] = (removedSourceProviderCounts[provider] || 0) + 1;
      return false;
    });
  }

  // The previous snapshot already removed sources, so its retired-only cards are empty.
  // Keep unrelated source-less schedule rows and mixed-provider games intact.
  sanitizedFeed.games = sanitizedFeed.games.filter((game) => {
    const retiredOnlyCard = String(game?.provider || "").toLowerCase() === "streamed" &&
      Array.isArray(game.sources) && game.sources.length === 0;
    if (retiredOnlyCard) removedGameCount += 1;
    return !retiredOnlyCard;
  });
  if (removedGameCount && Object.hasOwn(sanitizedStatus, "gameCount")) {
    sanitizedStatus.gameCount = sanitizedFeed.games.length;
  }

  if (sanitizedFeed.catalogCounts && Object.hasOwn(sanitizedFeed.catalogCounts, "streamed")) {
    delete sanitizedFeed.catalogCounts.streamed;
  }

  delete sanitizedStatus.streamedErrors;
  delete sanitizedStatus.streamedCatalogCounts;
  const providerQualityCounts = sanitizedStatus.qualityFilteredSourcesByProvider;
  if (providerQualityCounts && Object.hasOwn(providerQualityCounts, "Streamed")) {
    const retiredQualityCount = Number(providerQualityCounts.Streamed);
    delete providerQualityCounts.Streamed;
    if (Object.hasOwn(sanitizedStatus, "qualityFilteredSourceCount") && Number.isFinite(retiredQualityCount)) {
      const totalQualityCount = Number(sanitizedStatus.qualityFilteredSourceCount);
      if (!Number.isFinite(totalQualityCount) || totalQualityCount < retiredQualityCount) {
        throw new Error("Streamed quality-filter count exceeds the total quality-filter count");
      }
      sanitizedStatus.qualityFilteredSourceCount = totalQualityCount - retiredQualityCount;
    }
  }

  return {
    feed: sanitizedFeed,
    status: sanitizedStatus,
    removedSourceCount,
    removedGameCount,
    removedSourceProviderCounts,
  };
}

export function assertRetiredSnapshotMatchesCurrent(currentFeed, currentStatus, candidateFeed, candidateStatus, {
  requireRetiredSources = true,
  requireRetiredGames = false,
} = {}) {
  const expected = deriveRetiredSourceSnapshot(currentFeed, currentStatus);
  if (requireRetiredSources && expected.removedSourceCount === 0) {
    throw new Error("the currently served feed has no retired sources to remove");
  }
  if (requireRetiredGames && expected.removedGameCount === 0) {
    throw new Error("the currently served feed has no retired-only cards to remove");
  }
  if (candidateFeed?.updatedAt !== currentFeed?.updatedAt || candidateStatus?.updatedAt !== currentStatus?.updatedAt) {
    throw new Error("sanitized snapshot must preserve the currently served feed and status timestamps");
  }
  if (!isDeepStrictEqual(candidateFeed, expected.feed) || !isDeepStrictEqual(candidateStatus, expected.status)) {
    throw new Error("sanitized snapshot contains changes beyond retired source and metric removal");
  }
  return {
    updatedAt: currentFeed.updatedAt,
    removedSourceCount: expected.removedSourceCount,
    removedGameCount: expected.removedGameCount,
    removedSourceProviderCounts: expected.removedSourceProviderCounts,
  };
}
