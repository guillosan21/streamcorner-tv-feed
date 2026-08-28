const TIMSTREAMS_API = "https://timstreams.st/api";
const TIMSTREAMS_SITE = "https://timstreams.st/";
const TIMSTREAMS_TIME_ZONE = "America/New_York";

function parseWallClock(value, timeZone = TIMSTREAMS_TIME_ZONE) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const absolute = new Date(raw);
    return Number.isFinite(absolute.getTime()) ? absolute : null;
  }
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const desired = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
  let guess = desired;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const rendered = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const correction = desired - rendered;
    guess += correction;
    if (correction === 0) break;
  }
  const result = new Date(guess);
  return Number.isFinite(result.getTime()) ? result : null;
}

function findHlsUrl(text) {
  const normalized = String(text || "").replaceAll("\\/", "/");
  const match = normalized.match(/https:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?/i);
  if (!match) return "";
  try {
    const url = new URL(match[0]);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function decodeEmbedPayload(html) {
  const direct = findHlsUrl(html);
  if (direct) return direct;
  const arrayMatch = String(html).match(/(_[a-z0-9]{3})\s*=\s*\[([0-9,]{100,})\]/i);
  if (!arrayMatch) return "";
  const tail = String(html).slice((arrayMatch.index || 0) + arrayMatch[0].length, (arrayMatch.index || 0) + arrayMatch[0].length + 1000);
  const constants = tail.match(/,\s*_[a-z0-9]{3}\s*=\s*(\d+)\s*,\s*_[a-z0-9]{3}\s*=\s*(\d+)/i);
  if (!constants) return "";
  const xorValue = Number(constants[1]);
  const subtraction = Number(constants[2]);
  const decoded = arrayMatch[2].split(",").map((value) =>
    String.fromCharCode(((Number(value) ^ xorValue) - subtraction + 256) % 256)).join("");
  return findHlsUrl(decoded);
}

function safeWatchUrl(event) {
  const slug = String(event?.url || "").trim().replace(/^\/+|\/+$/g, "").replace(/^watch\//, "");
  if (!slug || /(?:^|\/)\.\.(?:\/|$)/.test(slug)) return "";
  try {
    const url = new URL(`/watch/${slug}`, TIMSTREAMS_SITE);
    return url.protocol === "https:" && url.host === "timstreams.st" ? url.href : "";
  } catch {
    return "";
  }
}

async function resolveStream(stream, event, verifyLive) {
  const embedUrl = String(stream?.url || "").trim();
  const watchUrl = safeWatchUrl(event);
  if (!embedUrl.startsWith("https://") || !watchUrl || stream?.vip === true) return null;
  if (verifyLive) {
    try {
      const response = await fetch(embedUrl, {
        headers: { Accept: "text/html", Referer: TIMSTREAMS_SITE, "User-Agent": "StreamCorner-TV-Feed/1.13" },
        redirect: "follow", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const manifestUrl = decodeEmbedPayload(await response.text());
      if (!manifestUrl) return null;
      const referer = `${new URL(response.url || embedUrl).origin}/`;
      const manifestResponse = await fetch(manifestUrl, {
        headers: { Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*", Referer: referer, Origin: new URL(referer).origin },
        redirect: "follow", signal: AbortSignal.timeout(12_000),
      });
      if (!manifestResponse.ok || !(await manifestResponse.text()).trimStart().startsWith("#EXTM3U")) return null;
    } catch {
      return null;
    }
  }
  return {
    provider: "TimStreams",
    name: `TimStreams • ${String(stream?.name || "Live feed").trim()}`,
    url: "",
    clearKey: "",
    embedUrl: watchUrl,
    headers: { Referer: TIMSTREAMS_SITE },
  };
}

function eventTeams(title) {
  const value = String(title || "").trim();
  const atSides = value.split(/\s+@\s+/);
  if (atSides.length === 2) return { awayTeam: atSides[0].trim(), homeTeam: atSides[1].trim() };
  const versusSides = value.split(/\s+vs\.?\s+/i);
  if (versusSides.length === 2) return { homeTeam: versusSides[0].trim(), awayTeam: versusSides[1].trim() };
  return { awayTeam: "", homeTeam: "" };
}

function canonicalLeague(rawLeague, sport, title) {
  const value = String(rawLeague || "").trim();
  const searchable = `${value} ${sport} ${title}`.toLowerCase();
  if (/major baseball league|\bmlb\b/.test(searchable)) return "MLB";
  if (/national football league|\bnfl\b/.test(searchable)) return "NFL";
  if (/women'?s national basketball|\bwnba\b/.test(searchable)) return "WNBA";
  if (/national basketball|\bnba\b/.test(searchable)) return "NBA";
  if (/national hockey|\bnhl\b/.test(searchable)) return "NHL";
  if (/major league soccer|\bmls\b/.test(searchable)) return "MLS";
  return value;
}

export async function fetchTimStreamsGames(now, estimatedDurationSeconds) {
  try {
    const response = await fetch(`${TIMSTREAMS_API}/live-upcoming?updated=${Date.now()}`, {
      headers: { Accept: "application/json", "User-Agent": "StreamCorner-TV-Feed/1.5" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`catalog returned HTTP ${response.status}`);
    const payload = await response.json();
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const genres = new Map((Array.isArray(payload?.genres) ? payload.genres : []).map((genre) => [String(genre.id), genre]));
    const eligible = events.filter((event) => event?.vip !== true && !["17", "18"].includes(String(event?.genre)));
    const resolved = new Array(eligible.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, eligible.length)) }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= eligible.length) return;
        const event = eligible[index];
        const startsAt = parseWallClock(event?.time) || now;
        const verifyLive = startsAt.getTime() <= now.getTime();
        const streams = await Promise.all((Array.isArray(event?.streams) ? event.streams : [])
          .map((stream) => resolveStream(stream, event, verifyLive)));
        resolved[index] = streams.filter(Boolean);
      }
    }));

    const nowSeconds = Math.floor(now.getTime() / 1000);
    const games = eligible.map((event, index) => {
      const slug = String(event?.url || "").trim();
      const title = String(event?.name || slug || "TimStreams event").trim();
      const genre = genres.get(String(event?.genre));
      const subGenre = (Array.isArray(genre?.sub_categories) ? genre.sub_categories : [])
        .find((item) => String(item.id) === String(event?.sub_genre));
      const sport = String(genre?.name || "Sports").trim();
      const league = canonicalLeague(subGenre?.name || sport, sport, title);
      const startsAt = parseWallClock(event?.time) || now;
      const startSeconds = Math.floor(startsAt.getTime() / 1000);
      const endSeconds = startSeconds + estimatedDurationSeconds(title, league, sport);
      const status = startSeconds > nowSeconds ? "upcoming" : nowSeconds < endSeconds ? "live" : null;
      const teams = eventTeams(title);
      return {
        id: `timstreams-${slug || index}`,
        provider: "timstreams",
        sourceId: slug.match(/-(\d{8,})$/)?.[1] || slug,
        title, league, sport,
        startsAt: startsAt.toISOString(), endsAt: new Date(endSeconds * 1000).toISOString(),
        status, is24x7: false,
        homeTeam: teams.homeTeam, awayTeam: teams.awayTeam,
        homeLogoUrl: "", awayLogoUrl: "",
        posterUrl: String(event?.logo || "").trim().replace(/^http:/, "https:"),
        categoryLogoUrl: "", venue: "",
        sources: resolved[index] || [],
      };
    }).filter((game) => game.status);
    return {
      games,
      catalogCount: events.length,
      resolvedStreamCount: games.flatMap((game) => game.sources).length,
      apiUrl: `${TIMSTREAMS_API}/live-upcoming`,
      error: "",
    };
  } catch (error) {
    return { games: [], catalogCount: 0, resolvedStreamCount: 0, apiUrl: `${TIMSTREAMS_API}/live-upcoming`, error: String(error) };
  }
}

export const __testing = { parseWallClock, decodeEmbedPayload, safeWatchUrl };
