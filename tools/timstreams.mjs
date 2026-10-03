import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const TIMSTREAMS_API = "https://timst.top/api";
const TIMSTREAMS_SITE = "https://timst.top/";
const TIMSTREAMS_API_ORIGINS = ["https://timst.top", "https://timst.cfd", "https://timstreams.st"];
const TIMSTREAMS_PLAYER_HOSTS = new Set(["exmxbxe.cfd", "epiembeds.online"]);
const TIMSTREAMS_TIME_ZONE = "America/New_York";

function safeTimPlayerUrl(value) {
  const raw = String(value || "").trim();
  const rawMatch = raw.match(/^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?$/i);
  if (!rawMatch) return "";
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const path = rawMatch[2] || "/";
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
        rawMatch[1].toLowerCase() !== host || url.host.toLowerCase() !== host || url.pathname !== path ||
        !TIMSTREAMS_PLAYER_HOSTS.has(host) ||
        !/^\/[A-Za-z0-9][A-Za-z0-9._~-]{0,180}$/.test(path) || path.includes("..") ||
        (url.search && url.search.length > 2048)) return "";
    return url.href;
  } catch {
    return "";
  }
}

function encodeTimRefPart(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [first, second, third] = address.split(".").map(Number);
    return !(first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
      (first === 203 && second === 0 && third === 113));
  }
  if (family === 6) {
    const value = address.toLowerCase();
    return !(value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
      /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("2001:db8:") ||
      value.startsWith("::ffff:"));
  }
  return false;
}

async function requirePublicHttpsUrl(value) {
  const url = safeManifestUrl(value);
  if (!url) throw new Error("unsafe TimStreams manifest URL");
  const hostname = new URL(url).hostname;
  if (isIP(hostname.replace(/^\[|\]$/g, ""))) throw new Error("TimStreams manifest IP literal is not allowed");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("TimStreams manifest host did not resolve publicly");
  }
  return url;
}

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

