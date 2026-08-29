import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchTimStreamsGames } from "./timstreams.mjs";
import { fetchPpvGames } from "./ppvstreams.mjs";

const SITE_URL = "https://streamcorner.st/";
const DEFAULT_DECODER_URL = "https://streamcorner.st/assets/BjKHyKrh.js";
const CONFIGURED_DECODER_URL = process.env.STREAMCORNER_DECODER_URL || "";
const APP_FEED_OUTPUT = process.env.APP_FEED_OUTPUT || "app/src/main/assets/games.json";
const SCRAPE_OUTPUT = process.env.SCRAPE_OUTPUT || "data/scraped-streams.json";
const STATUS_OUTPUT = process.env.STATUS_OUTPUT || "";
const ESPN_CORE_API = "https://sports.core.api.espn.com/v2/sports";
const ESPN_SITE_API = "https://site.web.api.espn.com/apis/site/v2/sports";
const PREVIOUS_FEED_URL = process.env.PREVIOUS_FEED_URL || "https://guillosan21.github.io/streamcorner-tv-feed/games.json";

const teamLeagues = [
  { id: "NFL", path: "football/nfl", name: "NFL", sport: "American Football", region: "United States", minimum: 28 },
  { id: "NBA", path: "basketball/nba", name: "NBA", sport: "Basketball", region: "United States", minimum: 25 },
  { id: "WNBA", path: "basketball/wnba", name: "WNBA", sport: "Basketball", region: "United States", minimum: 10, exclude: ["JAPAN", "NIGERIA"] },
  { id: "MLB", path: "baseball/mlb", name: "MLB", sport: "Baseball", region: "United States", minimum: 25 },
  { id: "NHL", path: "hockey/nhl", name: "NHL", sport: "Hockey", region: "United States", minimum: 25 },
  { id: "MLS", path: "soccer/usa.1", name: "MLS", sport: "Soccer", region: "United States", minimum: 20, exclude: ["Liga MX All-Stars", "MLS All-Stars"] },
  { id: "NWSL", path: "soccer/usa.nwsl", name: "NWSL", sport: "Soccer", region: "United States", minimum: 10 },
  { id: "LIGA_MX", path: "soccer/mex.1", name: "Liga MX", sport: "Soccer", region: "Mexico", minimum: 14 },
  { id: "PREMIER_LEAGUE", path: "soccer/eng.1", name: "Premier League", sport: "Soccer", region: "European Soccer", minimum: 18 },
  { id: "LA_LIGA", path: "soccer/esp.1", name: "La Liga", sport: "Soccer", region: "European Soccer", minimum: 18 },
  { id: "SERIE_A", path: "soccer/ita.1", name: "Serie A", sport: "Soccer", region: "European Soccer", minimum: 18 },
  { id: "BUNDESLIGA", path: "soccer/ger.1", name: "Bundesliga", sport: "Soccer", region: "European Soccer", minimum: 16 },
  { id: "LIGUE_1", path: "soccer/fra.1", name: "Ligue 1", sport: "Soccer", region: "European Soccer", minimum: 16 },
  { id: "UCL", path: "soccer/uefa.champions", name: "UEFA Champions League", sport: "Soccer", region: "European Soccer", minimum: 20, fallbackPreviousSeason: true },
];
const scheduleLeagues = [
  ...teamLeagues,
  { id: "UEL", path: "soccer/uefa.europa", name: "UEFA Europa League", sport: "Soccer", region: "European Soccer" },
  { id: "EFL_CUP", path: "soccer/eng.league_cup", name: "EFL Cup", sport: "Soccer", region: "European Soccer" },
];

const workers = [
  "data.gigav.workers.dev",
  "data.yedmzoa.workers.dev",
  "data.ngagzipx.workers.dev",
  "data.miopks.workers.dev",
  "data.jccldjshj8sw.workers.dev",
  "data.l0o1afmju0.workers.dev",
  "data.nibflolsi9.workers.dev",
  "data.5j181.workers.dev",
  "data.rim1043.workers.dev",
  "data.kuig2.workers.dev",
  "data.senbon001.workers.dev",
  "data.senbon001-2.workers.dev",
  "data.senbon002.workers.dev",
  "data.senbon003.workers.dev",
  "data.kageyoshi001.workers.dev",
  "data.silentbyte125.workers.dev",
  "data.stealthwolf798-69b.workers.dev",
  "data.redjoy256.workers.dev",
  "data.anonfox144.workers.dev",
  "data.cripw4lk000.workers.dev",
  "data.phamviet444.workers.dev",
  "data.kanghaerin444.workers.dev",
  "data.minjikim444.workers.dev",
  "data.leehyein444.workers.dev",
  "data.daniellemarsh444.workers.dev",
];

const providers = ["admin", "nba", "nfl", "alpha", "beta", "001", "003"];

