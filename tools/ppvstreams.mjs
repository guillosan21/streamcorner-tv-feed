const PPV_API = "https://api.ppv.st/api/streams";
const PPV_SITE = "https://ppv.st/";
const PPV_EMBED_ORIGIN = "https://embedindia.st";

const CANONICAL_LEAGUES = new Map([
  ["NFL", "NFL"], ["MLB", "MLB"], ["NBA", "NBA"], ["WNBA", "WNBA"], ["NHL", "NHL"],
  ["MLS", "MLS"], ["NWSL", "NWSL"], ["LIGA MX", "Liga MX"], ["PREMIER LEAGUE", "Premier League"],
  ["LALIGA", "La Liga"], ["SERIE A", "Serie A"], ["BUNDESLIGA", "Bundesliga"], ["LIGUE 1", "Ligue 1"],
  ["UEFA CHAMPIONS LEAGUE", "UEFA Champions League"], ["CHAMPIONS LEAGUE", "UEFA Champions League"],
]);

function displayLeague(tag, category) {
  const value = String(tag || "").trim();
  return CANONICAL_LEAGUES.get(value.toUpperCase()) || value || String(category || "Sports").trim() || "Sports";
}

const NON_SPORTS_24X7_PATTERN = /\b(?:south\s*park|family\s*guys?|simpsons?|sponge\s*bob|cartoons?|movies?|cows?)\b/i;
const SPORTS_24X7_PATTERN = /\b(?:espn\d*|fox\s+(?:sports|footy|cricket|league)|willow|rally\s*tv|nfl|nba|mlb|nhl|cricket|rugby|football|soccer|tennis|golf|motorsports?)\b/i;

function isAlwaysLive(event) {
  return event?.always_live === true || Number(event?.always_live) === 1;
}

function isSports24x7Event(event) {
  if (!isAlwaysLive(event)) return false;
  const searchable = [event?.name, event?.category, event?.category_name, event?.tag, event?.source_tag]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
  return !NON_SPORTS_24X7_PATTERN.test(searchable) && SPORTS_24X7_PATTERN.test(searchable);
}

function eventTeams(title) {
  const cleanTeam = (value) => String(value || "").trim()
    .replace(/^\d+(?:st|nd|rd|th)\s+(?:test|round|leg|match)\s*[-:|]\s*/i, "")
    .trim();
  const at = String(title || "").split(/\s+(?:at|@)\s+/i);
  if (at.length === 2) return { awayTeam: cleanTeam(at[0]), homeTeam: cleanTeam(at[1]) };
  const versus = String(title || "").split(/\s+vs\.?\s+/i);
  return versus.length === 2 ? { homeTeam: cleanTeam(versus[0]), awayTeam: cleanTeam(versus[1]) } : { homeTeam: "", awayTeam: "" };
}

function safeEmbedUrl(event) {
  const uriName = String(event?.uri_name || "").trim().replace(/^\/+/, "");
  if (!uriName || /(?:^|\/)\.\.(?:\/|$)/.test(uriName)) return "";
  try {
    const expectedPath = `/embed/${uriName}`;
    const signedIframe = String(event?.iframe || "").trim();
    if (signedIframe) {
      const signedUrl = new URL(signedIframe);
      if (signedUrl.protocol === "https:" && signedUrl.host === "embedindia.st" && signedUrl.pathname === expectedPath) {
        // The gid query parameter authorizes the media session. A bare /embed URL
        // renders JWPlayer but often has no playable event behind its Play button.
        return signedUrl.href;
      }
      return "";
    }
    return new URL(expectedPath, PPV_EMBED_ORIGIN).href;
  } catch { return ""; }
}

export async function fetchPpvGames(now) {
  try {
    const response = await fetch(`${PPV_API}?updated=${Date.now()}`, {
      headers: { Accept: "application/json", Origin: PPV_SITE.slice(0, -1), Referer: PPV_SITE, "User-Agent": "StreamCorner-TV-Feed/1.6" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`catalog returned HTTP ${response.status}`);
    const payload = await response.json();
    const categories = Array.isArray(payload?.streams) ? payload.streams : [];
    const events = categories.flatMap((category) => (Array.isArray(category?.streams) ? category.streams : [])
      .map((event) => ({ ...event, category: String(category?.category || event?.category_name || "Sports") })));
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const games = events.map((event) => {
      const alwaysLive = isAlwaysLive(event);
      const league = alwaysLive
        ? String(event?.category || "24/7 Sports").trim() || "24/7 Sports"
        : displayLeague(event?.tag, event?.category);
      const startsAt = Number(event?.starts_at || 0);
      const endsAt = Number(event?.ends_at || 0);
      const embedUrl = safeEmbedUrl(event);
      if (!embedUrl || (alwaysLive ? !isSports24x7Event(event) : (!startsAt || !endsAt || endsAt <= nowSeconds))) return null;
      const title = String(event?.name || "PPV event").trim();
      const teams = eventTeams(title);
      const effectiveStartsAt = alwaysLive ? nowSeconds - 60 : startsAt;
      const effectiveEndsAt = alwaysLive ? nowSeconds + (24 * 60 * 60) : endsAt;
      return {
        id: `ppv-${String(event?.id || event?.uri_name || startsAt)}`, provider: "ppv", sourceId: String(event?.id || ""),
        title, league, sport: String(event?.category || "Sports").trim(),
        startsAt: new Date(effectiveStartsAt * 1000).toISOString(), endsAt: new Date(effectiveEndsAt * 1000).toISOString(),
        status: alwaysLive ? "live" : (startsAt > nowSeconds ? "upcoming" : "live"), is24x7: alwaysLive,
        homeTeam: teams.homeTeam, awayTeam: teams.awayTeam, homeLogoUrl: "", awayLogoUrl: "",
        posterUrl: String(event?.poster || "").trim().replace(/^http:/, "https:"), categoryLogoUrl: "", venue: "",
        sources: [{ provider: "PPV", embedProvider: "PPV", name: `PPV • ${String(event?.source_tag || "Web feed").trim()}`, url: "", clearKey: "", embedUrl, headers: { Referer: PPV_SITE } }],
      };
    }).filter(Boolean);
    return { games, catalogCount: events.length, playableCount: games.length, apiUrl: PPV_API, error: "" };
  } catch (error) {
    return { games: [], catalogCount: 0, playableCount: 0, apiUrl: PPV_API, error: String(error) };
  }
}

export const __testing = { displayLeague, eventTeams, isAlwaysLive, isSports24x7Event, safeEmbedUrl };
