import { feedSourceKey } from "./playback-identity.mjs";

export function isKnownStandardDefinition(source) {
  const height = source?.maxHeight;
  return source?.hd === false || (typeof height === "number" && Number.isFinite(height) && height >= 1 && height < 720);
}

export function filterKnownStandardDefinitionSources(games) {
  let excludedSourceCount = 0;
  const excludedSourcesByProvider = {};
  const excludedSourceKeys = new Set();

  for (const game of Array.isArray(games) ? games : []) {
    if (!Array.isArray(game?.sources)) continue;
    game.sources = game.sources.filter((source) => {
      if (!isKnownStandardDefinition(source)) return true;
      excludedSourceCount += 1;
      const provider = typeof source?.provider === "string" && source.provider ? source.provider : "Unknown";
      excludedSourcesByProvider[provider] = (excludedSourcesByProvider[provider] || 0) + 1;
      const key = feedSourceKey(source);
      if (key) excludedSourceKeys.add(key);
      return false;
    });
  }

  return { excludedSourceCount, excludedSourcesByProvider, excludedSourceKeys: [...excludedSourceKeys] };
}

export function maxHeightFromManifest(manifest) {
  if (typeof manifest !== "string") return 0;
  const heights = [...manifest.matchAll(/(?:height\s*=\s*["'](\d+)["']|RESOLUTION\s*=\s*\d+x(\d+))/gi)]
    .map((match) => Number(match[1] || match[2] || 0));
  return Math.max(0, ...heights);
}