function findManifestUrl(text) {
  const normalized = String(text || "").replaceAll("\\/", "/");
  const match = normalized.match(/https:\/\/[^\s"'<>]+\.(?:m3u8|mpd)(?:\?[^\s"'<>]*)?/i);
  if (!match) return "";
  return safeManifestUrl(match[0]);
}

function safeManifestUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || /[\s\u0000-\u001f]/.test(raw)) return "";
  try {
    const url = new URL(raw);
    const authority = raw.match(/^https:\/\/([^/?#]+)/i)?.[1];
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash ||
        url.port || authority?.toLowerCase() !== url.host.toLowerCase() ||
        url.host.toLowerCase() !== url.hostname.toLowerCase()) return "";
    return url.href;
  } catch {
    return "";
  }
}

function isRedirect(response) {
  return [301, 302, 303, 307, 308].includes(response.status);
}

const TIMSTREAMS_NFL_PLAY_TEAMS = new Set([
  "49ers", "bears", "bengals", "bills", "broncos", "browns", "buccaneers", "cardinals",
  "chargers", "chiefs", "colts", "commanders", "cowboys", "dolphins", "eagles", "falcons",
  "giants", "jaguars", "jets", "lions", "packers", "panthers", "patriots", "raiders", "rams",
  "ravens", "saints", "seahawks", "steelers", "texans", "titans", "vikings",
]);
const TIMSTREAMS_MLB_PLAY_TEAMS = new Set([
  "athletics", "angels", "astros", "blue-jays", "braves", "brewers", "cardinals", "cubs",
  "diamondbacks", "dodgers", "giants", "guardians", "mariners", "marlins", "mets", "nationals",
  "orioles", "padres", "phillies", "pirates", "rangers", "rays", "red-sox", "reds", "rockies",
  "royals", "tigers", "twins", "white-sox", "yankees",
]);

// Mirrors the Android bridge's catalog-event-bound redirect contract.
function isEventBoundTimPlayPath(path, eventSlug) {
  const slug = String(eventSlug || "");
  const nfl = slug.match(/^([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-v-([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-(\d{1,12})$/i);
  if (nfl && TIMSTREAMS_NFL_PLAY_TEAMS.has(nfl[1].toLowerCase()) &&
      TIMSTREAMS_NFL_PLAY_TEAMS.has(nfl[2].toLowerCase()) && nfl[1].toLowerCase() !== nfl[2].toLowerCase() &&
      new RegExp(`^/play/[A-Za-z0-9._~-]{1,512}\\.nfl-${nfl[3]}$`, "i").test(path)) return true;
  const unlId = slug.match(/(?:^|-)unl-(\d{1,12})$/i)?.[1];
  if (unlId && new RegExp(`^/play/[A-Za-z0-9._~-]{1,512}\\.unl-${unlId}$`, "i").test(path)) return true;
  const team = path.match(/^\/play\/[A-Za-z0-9._~-]{1,512}\.mlb-([a-z0-9-]+)$/i)?.[1]?.toLowerCase();
  return Boolean(team && TIMSTREAMS_MLB_PLAY_TEAMS.has(team) &&
    new RegExp(`(?:^|-)${team}(?:-|$)`, "i").test(slug));
}

function safeTimPlayerResponseUrl(value, expectedUrl, eventSlug) {
  const original = safeTimPlayerUrl(expectedUrl);
  if (!original) return "";
  const raw = String(value || "").trim();
  const match = raw.match(/^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?$/i);
  if (!match) return "";
  try {
    const expected = new URL(original);
    const actual = new URL(raw);
    const path = match[2] || "/";
    if (actual.protocol !== "https:" || actual.username || actual.password || actual.port || actual.hash ||
        match[1].toLowerCase() !== expected.hostname || actual.hostname !== expected.hostname ||
        actual.pathname !== path || path.includes("..") || actual.search.length > 2048) return "";
    const exactEventRedirect = isEventBoundTimPlayPath(path, eventSlug);
    return path === expected.pathname || exactEventRedirect ? actual.href : "";
  } catch { return ""; }
}

async function fetchTimPlayerPage(value, headers, eventSlug) {
  const firstUrl = safeTimPlayerUrl(value);
  if (!firstUrl) return null;
  const expected = new URL(firstUrl);
  let current = firstUrl;
  for (let hop = 0; hop <= 4; hop += 1) {
    await requirePublicHttpsUrl(current);
    const response = await fetch(current, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!isRedirect(response)) {
      const finalUrl = safeTimPlayerResponseUrl(response.url || current, firstUrl, eventSlug);
      if (!finalUrl) return null;
      const final = new URL(finalUrl);
      if (final.hostname !== expected.hostname) return null;
      return response;
    }
    await response.body?.cancel().catch(() => {});
    if (hop === 4) return null;
    const location = response.headers.get("location");
    if (!location) return null;
    const nextUrl = safeTimPlayerResponseUrl(new URL(location, current).href, firstUrl, eventSlug);
    if (!nextUrl) return null;
    const next = new URL(nextUrl);
    if (next.hostname !== expected.hostname) return null;
    current = nextUrl;
  }
  return null;
}

async function fetchTimManifest(value, headers) {
  let current = safeManifestUrl(value);
  if (!current) return null;
  for (let hop = 0; hop <= 4; hop += 1) {
    current = await requirePublicHttpsUrl(current);
    const response = await fetch(current, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    if (!isRedirect(response)) {
      const finalUrl = await requirePublicHttpsUrl(response.url || current);
      return { response, url: finalUrl };
    }
    await response.body?.cancel().catch(() => {});
    if (hop === 4) return null;
    const location = response.headers.get("location");
    if (!location) return null;
    current = safeManifestUrl(new URL(location, current).href);
    if (!current) return null;
  }
  return null;
}

async function fetchTimCatalog(origin, attempt) {
  const initial = new URL("/api/live-upcoming", `${origin}/`);
  initial.searchParams.set("updated", `${Date.now()}-${attempt}`);
  let current = initial.href;
  const expectedOrigin = new URL(origin).origin;
  for (let hop = 0; hop <= 4; hop += 1) {
    await requirePublicHttpsUrl(current);
    const response = await fetch(current, {
      headers: { Accept: "application/json", Referer: `${origin}/streams`, "User-Agent": "Mozilla/5.0 (compatible; StreamCorner-TV-Feed/1.23)" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const finalUrl = new URL(response.url || current);
    if (finalUrl.origin !== expectedOrigin || finalUrl.pathname !== "/api/live-upcoming") return null;
    if (!isRedirect(response)) return response;
    await response.body?.cancel().catch(() => {});
    if (hop === 4) return null;
    const location = response.headers.get("location");
    if (!location) return null;
    const next = new URL(location, current);
    if (next.origin !== expectedOrigin || next.pathname !== "/api/live-upcoming") return null;
    current = next.href;
  }
  return null;
}

function decodeEmbedPayload(html) {
  const direct = findManifestUrl(html);
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
  return findManifestUrl(decoded);
}

function safeWatchUrl(event) {
  const slug = String(event?.url || "").trim().replace(/^\/+|\/+$/g, "").replace(/^watch\//, "");
  if (!slug || /(?:^|\/)\.\.(?:\/|$)/.test(slug)) return "";
  try {
    const url = new URL(`/watch/${slug}`, TIMSTREAMS_SITE);
    return url.protocol === "https:" && url.origin === new URL(TIMSTREAMS_SITE).origin ? url.href : "";
  } catch {
    return "";
  }
}

async function resolveStream(stream, event, verifyLive) {
  const embedUrl = safeTimPlayerUrl(stream?.url);
  const watchUrl = safeWatchUrl(event);
  if (!embedUrl || !watchUrl || event?.vip === true || stream?.vip === true) return null;
  let manifestUrl = "";
  let manifestHeaders = { Referer: TIMSTREAMS_SITE };
  if (verifyLive) {
    try {
      const response = await fetchTimPlayerPage(embedUrl, {
        Accept: "text/html", Referer: TIMSTREAMS_SITE, "User-Agent": "StreamCorner-TV-Feed/1.13",
      }, event?.url);
      if (!response?.ok) return null;
      manifestUrl = decodeEmbedPayload(await response.text());
      if (!manifestUrl) return null;
      const referer = `${new URL(response.url || embedUrl).origin}/`;
      manifestHeaders = { Referer: referer, Origin: new URL(referer).origin };
      const manifestFetch = await fetchTimManifest(manifestUrl, {
        Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,application/dash+xml,*/*", ...manifestHeaders,
      });
      const manifestBody = await manifestFetch?.response.text();
      if (!manifestFetch?.response.ok || (!manifestBody?.trimStart().startsWith("#EXTM3U") && !/<MPD\b/i.test(manifestBody || ""))) return null;
      manifestUrl = manifestFetch.url;
    } catch {
      return null;
    }
  }
  return buildResolvedSource(stream, event, embedUrl, manifestUrl, manifestHeaders);
}

function buildResolvedSource(stream, event, embedUrl, manifestUrl = "", manifestHeaders = { Referer: TIMSTREAMS_SITE }) {
  const providerSourceRef = timProviderSourceRef(event, embedUrl);
  // Known catalog players must never fall back to publishing a signed transport when their
  // stable event identity is malformed or too long for the app's opaque-ref contract.
  if (!providerSourceRef && safeTimPlayerUrl(embedUrl)) return null;
  if (providerSourceRef) {
    // The live manifest, page URL and any signed query are intentionally transient resolver
    // state.  The public feed carries only a stable provider-owned opaque ref.
    return {
      provider: "TimStreams",
      embedProvider: "TimStreams",
      name: `TimStreams • ${String(stream?.name || "Live feed").trim()}`,
      url: "",
      clearKey: "",
      embedUrl: "",
      headers: {},
      providerSourceRef,
      providerGeneration: "v2",
    };
  }
  return {
    provider: "TimStreams",
    embedProvider: "TimStreams",
    name: `TimStreams • ${String(stream?.name || "Live feed").trim()}`,
    // Keep the manifest that was actually verified. It avoids forcing the Android client to
    // boot a provider page for every TimStreams source. The embed URL remains as a short-lived
    // refresh path when a signed manifest expires during playback.
    url: manifestUrl,
    clearKey: "",
    // Keep each channel's provider player URL. Reusing the event watch URL for
    // every channel caused source deduplication to collapse an entire list to one.
    embedUrl,
    headers: manifestUrl ? manifestHeaders : { Referer: TIMSTREAMS_SITE },
  };
}

function timProviderSourceRef(event, playerUrl) {
  const eventSlug = String(event?.url || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,180}$/.test(eventSlug) || eventSlug.includes("..")) return "";
  const canonicalPlayer = safeTimPlayerUrl(playerUrl);
  if (!canonicalPlayer) return "";
  const player = new URL(canonicalPlayer);
  const id = `v2~${encodeTimRefPart(eventSlug)}~${encodeTimRefPart(player.hostname)}~${encodeTimRefPart(player.pathname)}`;
  return id.length <= 180 ? `timstreams:${id}` : "";
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
  if (/^major league baseball$/i.test(value) || /major baseball league|\bmlb\b/.test(searchable)) return "MLB";
  if (/^UEFA Nations Leauge$/i.test(value)) return "UEFA Nations League";
  if (/national football league|\bnfl\b/.test(searchable)) return "NFL";
  if (/women'?s national basketball|\bwnba\b/.test(searchable)) return "WNBA";
  if (/national basketball|\bnba\b/.test(searchable)) return "NBA";
  if (/national hockey|\bnhl\b/.test(searchable)) return "NHL";
  if (/major league soccer|\bmls\b/.test(searchable)) return "MLS";
  return value;
}

export async function fetchTimStreamsGames(now, estimatedDurationSeconds) {
  try {
    let payload = null;
    let apiUrl = `${TIMSTREAMS_API}/live-upcoming`;
    const errors = [];
    for (let attempt = 0; attempt < TIMSTREAMS_API_ORIGINS.length + 1 && !Array.isArray(payload?.events); attempt += 1) {
      const origin = TIMSTREAMS_API_ORIGINS[attempt % TIMSTREAMS_API_ORIGINS.length];
      apiUrl = `${origin}/api/live-upcoming`;
      try {
        const response = await fetchTimCatalog(origin, attempt);
        if (!response) throw new Error("catalog redirect or final URL was rejected");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        payload = await response.json();
        if (!Array.isArray(payload?.events)) throw new Error("catalog is rotating (events is not an array)");
      } catch (error) {
        errors.push(`${origin}: ${String(error)}`);
        payload = null;
        if (attempt < TIMSTREAMS_API_ORIGINS.length) await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
      }
    }
    if (!Array.isArray(payload?.events)) throw new Error(errors.join("; ") || "catalog did not return events");
    const events = payload.events;
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
      apiUrl,
      error: "",
    };
  } catch (error) {
    return { games: [], catalogCount: 0, resolvedStreamCount: 0, apiUrl: `${TIMSTREAMS_API}/live-upcoming`, error: String(error) };
  }
}

export const __testing = {
  parseWallClock, decodeEmbedPayload, safeWatchUrl, safeTimPlayerUrl, canonicalLeague,
  buildResolvedSource, timProviderSourceRef,
  fetchTimCatalog, resolveStream, safeTimPlayerResponseUrl, apiOrigins: TIMSTREAMS_API_ORIGINS,
};
