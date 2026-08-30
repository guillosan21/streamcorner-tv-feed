// Stremio's public catalog/stream API; no premium endpoints or HTML scraping.
export const HIGHFLY_ORIGIN = "https://sportsfree-us2.highfly.dev";
export const HIGHFLY_PROVIDER = "Sports Streams";

async function json(path, fetcher) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetcher(`${HIGHFLY_ORIGIN}${path}`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 429 && attempt < 2) {
      const retry = response.headers?.get("retry-after");
      const seconds = retry && Number.isFinite(Number(retry)) ? Number(retry) :
        retry && Number.isFinite(Date.parse(retry)) ? (Date.parse(retry) - Date.now()) / 1000 : 30;
      if (seconds > 60) throw new Error(`add-on rate limited; retry after ${seconds}s`);
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, seconds) * 1000));
      continue;
    }
    if (!response.ok) throw new Error(`add-on HTTP ${response.status}`);
    return response.json();
  }
}

export function addonSources(streams) {
  const seen = new Set();
  return (Array.isArray(streams) ? streams : []).flatMap((stream) => {
    // notWebReady is expected for native HLS. externalUrl, torrents and upgrade
    // placeholder URLs are not playable media and must never become sources.
    let url;
    try { url = new URL(stream.url); } catch { return []; }
    if (url.protocol !== "https:" || url.username || url.password ||
        !/\.(m3u8|mpd)$/i.test(url.pathname) || seen.has(url.href)) return [];
    if (/upgrade|🔒/i.test(`${stream.name || ""} ${stream.title || ""}`)) return [];
    seen.add(url.href);
    const headers = {};
    for (const [name, value] of Object.entries(stream.behaviorHints?.proxyHeaders?.request || {})) {
      const canonical = { referer: "Referer", origin: "Origin", "user-agent": "User-Agent" }[name.toLowerCase()];
      if (canonical && typeof value === "string" && value.length <= 2000 && !/[\r\n]/.test(value)) headers[canonical] = value;
    }
    return [{ provider: HIGHFLY_PROVIDER, name: `${HIGHFLY_PROVIDER} • ${String(stream.name || "Live feed").trim()}`,
      url: url.href, embedUrl: "", clearKey: "", headers }];
  });
}

export async function fetchHighflyGames(now, fetcher = fetch) {
  const metas = new Map();
  const errors = [];
  try {
    // Page offsets use raw page size, not the count remaining after channel filtering.
    for (let skip = 0, page = 0; page < 10; page++) {
      const payload = await json(`/catalog/sport/sports_live${skip ? `/skip=${skip}` : ""}.json`, fetcher);
      const rows = Array.isArray(payload.metas) ? payload.metas : [];
      if (!rows.length) break;
      let added = 0;
      for (const meta of rows) {
        if (!metas.has(meta.id)) { metas.set(meta.id, meta); added++; }
      }
      if (!added) break; // Some servers ignore skip; do not loop forever.
      skip += rows.length;
    }
  } catch (error) { errors.push(String(error.message)); }
  const events = [...metas.values()].filter((meta) =>
    /^(streamed|sf):/.test(String(meta.id)) && meta.type === "sport" &&
    /^LIVE$/i.test(String(meta.releaseInfo)) && String(meta.name || "").trim());
  const games = new Array(events.length);
  let index = 0;
  // The public server rate-limits stream resolution. Serialize these requests
  // instead of bursting alongside the other provider scrapers.
  await Promise.all(Array.from({ length: Math.min(1, events.length) }, async () => {
    while (index < events.length) {
      if (fetcher === fetch && index > 0) await new Promise((resolve) => setTimeout(resolve, 1500));
      const position = index++;
      const meta = events[position];
      try {
        const payload = await json(`/stream/sport/${encodeURIComponent(meta.id)}.json`, fetcher);
        const sources = addonSources(payload.streams);
        if (!sources.length) continue;
        const rawSport = String(meta.category || meta.genres?.[0] || "Sports").toLowerCase();
        const sport = ({ football: "Soccer", soccer: "Soccer", "american-football": "American Football",
          "american football": "American Football", fight: "Combat Sports" })[rawSport] || rawSport;
        games[position] = {
          id: `highfly-${meta.id}`, provider: "highfly", sourceId: meta.id,
          title: String(meta.name).trim(), sport, league: sport,
          // The catalog omits kickoff. These are candidates only: the feed must
          // attach their sources to a unique official ESPN event before publishing.
          startsAt: "",
          status: "live", is24x7: false, sources,
          posterUrl: String(meta.background || meta.poster || ""),
        };
      } catch (error) { errors.push(`${meta.id}: ${error.message}`); }
    }
  }));
  return { games: games.filter(Boolean), catalogCount: events.length, errors };
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    url.hash = "";
    url.searchParams.sort(); // Preserve signatures and stream-selection parameters.
    return url.href;
  } catch { return ""; }
}

