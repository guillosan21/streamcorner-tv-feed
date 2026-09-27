import { isDeepStrictEqual } from "node:util";

function isRetiredSource(source) {
  if (source?.provider === "Streamed" || source?.embedProvider === "Streamed") return true;
  try {
    return new URL(String(source?.embedUrl || "")).hostname.toLowerCase() === "embed.st";
  } catch {
    return false;
  }
}

export function deriveRetiredSourceSnapshot(feed, status) {
  const sanitizedFeed = structuredClone(feed);
  const sanitizedStatus = structuredClone(status);
  let removedSourceCount = 0;
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
    removedSourceProviderCounts,
  };
}

export function assertRetiredSnapshotMatchesCurrent(currentFeed, currentStatus, candidateFeed, candidateStatus, {
  requireRetiredSources = true,
} = {}) {
  const expected = deriveRetiredSourceSnapshot(currentFeed, currentStatus);
  if (requireRetiredSources && expected.removedSourceCount === 0) {
    throw new Error("the currently served feed has no retired sources to remove");
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
    removedSourceProviderCounts: expected.removedSourceProviderCounts,
  };
}
