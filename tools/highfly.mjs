// Stremio's public catalog/stream API; no premium endpoints or HTML scraping.
export const HIGHFLY_ORIGIN = "https://sportsfree-us2.highfly.dev";
export const HIGHFLY_PROVIDER = "Sports Streams";

/** Personal installations are server-side configuration, never feed metadata. */
export function addonApiConfiguration(manifestUrl = "") {
  if (!manifestUrl) return { base: HIGHFLY_ORIGIN, privateMarkers: [] };
  const match = /^https:\/\/sports\.highfly\.to\/([A-Za-z0-9_-]{8,1024})\/manifest\.json$/.exec(manifestUrl);
  if (!match) throw new Error("Sports Streams installation configuration is invalid");
  let config;
  try {
    const decoded = Buffer.from(match[1], "base64url");
    if (decoded.toString("base64url") !== match[1]) throw new Error("Invalid encoding");
    config = JSON.parse(decoded.toString("utf8"));
  }
  catch { throw new Error("Sports Streams installation configuration is invalid"); }
  if (typeof config?.freeUserId !== "string" || !config.freeUserId || config.freeUserId.length > 512) {
    throw new Error("Sports Streams installation configuration is invalid");
  }
  return { base: manifestUrl.slice(0, -"/manifest.json".length), privateMarkers: [match[1], config.freeUserId] };
}

function containsInstallation(value, markers) {
  if (!markers.length || value == null) return false;
  if (typeof value === "object") {
    return Object.entries(value).some(([key, child]) => containsInstallation(key, markers) || containsInstallation(child, markers));
  }
  if (typeof value !== "string") return false;
  let text = value;
  for (let pass = 0; pass < 8; pass++) {
    if (markers.some((marker) => text.includes(marker))) return true;
    // Decode valid runs independently: an unrelated literal '%' must not stop inspection.
    const decoded = text.replace(/(?:%[0-9a-f]{2})+/gi, (run) =>
      Buffer.from(run.replace(/%/g, ""), "hex").toString("utf8"));
    if (decoded === text) return false;
    text = decoded;
  }
  return true; // Excessively nested encoding is not safe publication metadata.
}

async function json(path, fetcher, base) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetcher(`${base}${path}`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000), redirect: "error",
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
    if (/upgrade|premium|\bsetup\b|\bconfigure\b|reinstall the addon|🔒/i.test(`${stream.name || ""} ${stream.title || ""}`)) return [];
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

export async function fetchHighflyGames(now, fetcher = fetch, { manifestUrl = process.env.SPORTS_STREAMS_MANIFEST_URL || "" } = {}) {
  const metas = new Map();
  const errors = [];
  let config;
  try { config = addonApiConfiguration(manifestUrl); }
  catch { return { games: [], catalogCount: 0, errors: ["Sports Streams installation configuration is invalid"] }; }
  try {
    // Page offsets use raw page size, not the count remaining after channel filtering.
    for (let skip = 0, page = 0; page < 10; page++) {
      const payload = await json(`/catalog/sport/sports_live${skip ? `/skip=${skip}` : ""}.json`, fetcher, config.base);
      const rows = Array.isArray(payload.metas) ? payload.metas : [];
      if (!rows.length) break;
      let added = 0;
      for (const meta of rows) {
        if (!metas.has(meta.id)) { metas.set(meta.id, meta); added++; }
      }
      if (!added) break; // Some servers ignore skip; do not loop forever.
      skip += rows.length;
    }
  } catch { errors.push("Sports Streams catalog request failed"); }
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
        const payload = await json(`/stream/sport/${encodeURIComponent(meta.id)}.json`, fetcher, config.base);
        const sources = addonSources(payload.streams).filter((source) => !containsInstallation(source, config.privateMarkers));
        if (!sources.length && (Array.isArray(payload.streams) ? payload.streams : []).some((stream) => /reinstall the addon/i.test(stream?.name || ""))) {
          errors.push("Sports Streams requires verified installation configuration");
        }
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
      } catch { errors.push("Sports Streams event stream request failed"); }
    }
  }));
  return { games: games.filter((game) => game && !containsInstallation(game, config.privateMarkers)), catalogCount: events.length, errors };
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

export function attachAddonSources(events, games, matchupMatches, now = new Date()) {
  const nowMillis = now.getTime();
  let ambiguous = 0;
  let unmatched = 0;
  for (const event of events) {
    const candidates = games.filter((game) => {
      const starts = Date.parse(game.startsAt);
      const ends = Date.parse(game.endsAt);
      // An untimed provider LIVE entry proves source availability, not that the
      // match has started. Bind it only to one official live game or a nearby
      // upcoming fixture; do not attach it to a return leg weeks in the future.
      const eligible = game.status === "live" || (game.status === "upcoming" &&
        Number.isFinite(nowMillis) && starts >= nowMillis - 24 * 60 * 60_000 && starts <= nowMillis + 24 * 60 * 60_000 &&
        (starts >= nowMillis - 15 * 60_000 || ends > nowMillis));
      return !game.is24x7 && eligible && game.scoreboardEventId &&
        Number.isFinite(starts) && matchupMatches(game, event);
    });
    if (candidates.length === 1) {
      const game = candidates[0];
      game.sources.push(...event.sources.map(source => game.status === "upcoming"
        ? { ...source, availableBeforeKickoff: true } : source));
    }
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