function estimatedDurationSeconds(title, league, sport) {
  const value = `${sport} ${league} ${title}`.toLowerCase();
  if (/formula|motorsport|racing/.test(value)) return 6 * 60 * 60;
  if (/golf/.test(value)) return 12 * 60 * 60;
  if (/cricket|tennis|boxing|ufc|mma|wrestling|darts|snooker|cycling/.test(value)) return 8 * 60 * 60;
  if (/baseball|mlb|american football|nfl|cfl/.test(value)) return 6 * 60 * 60;
  if (/basketball|nba|wnba|hockey|nhl|soccer|football/.test(value)) return 4 * 60 * 60;
  return 8 * 60 * 60;
}

function compactDate(date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function canonicalTeam(value) {
  return String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/\bchiacgo\b/g, "chicago")
    .replace(/\bman city\b/g, "manchester city")
    .replace(/\bpsg\b/g, "paris saint germain")
    .replace(/\bman utd\b|\bman united\b/g, "manchester united")
    .replace(/\bspurs\b/g, "tottenham hotspur")
    .replace(/\bmunchen\b/g, "munich")
    .replace(/\bvfb\b/g, " ")
    .replace(/\breal racing club\b/g, "racing santander")
    .replace(/\bracing de santander\b/g, "racing santander")
    .replace(/\bathletic bilbao\b/g, "athletic")
    .replace(/\b(fc|cf|afc|club|town)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeLeagueLabel(value) {
  return String(value || "").trim().replace(/^(?:2\.\s*Bundesliga|Bundesliga\s*2)$/i, "Bundesliga");
}

function eventSides(game) {
  if (game.homeTeam && game.awayTeam) return [canonicalTeam(game.homeTeam), canonicalTeam(game.awayTeam)];
  const pieces = String(game.title || "").split("|")[0]
    .split(/\s+(?:v(?:s)?\.?|versus|at|@|-|–|—)\s+/i)
    .map(canonicalTeam).filter(Boolean);
  return pieces.length >= 2 ? pieces.slice(-2) : [];
}

function similarTeam(first, second) {
  if (!first || !second) return false;
  if (first === second) return true;
  const ignored = new Set(["team", "club", "fc", "cf", "afc", "sc", "ac", "olympique"]);
  const firstTokens = first.split(" ").filter((token) => token.length >= 3 && !ignored.has(token));
  const secondTokens = second.split(" ").filter((token) => token.length >= 3 && !ignored.has(token));
  if (!firstTokens.length || !secondTokens.length) return false;
  const initials = (tokens) => tokens.map((token) => token[0]).join("");
  if (first.length >= 3 && !first.includes(" ") && first === initials(secondTokens)) return true;
  if (second.length >= 3 && !second.includes(" ") && second === initials(firstTokens)) return true;
  const matched = firstTokens.filter((left) => secondTokens.some((right) =>
    left === right || (Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left))))).length;
  return matched >= Math.min(firstTokens.length, secondTokens.length);
}

function sameFeedEvent(first, second) {
  if (Math.abs(Date.parse(first.startsAt) - Date.parse(second.startsAt)) > 30 * 60 * 1000) return false;
  const left = eventSides(first);
  const right = eventSides(second);
  if (left.length !== 2 || right.length !== 2) return false;
  return (similarTeam(left[0], right[0]) && similarTeam(left[1], right[1])) ||
    (similarTeam(left[0], right[1]) && similarTeam(left[1], right[0]));
}

function deduplicateFeedGames(rows) {
  let current = rows;
  while (true) {
  const merged = [];
  for (const game of current) {
    const existing = merged.find((candidate) => sameFeedEvent(candidate, game));
    if (!existing) {
      merged.push(game);
      continue;
    }
    const sourceKeys = new Set(existing.sources.map((source) => source.url
      ? `direct:${source.url}:${source.clearKey}` : `web:${source.embedUrl}`));
    for (const source of game.sources) {
      const key = source.url ? `direct:${source.url}:${source.clearKey}` : `web:${source.embedUrl}`;
      if (!sourceKeys.has(key)) { existing.sources.push(source); sourceKeys.add(key); }
    }
    const authority = (row) => (row.scoreboardLeagueId ? 8 : 0) + (row.scheduleState ? 4 : 0) +
      (String(row.homeLogoUrl || "").includes("espncdn.com") && String(row.awayLogoUrl || "").includes("espncdn.com") ? 2 : 0) +
      (row.venue ? 1 : 0);
    if (authority(game) > authority(existing)) {
      const preservedSources = existing.sources;
      Object.assign(existing, game);
      existing.sources = preservedSources;
    }
    if (game.status === "live") existing.status = "live";
    if (!existing.venue && game.venue) existing.venue = game.venue;
    if (!existing.homeLogoUrl && game.homeLogoUrl) existing.homeLogoUrl = game.homeLogoUrl;
    if (!existing.awayLogoUrl && game.awayLogoUrl) existing.awayLogoUrl = game.awayLogoUrl;
    if (!existing.posterUrl && game.posterUrl) existing.posterUrl = game.posterUrl;
  }
  if (merged.length === current.length) return merged;
  current = merged;
  }
}

function countRemainingDuplicatePairs(rows) {
  let count = 0;
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      if (sameFeedEvent(rows[left], rows[right])) count += 1;
    }
  }
  return count;
}

