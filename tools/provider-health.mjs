// Publisher observations only: source references do not prove successful playback.
const PROVIDERS = [
  ["StreamCorner", "streamcorner"],
  ["TimStreams", "timstreams"],
  ["PPV", "ppv"],
  ["DLStreams", "dlstreams"],
  ["SportsUpa", "sportsupa"],
  ["Sports Streams", "highfly"],
];

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function buildProviderHealth({ games = [], catalogCounts = {}, collectors = {}, sportsUpaFailures = {} } = {}) {
  const sources = games.flatMap((game) => Array.isArray(game.sources) ? game.sources : []);
  return Object.fromEntries(PROVIDERS.map(([provider, key]) => {
    const collector = collectors[key] || {};
    const catalogCount = key === "sportsupa"
      ? count(catalogCounts.sportsupaMain) + count(catalogCounts.sportsupaAdmin)
      : count(catalogCounts[key]);
    const sourceCount = sources.filter((source) => source?.provider === provider).length;
    const failedSportsUpaCollectors = [sportsUpaFailures.main, sportsUpaFailures.admin].filter(Boolean).length;
    const failed = key === "sportsupa" ? failedSportsUpaCollectors > 0
      : key === "streamcorner" && typeof collector.collectionFailed === "boolean"
        ? collector.collectionFailed : Boolean(collector.error || collector.errors?.length);
    const partialFailure = key === "sportsupa" && failedSportsUpaCollectors === 1;
    const state = failed
      ? (sourceCount || catalogCount || partialFailure ? "degraded" : "unavailable")
      : sourceCount ? "available" : "no-playable-sources";
    // Select fixed strings; never publish collector errors, URLs, or installation data.
    const diagnostic = state === "unavailable" ? "Collector failed; no current catalog or published source references."
      : state === "degraded" ? "Collector failure; partial catalog or source coverage may remain."
      : state === "available" ? "Source references published; playback is not verified by this status."
      : "No current source references published; no collector failure reported.";
    return [provider, { state, catalogCount, sourceCount, diagnostic }];
  }));
}