export function attachAddonSources(events, games, matchupMatches) {
  let ambiguous = 0;
  let unmatched = 0;
  for (const event of events) {
    const candidates = games.filter((game) => !game.is24x7 && game.status === "live" &&
      game.scoreboardEventId && Number.isFinite(Date.parse(game.startsAt)) && matchupMatches(game, event));
    if (candidates.length === 1) candidates[0].sources.push(...event.sources);
    else if (candidates.length > 1) ambiguous++;
    else unmatched++;
  }
  return { ambiguous, unmatched };
}

// Evidence is local to this scrape; session URLs and segment lists are not published.
export async function playbackEvidence(source, fetcher = fetch) {
  const urls = new Set();
  const segments = new Set();
  const headers = { ...(source.provider === "PPV" ? { Referer: "https://ppv.st/" } : {}), ...source.headers };
  const visit = async (value, depth) => {
    const address = canonicalUrl(value);
    if (!address || urls.has(address) || depth > 2) return;
    urls.add(address);
    try {
      const response = await fetcher(address, { headers, redirect: "follow", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return;
      const base = response.url || address;
      urls.add(canonicalUrl(base));
      const body = await response.text();
      if (body.trimStart().startsWith("#EXTM3U")) {
        const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (body.includes("#EXT-X-STREAM-INF:")) {
          const variants = lines.filter((line) => !line.startsWith("#"));
          // Inspect all small variant sets, rather than conflating one game with one rendition.
          await Promise.all(variants.slice(0, 6).map((line) => visit(new URL(line, base).href, depth + 1)));
        } else {
          for (const line of lines.filter((line) => !line.startsWith("#"))) {
            segments.add(canonicalUrl(new URL(line, base).href));
          }
        }
      } else if (!source.url && depth === 0) {
        // Only explicit media URLs, never arbitrary iframes/ad links. JS-only
        // resolution remains unknown, not evidence that two streams are duplicates.
        const decoded = body.replaceAll("\\/", "/").replaceAll("&amp;", "&");
        const media = [...decoded.matchAll(/["'](https:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)["']/gi)];
        await Promise.all(media.slice(0, 4).map((match) => visit(match[1], 1)));
      }
    } catch { /* Missing evidence must not remove a source. */ }
  };
  await visit(source.url || source.embedUrl, 0);
  return { urls, segments };
}

export function samePlayback(first, second) {
  if ([...first.urls].some((url) => url && second.urls.has(url))) return true;
  return [...first.segments].filter((url) => url && second.segments.has(url)).length >= 2;
}

export async function preferAddonOverPpv(games, resolver = playbackEvidence) {
  let removed = 0;
  for (const game of games) {
    const addon = game.sources.filter((source) => source.provider === HIGHFLY_PROVIDER);
    const ppv = game.sources.filter((source) => source.provider === "PPV");
    if (!addon.length || !ppv.length) continue;
    const evidence = await Promise.all([...addon, ...ppv].map((source) => resolver(source)));
    const duplicate = new Set(ppv.filter((_, i) => evidence.slice(0, addon.length)
      .some((item) => samePlayback(item, evidence[addon.length + i]))));
    removed += duplicate.size;
    game.sources = game.sources.filter((source) => !duplicate.has(source));
  }
  return removed;
}