function inferredWebProvider(embedUrl) {
  const host = runCatchingUrlHost(embedUrl);
  if (!host) return "";
  if (host === "timstreams.st" || host.endsWith(".timstreams.st") || /^cdx-\d+\.website$/.test(host)) return "TimStreams";
  if (host === "ppv.st" || host.endsWith(".ppv.st") ||
      host === "embedindia.st" || host.endsWith(".embedindia.st") ||
      host === "embedhd.st" || host.endsWith(".embedhd.st") ||
      host.endsWith(".ppvservices.st") || host.endsWith(".pandecocogaming.sbs") ||
      host.endsWith(".getsugatensho.sbs")) return "PPV";
  return "";
}

function sourceProvenanceErrors(rows) {
  const errors = [];
  for (const game of rows) {
    for (const source of game.sources || []) {
      const provider = String(source.provider || "");
      const embedProvider = String(source.embedProvider || "");
      const inferred = inferredWebProvider(source.embedUrl);
      if (!["StreamCorner", "TimStreams", "PPV"].includes(provider)) {
        errors.push(`${game.id}: invalid provider ${provider || "<empty>"}`);
      }
      if (!String(source.name || "").startsWith(`${provider} • `)) {
        errors.push(`${game.id}: label ${source.name || "<empty>"} disagrees with ${provider || "<empty>"}`);
      }
      if (inferred && embedProvider !== inferred) {
        errors.push(`${game.id}: ${source.embedUrl} has embedProvider=${embedProvider || "<empty>"}, expected ${inferred}`);
      }
      if (!source.url && inferred && provider !== inferred) {
        errors.push(`${game.id}: web source provider=${provider || "<empty>"}, expected ${inferred}`);
      }
    }
  }
  return errors;
}

function collapsePpvMirrors(rows) {
  let removed = 0;
  for (const game of rows) {
    const ppvSources = (game.sources || []).filter((source) => source.provider === "PPV");
    if (ppvSources.length <= 1) continue;
    const canonical = [...ppvSources].sort((first, second) => {
      const priority = (source) => {
        const host = runCatchingUrlHost(source.embedUrl);
        const canonicalPath = /^https:\/\/embedindia\.st\/embed\//i.test(String(source.embedUrl || ""));
        const hasSignedSession = (() => {
          try { return Boolean(new URL(source.embedUrl).searchParams.get("gid")); } catch { return false; }
        })();
        return (hasSignedSession ? 32 : 0) + (canonicalPath ? 8 : 0) + (host === "embedindia.st" ? 4 : 0) +
          (!/\bstream\s*\d+\b/i.test(String(source.name || "")) ? 2 : 0);
      };
      return priority(second) - priority(first);
    })[0];
    let inserted = false;
    game.sources = game.sources.filter((source) => {
      if (source.provider !== "PPV") return true;
      if (!inserted && source === canonical) { inserted = true; return true; }
      return false;
    });
    // Preserve provider ordering when the canonical entry originally followed a mirror.
    if (!inserted) game.sources.push(canonical);
    removed += ppvSources.length - 1;
  }
  return removed;
}

function isMissingVenue(value) {
  return !String(value || "").trim() || /^(?:venue\s+)?tba$/i.test(String(value).trim());
}

