import { readFile } from "node:fs/promises";
import { assertRetiredSnapshotMatchesCurrent } from "./retired-snapshot.mjs";

const currentFeedUrl = process.env.PREVIOUS_FEED_URL ||
  "https://guillosan21.github.io/streamcorner-tv-feed/games.json";
const currentStatusUrl = new URL("status.json", currentFeedUrl).href;

async function loadJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

const [currentFeed, currentStatus, candidateFeedText, candidateStatusText] = await Promise.all([
  loadJson(currentFeedUrl),
  loadJson(currentStatusUrl),
  readFile("site/games.json", "utf8"),
  readFile("site/status.json", "utf8"),
]);
const candidateFeed = JSON.parse(candidateFeedText);
const candidateStatus = JSON.parse(candidateStatusText);
const result = assertRetiredSnapshotMatchesCurrent(currentFeed, currentStatus, candidateFeed, candidateStatus);

const sourceCounts = {};
for (const game of candidateFeed.games || []) {
  for (const source of game.sources || []) {
    sourceCounts[source.provider] = (sourceCounts[source.provider] || 0) + 1;
  }
}
if (sourceCounts.Streamed || candidateFeed.catalogCounts?.streamed !== undefined ||
    candidateStatus.streamedErrors !== undefined || candidateStatus.streamedCatalogCounts !== undefined ||
    candidateStatus.qualityFilteredSourcesByProvider?.Streamed !== undefined) {
  throw new Error("sanitized snapshot still contains retired provider output or status");
}

console.log(JSON.stringify({
  ...result,
  gameCount: candidateFeed.games?.length || 0,
  sourceCounts,
}, null, 2));