async function fetchEspnEventVenue(league, eventId) {
  try {
    const response = await fetch(`${ESPN_SITE_API}/${league.path}/summary?event=${encodeURIComponent(eventId)}`, {
      headers: { Accept: "application/json", "User-Agent": "StreamCorner-TV-Feed/1.3" }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return "";
    const payload = await response.json();
    const venueData = payload?.header?.competitions?.[0]?.venue || payload?.gameInfo?.venue || {};
    const address = venueData.address || {};
    const location = [address.city, address.state, address.country].filter(Boolean).join(", ");
    return [String(venueData.fullName || "").trim(), location].filter(Boolean).join(" • ");
  } catch {
    return "";
  }
}

async function fetchMajorLeagueSchedules(now) {
  const historyStart = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000);
  const dates = `${compactDate(historyStart)}-${compactDate(end)}`;
  const games = [];
  const scores = [];
  const completed = [];
  for (const league of scheduleLeagues) {
    try {
      const response = await fetch(`${ESPN_SITE_API}/${league.path}/scoreboard?dates=${dates}&limit=1000`, {
        headers: { Accept: "application/json", "User-Agent": "StreamCorner-TV-Feed/1.3" }, signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      for (const event of Array.isArray(payload?.events) ? payload.events : []) {
        const competition = event?.competitions?.[0] || {};
        const scheduleState = String(event?.status?.type?.state || "").toLowerCase();
        const startsAt = new Date(event.date);
        if (!Number.isFinite(startsAt.getTime())) continue;
        const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
        const home = competitors.find((item) => item.homeAway === "home") || {};
        const away = competitors.find((item) => item.homeAway === "away") || {};
        const homeTeam = String(home.team?.displayName || home.team?.name || "").trim();
        const awayTeam = String(away.team?.displayName || away.team?.name || "").trim();
        const title = String(event.name || `${awayTeam} vs ${homeTeam}`).trim();
        const endSeconds = Math.floor(startsAt.getTime() / 1000) + estimatedDurationSeconds(title, league.name, league.sport);
        const nowSeconds = Math.floor(now.getTime() / 1000);
        const address = competition.venue?.address || {};
        const location = [address.city, address.state, address.country].filter(Boolean).join(", ");
        const venueName = String(competition.venue?.fullName || "").trim();
        let venue = [venueName, location].filter(Boolean).join(" • ");
        if (isMissingVenue(venue) && event.id && homeTeam && awayTeam && !/\btbd\b/i.test(`${homeTeam} ${awayTeam}`)) {
          venue = await fetchEspnEventVenue(league, event.id) || venue;
        }
        const homeScore = String(home.score ?? "").trim();
        const awayScore = String(away.score ?? "").trim();
        const scoreDetail = String(event?.status?.type?.shortDetail || event?.status?.type?.detail || event?.status?.displayClock || "").trim();
        const scheduledGame = {
          id: `espn-${league.id.toLowerCase()}-${event.id}`,
          provider: "espn-schedule",
          sourceId: String(event.id || ""),
          title, league: league.name, sport: league.sport,
          startsAt: startsAt.toISOString(), endsAt: new Date(endSeconds * 1000).toISOString(),
          status: scheduleState === "in" ? "live" : "upcoming", scheduleState, is24x7: false,
          scoreboardLeagueId: league.id,
          scoreboardEventId: event.id ? `espn-${league.id.toLowerCase()}-${event.id}` : "",
          homeScore, awayScore, scoreDetail,
          homeTeam, awayTeam,
          homeLogoUrl: String(home.team?.logo || "").replace(/^http:/, "https:"),
          awayLogoUrl: String(away.team?.logo || "").replace(/^http:/, "https:"),
          posterUrl: "", categoryLogoUrl: "", venue, sources: [],
        };
        if ((scheduleState === "in" || scheduleState === "post") && startsAt >= historyStart) {
          scores.push({
            id: `espn-${league.id.toLowerCase()}-${event.id}`,
            leagueId: league.id, league: league.name, sport: league.sport,
            startsAt: startsAt.toISOString(), state: scheduleState, statusDetail: scoreDetail,
            homeTeam, awayTeam, homeScore, awayScore,
            homeLogoUrl: String(home.team?.logo || "").replace(/^http:/, "https:"),
            awayLogoUrl: String(away.team?.logo || "").replace(/^http:/, "https:"),
            venue,
          });
        }
        if (scheduleState === "post") { completed.push(scheduledGame); continue; }
        if (endSeconds <= nowSeconds) continue;
        games.push(scheduledGame);
      }
    } catch (error) {
      console.warn(`Schedule unavailable for ${league.name}: ${String(error)}`);
    }
  }
  return { games, scores, completed };
}

async function inspectStreamCapabilities(source, provider = "") {
  if (!source.url) {
    if (!source.embedUrl) return null;
    // TimStreams already verifies the underlying live manifest before returning
    // its stable watch page. Other embedded providers are checked for an online
    // HTTPS response so dead event pages do not appear as selectable broadcasts.
    if (provider === "timstreams") return source;
    try {
      const embedHost = runCatchingUrlHost(source.embedUrl);
      const isPpvSource = provider === "ppv" || source.name.startsWith("PPV •") ||
        embedHost === "embedindia.st" || embedHost.endsWith(".embedindia.st") || embedHost.endsWith(".pandecocogaming.sbs");
      const referer = isPpvSource ? "https://ppv.st/" : "https://streamcorner.st/";
      const response = await fetch(source.embedUrl, {
        headers: { Accept: "text/html", Referer: referer, "User-Agent": "StreamCorner-TV-Feed/1.13" },
        redirect: "follow", signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return null;
      const body = await response.text();
      return body.trim().length >= 200 ? source : null;
    } catch {
      return null;
    }
  }
  try {
    const response = await fetch(source.url, {
      headers: { Accept: "application/dash+xml,application/vnd.apple.mpegurl,application/x-mpegURL,*/*", "User-Agent": "StreamCorner-TV-Feed/1.5", ...(source.headers || {}) },
      redirect: "follow", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    const manifest = await response.text();
    if (!/^\s*(?:#EXTM3U|<\?xml[\s\S]*?<MPD|<MPD)/i.test(manifest)) return null;
    const heights = [...manifest.matchAll(/(?:height\s*=\s*["'](\d+)["']|RESOLUTION\s*=\s*\d+x(\d+))/gi)]
      .map((match) => Number(match[1] || match[2] || 0));
    const maxHeight = Math.max(0, ...heights);
    const videoRange = /dvhe|dvh1|dolby[ -]?vision/i.test(manifest) ? "DOLBY VISION"
      : /\bhlg\b|arib-std-b67|transferCharacteristics\s*=\s*["']18["']|VIDEO-RANGE\s*=\s*HLG/i.test(manifest) ? "HLG HDR"
      : /smpte2084|st2084|transferCharacteristics\s*=\s*["']16["']|VIDEO-RANGE\s*=\s*PQ/i.test(manifest) ? "HDR10/PQ" : "";
    const audioFormat = /ec\+3|eac3[-_.]?joc|\bjoc\b|dolby[ -]?atmos/i.test(manifest) ? "DOLBY ATMOS"
      : /ec-3|eac3|e-ac-3/i.test(manifest) ? "DOLBY DIGITAL+" : "";
    return { ...source, maxHeight, videoRange, audioFormat };
  } catch {
    return null;
  }
}
function runCatchingUrlHost(value) {
  try { return new URL(value).host.toLowerCase(); } catch { return ""; }
}
const providerNames = {
  admin: "ADMIN",
  nba: "NBA",
  nfl: "NFL",
  alpha: "ALPHA",
  beta: "BETA",
  "001": "#001",
  "003": "#003",
};

const NON_SPORTS_ENTERTAINMENT = /family guy|the simpsons|south park|rick and morty|cartoon|anime|movie|cinema|sitcom|tv show|reality tv/i;
const SPORTS_24X7_SIGNAL = /sports?|espn|dazn|bein|nfl|nba|wnba|mlb|nhl|mls|ncaa|uefa|fifa|football|basketball|baseball|hockey|soccer|tennis|golf|racing|motorsport|boxing|mma|ufc|wwe|aew|wrestling|cricket|rugby|cycling|snooker|darts|lacrosse/i;

function isSupportedSportsEntry(game) {
  const description = `${game.title} ${game.league} ${game.sport}`;
  if (NON_SPORTS_ENTERTAINMENT.test(description)) return false;
  return !game.is24x7 || SPORTS_24X7_SIGNAL.test(description);
}

const tempDirectory = await mkdtemp(join(tmpdir(), "streamcorner-scrape-"));

try {
  async function loadPreviousTeams() {
    try {
      const previous = JSON.parse(await readFile(APP_FEED_OUTPUT, "utf8"));
      return Array.isArray(previous.teams) ? previous.teams : [];
    } catch {
      try {
        const response = await fetch(`${PREVIOUS_FEED_URL}?previous=${Date.now()}`, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) return [];
        const previous = await response.json();
        return Array.isArray(previous.teams) ? previous.teams : [];
      } catch {
        return [];
      }
    }
  }

  async function fetchTeamCatalog() {
    const previous = await loadPreviousTeams();
    const previousByLeague = new Map();
    for (const team of previous) {
      const saved = previousByLeague.get(team.leagueId) || [];
      saved.push(team);
      previousByLeague.set(team.leagueId, saved);
    }
    const catalog = [];
    const errors = [];
    for (const league of teamLeagues) {
      try {
        let season = new Date().getUTCFullYear();
        const [apiSport, apiLeague] = league.path.split("/");
        const loadRefs = async () => {
          const response = await fetch(`${ESPN_CORE_API}/${apiSport}/leagues/${apiLeague}/seasons/${season}/teams?limit=100`, {
            headers: { Accept: "application/json", "User-Agent": "StreamCorner-TV-Feed/1.2" }, signal: AbortSignal.timeout(20_000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          return Array.isArray(payload?.items) ? payload.items.map((item) => String(item?.$ref || "").replace(/^http:/, "https:")).filter(Boolean) : [];
        };
        let refs = await loadRefs();
        if (refs.length < league.minimum && league.fallbackPreviousSeason) { season -= 1; refs = await loadRefs(); }
        if (refs.length < league.minimum) throw new Error(`only ${refs.length} teams`);
        const rows = [];
        for (let offset = 0; offset < refs.length; offset += 12) {
          const batch = await Promise.all(refs.slice(offset, offset + 12).map(async (ref) => {
            const teamResponse = await fetch(ref, { signal: AbortSignal.timeout(20_000) });
            if (!teamResponse.ok) throw new Error(`team returned HTTP ${teamResponse.status}`);
            return teamResponse.json();
          }));
          rows.push(...batch);
        }
        const eligibleRows = rows.filter((team) => !league.exclude?.includes(String(team.displayName || team.name || "").trim()));
        catalog.push(...eligibleRows.map((team) => ({
          id: `${league.id}:${String(team.id || team.displayName).trim()}`,
          name: String(team.displayName || team.name || "").trim(),
          leagueId: league.id,
          leagueName: league.name,
          sport: league.sport,
          region: league.region,
          logoUrl: String((team.logos || []).find((logo) => logo.rel?.includes("primary_logo_on_black_color"))?.href || (team.logos || []).find((logo) => logo.rel?.includes("default"))?.href || "").trim().replace(/^http:/, "https:"),
        })).filter((team) => team.name));
      } catch (error) {
        const saved = previousByLeague.get(league.id) || [];
        if (saved.length >= league.minimum) catalog.push(...saved);
        else errors.push(`${league.name}: ${String(error)}`);
      }
    }
    const teams = [...new Map(catalog.map((team) => [team.id, team])).values()]
      .sort((a, b) => a.region.localeCompare(b.region) || a.leagueName.localeCompare(b.leagueName) || a.name.localeCompare(b.name));
    if (errors.length) throw new Error(`Team catalog update incomplete: ${errors.join("; ")}`);
    return { teams, errors };
  }

  async function findDecoder() {
    const candidates = [];
    if (CONFIGURED_DECODER_URL) candidates.push(CONFIGURED_DECODER_URL);
    candidates.push(DEFAULT_DECODER_URL);

    try {
      const pageResponse = await fetch(SITE_URL, { signal: AbortSignal.timeout(15_000) });
      if (pageResponse.ok) {
        const html = await pageResponse.text();
        for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.js(?:\?[^"']*)?)["']/gi)) {
          candidates.push(new URL(match[1], SITE_URL).href);
        }
      }
    } catch {
      // The configured/default asset may still work when the homepage is temporarily unavailable.
    }

    const uniqueCandidates = [...new Set(candidates)];
    let lastError;
    for (const [index, url] of uniqueCandidates.entries()) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const decoderPath = join(tempDirectory, `decoder-${index}.mjs`);
        await writeFile(decoderPath, await response.text(), "utf8");
        const module = await import(`${pathToFileURL(decoderPath).href}?v=${Date.now()}`);
        if (typeof module.j !== "function") throw new Error("asset does not export decoder function j");
        return { decoder: module, decoderUrl: url };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`No compatible StreamCorner decoder was found: ${String(lastError || "unknown error")}`);
  }

  const { decoder, decoderUrl } = await findDecoder();

  async function withTimeout(promise, timeoutMs, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(provider, id = "") {
    let lastError;
    for (const worker of workers) {
      const query = new URLSearchParams({ p: provider });
      if (id) query.set("id", id);
      const url = `https://${worker}/corner?${query}`;
      try {
        return await withTimeout(
          decoder.j(url, provider, providerNames[provider] || provider.toUpperCase()),
          12_000,
          `${provider}:${id || "catalog"}`,
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`No worker returned ${provider}:${id}`);
  }

  const jobs = [];
  const seenJobs = new Set();
  const catalogCounts = {};
  for (const provider of providers) {
    const result = await request(provider);
    const rows = Array.isArray(result) ? result : (result?.channels || []);
    catalogCounts[provider] = rows.length;
    for (const row of rows) {
      const id = String(row.stream_id || row.game_id || row.channel_id || "").trim();
      const key = `${provider}:${id}`;
      if (id && !seenJobs.has(key)) {
        seenJobs.add(key);
        jobs.push({ provider, id, row });
      }
    }
  }

  const details = new Array(jobs.length);
  let nextIndex = 0;
  const concurrency = Math.min(12, Math.max(1, jobs.length));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      try {
        details[index] = await request(job.provider, job.id);
      } catch (error) {
        details[index] = { ...job.row, streams: [], scrape_error: String(error) };
      }
    }
  }));

  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  let games = jobs.map((job, index) => {
    const detail = details[index] || job.row;
    const timestamp = Number(detail.timestamp || job.row.timestamp || 0);
    const startsAt = timestamp > 0 ? new Date(timestamp * 1000).toISOString() : now.toISOString();
    const title = String(detail.event_name || job.row.event_name || detail.title || job.row.title || `${providerNames[job.provider]} ${job.id}`);
    const league = normalizeLeagueLabel(detail.league || detail.category || job.row.league || job.row.category || providerNames[job.provider]);
    const sport = String(detail.category || job.row.category || detail.league || job.row.league || "Sports");
    const is24x7 = /24\s*(?:\/|x)\s*7/i.test(`${title} ${league} ${sport}`);
    const endSeconds = timestamp > 0 ? timestamp + estimatedDurationSeconds(title, league, sport) : nowSeconds + 8 * 60 * 60;
    const status = is24x7 || timestamp <= 0 || nowSeconds < endSeconds
      ? (timestamp > nowSeconds ? "upcoming" : "live")
      : null;
    const sources = (Array.isArray(detail.streams) ? detail.streams : [])
      .map((source, sourceIndex) => {
        const rawUrl = String(source.stream_url || "").trim();
        const directUrl = /\.(?:m3u8|mpd)(?:$|[?#&])/i.test(rawUrl) ? rawUrl : "";
        const embedUrl = String(source.embed_url || (!directUrl ? rawUrl : "")).trim();
        const embedHost = runCatchingUrlHost(embedUrl);
        const isPpvEmbed = embedHost === "embedindia.st" || embedHost.endsWith(".embedindia.st") ||
          embedHost === "embedhd.st" || embedHost.endsWith(".embedhd.st") ||
          embedHost.endsWith(".ppvservices.st") || embedHost.endsWith(".pandecocogaming.sbs") ||
          embedHost.endsWith(".getsugatensho.sbs");
        const isTimEmbed = embedHost === "timstreams.st" || embedHost.endsWith(".timstreams.st") ||
          /^cdx-\d+\.website$/.test(embedHost);
        const channelName = String(source.source_name || `Source ${sourceIndex + 1}`).replace(/^(?:StreamCorner|TimStreams|PPV)\s*[•|-]\s*/i, "");
        const embedProvider = isPpvEmbed ? "PPV" : isTimEmbed ? "TimStreams" : "StreamCorner";
        const sourceProvider = directUrl ? "StreamCorner" : embedProvider;
        return {
          // These jobs came from StreamCorner. Only a provider-owned web player
          // overrides that provenance; shared direct CDNs never do.
          provider: sourceProvider,
          embedProvider,
          name: `${sourceProvider} • ${channelName}`,
          url: directUrl,
          clearKey: directUrl ? String(source.stream_keys || "") : "",
          embedUrl,
          ...(!directUrl && isPpvEmbed ? { headers: { Referer: "https://ppv.st/" } } : {}),
        };
      })
      .filter((source) => source.url || source.embedUrl)
      .filter((source, sourceIndex, rows) => rows.findIndex((candidate) =>
        source.url ? candidate.url === source.url && candidate.clearKey === source.clearKey : candidate.embedUrl === source.embedUrl) === sourceIndex);

    return {
      id: `${job.provider}-${job.id}`,
      provider: job.provider,
      sourceId: job.id,
      title,
      league,
      sport,
      startsAt,
      endsAt: new Date(endSeconds * 1000).toISOString(),
      status,
      is24x7,
      homeTeam: String(detail.home_team || job.row.home_team || ""),
      awayTeam: String(detail.away_team || job.row.away_team || ""),
      homeLogoUrl: String(detail.home_team_logo || job.row.home_team_logo || ""),
      awayLogoUrl: String(detail.away_team_logo || job.row.away_team_logo || ""),
      posterUrl: String(detail.poster || job.row.poster || ""),
      categoryLogoUrl: String(detail.category_logo || job.row.category_logo || ""),
      venue: String(detail.venue?.fullName || detail.venue_name || detail.venue || detail.location || job.row.venue || job.row.location || ""),
      sources,
    };
  }).filter((game) => game.status && isSupportedSportsEntry(game));

  const timStreams = await fetchTimStreamsGames(now, estimatedDurationSeconds);
  catalogCounts.timstreams = timStreams.catalogCount;
  if (timStreams.error) console.warn(`TimStreams unavailable: ${timStreams.error}`);
  games.push(...timStreams.games.filter(isSupportedSportsEntry));
  const ppv = await fetchPpvGames(now);
  catalogCounts.ppv = ppv.catalogCount;
  if (ppv.error) console.warn(`PPV unavailable: ${ppv.error}`);
  games.push(...ppv.games.filter(isSupportedSportsEntry));

  const schedule = await fetchMajorLeagueSchedules(now);
  const scheduledGames = [...schedule.games, ...schedule.completed];
  const matchedSourceGames = new Set();
  for (const scheduled of scheduledGames) {
    const scheduledTeams = [canonicalTeam(scheduled.homeTeam), canonicalTeam(scheduled.awayTeam)].filter(Boolean).sort().join("|");
    const matches = games.filter((game) => {
      const gameTeams = [canonicalTeam(game.homeTeam), canonicalTeam(game.awayTeam)].filter(Boolean).sort().join("|");
      const normalizedTitle = canonicalTeam(game.title);
      const titleMatches = canonicalTeam(scheduled.homeTeam) && canonicalTeam(scheduled.awayTeam)
        && normalizedTitle.includes(canonicalTeam(scheduled.homeTeam))
        && normalizedTitle.includes(canonicalTeam(scheduled.awayTeam));
      // Names alone are unsafe for doubleheaders and same-day rematches. ESPN IDs
      // are exact; provider-title fallback is deliberately limited to clock rounding.
      const closeInTime = Math.abs(Date.parse(game.startsAt) - Date.parse(scheduled.startsAt)) <= 45 * 60 * 1000;
      const sameExternalId = game.sourceId && scheduled.sourceId && String(game.sourceId) === String(scheduled.sourceId);
      return !matchedSourceGames.has(game.id) && scheduledTeams && (sameExternalId || (closeInTime && (gameTeams === scheduledTeams || titleMatches)));
    });
    if (matches.length) {
      for (const match of matches) {
        matchedSourceGames.add(match.id);
        // Normalize a matched provider event to ESPN's authoritative event identity.
        // Provider titles and rounded start times otherwise prevent source merging.
        match.title = scheduled.title;
        match.league = scheduled.league;
        match.sport = scheduled.sport;
        match.startsAt = scheduled.startsAt;
        match.endsAt = scheduled.endsAt;
        match.homeTeam = scheduled.homeTeam;
        match.awayTeam = scheduled.awayTeam;
        if (!isMissingVenue(scheduled.venue)) match.venue = scheduled.venue;
        match.homeLogoUrl ||= scheduled.homeLogoUrl;
        match.awayLogoUrl ||= scheduled.awayLogoUrl;
        match.scheduleState = scheduled.scheduleState;
        match.status = scheduled.status;
        match.scoreboardLeagueId = scheduled.scoreboardLeagueId;
        match.scoreboardEventId = scheduled.scoreboardEventId;
        match.homeScore = scheduled.homeScore;
        match.awayScore = scheduled.awayScore;
        match.scoreDetail = scheduled.scoreDetail;
      }
    } else if (scheduled.scheduleState !== "post") {
      games.push(scheduled);
    }
  }
  games = deduplicateFeedGames(games.filter((game) => game.scheduleState !== "post"));
  const collapsedPpvMirrorCount = collapsePpvMirrors(games);
  const duplicateEventPairCount = countRemainingDuplicatePairs(games);
  if (duplicateEventPairCount > 0) throw new Error(`feed still contains ${duplicateEventPairCount} mergeable duplicate event pair(s)`);
  games.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  const liveSources = games.filter((game) => game.status === "live").flatMap((game) => game.sources.map((source, index) => ({ game, source, index })));
  let capabilityIndex = 0;
  await Promise.all(Array.from({ length: Math.min(8, liveSources.length) }, async () => {
    while (true) {
      const jobIndex = capabilityIndex++;
      if (jobIndex >= liveSources.length) return;
      const item = liveSources[jobIndex];
      item.game.sources[item.index] = await inspectStreamCapabilities(item.source, item.game.provider);
    }
  }));
  games.forEach((game) => { game.sources = game.sources.filter(Boolean); });
  const provenanceErrors = sourceProvenanceErrors(games);
  if (provenanceErrors.length) {
    throw new Error(`source provenance validation failed (${provenanceErrors.length}): ${provenanceErrors.slice(0, 5).join("; ")}`);
  }

  const directStreams = games.flatMap((game) => game.sources
    .filter((source) => source.url)
    .map((source) => ({
      gameId: game.id,
      title: game.title,
      sourceName: source.name,
      url: source.url,
      clearKey: source.clearKey,
    })));
  const m3u8 = directStreams.filter((stream) => /\.m3u8(?:$|\?)/i.test(stream.url));

  const teamCatalog = await fetchTeamCatalog();
  const feed = {
    updatedAt: now.toISOString(),
    feedSchemaVersion: 2,
    eventsDeduplicated: true,
    finalEventsFiltered: true,
    catalogCounts,
    teams: teamCatalog.teams,
    games,
    scores: schedule.scores,
  };
  const scrape = {
    scrapedAt: now.toISOString(),
    decoderUrl,
    timStreamsApiUrl: timStreams.apiUrl,
    timStreamsResolvedStreamCount: timStreams.resolvedStreamCount,
    ppvApiUrl: ppv.apiUrl,
    ppvPlayableCount: ppv.playableCount,
    catalogCounts,
    gameCount: games.length,
    directStreamCount: directStreams.length,
    m3u8Count: m3u8.length,
    m3u8,
    otherDirectStreams: directStreams.filter((stream) => !/\.m3u8(?:$|\?)/i.test(stream.url)),
  };

  await mkdir(dirname(APP_FEED_OUTPUT), { recursive: true });
  await mkdir(dirname(SCRAPE_OUTPUT), { recursive: true });
  await writeFile(APP_FEED_OUTPUT, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
  await writeFile(SCRAPE_OUTPUT, `${JSON.stringify(scrape, null, 2)}\n`, "utf8");

  if (STATUS_OUTPUT) {
    await mkdir(dirname(STATUS_OUTPUT), { recursive: true });
    await writeFile(STATUS_OUTPUT, `${JSON.stringify({
      updatedAt: now.toISOString(),
      gameCount: games.length,
      directStreamCount: directStreams.length,
      m3u8Count: m3u8.length,
      decoderUrl,
      timStreamsResolvedStreamCount: timStreams.resolvedStreamCount,
      ppvPlayableCount: ppv.playableCount,
      teamCount: teamCatalog.teams.length,
      scoreCount: schedule.scores.length,
      liveScoreCount: schedule.scores.filter((score) => score.state === "in").length,
      duplicateEventPairCount,
      sourceProvenanceErrorCount: provenanceErrors.length,
      collapsedPpvMirrorCount,
      teamCatalogErrors: teamCatalog.errors,
    }, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    catalogCounts,
    gameCount: games.length,
    directStreamCount: directStreams.length,
    m3u8Count: m3u8.length,
    decoderUrl,
    timStreamsResolvedStreamCount: timStreams.resolvedStreamCount,
    ppvPlayableCount: ppv.playableCount,
    teamCount: teamCatalog.teams.length,
    scoreCount: schedule.scores.length,
    liveScoreCount: schedule.scores.filter((score) => score.state === "in").length,
    duplicateEventPairCount,
    sourceProvenanceErrorCount: provenanceErrors.length,
    collapsedPpvMirrorCount,
    teamCatalogErrors: teamCatalog.errors,
    feedOutput: APP_FEED_OUTPUT,
    scrapeOutput: SCRAPE_OUTPUT,
  }, null, 2));
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
