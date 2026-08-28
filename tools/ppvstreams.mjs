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
    const url = new URL(`/embed/${uriName}`, PPV_EMBED_ORIGIN);
    return url.protocol === "https:" && url.host === "embedindia.st" ? url.href : "";
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
      const league = displayLeague(event?.tag, event?.category);
      const startsAt = Number(event?.starts_at || 0);
      const endsAt = Number(event?.ends_at || 0);
      const embedUrl = safeEmbedUrl(event);
      if (!startsAt || !endsAt || endsAt <= nowSeconds || !embedUrl || event?.always_live === true || Number(event?.always_live) === 1) return null;
      const title = String(event?.name || "PPV event").trim();
      const teams = eventTeams(title);
      return {
        id: `ppv-${String(event?.id || event?.uri_name || startsAt)}`, provider: "ppv", sourceId: String(event?.id || ""),
        title, league, sport: String(event?.category || "Sports").trim(),
        startsAt: new Date(startsAt * 1000).toISOString(), endsAt: new Date(endsAt * 1000).toISOString(),
        status: startsAt > nowSeconds ? "upcoming" : "live", is24x7: false,
        homeTeam: teams.homeTeam, awayTeam: teams.awayTeam, homeLogoUrl: "", awayLogoUrl: "",
        posterUrl: String(event?.poster || "").trim().replace(/^http:/, "https:"), categoryLogoUrl: "", venue: "",
        sources: [{ provider: "PPV", name: `PPV • ${String(event?.source_tag || "Web feed").trim()}`, url: "", clearKey: "", embedUrl, headers: { Referer: PPV_SITE } }],
      };
    }).filter(Boolean);
    return { games, catalogCount: events.length, playableCount: games.length, apiUrl: PPV_API, error: "" };
  } catch (error) {
    return { games: [], catalogCount: 0, playableCount: 0, apiUrl: PPV_API, error: String(error) };
  }
}

export const __testing = { displayLeague, eventTeams, safeEmbedUrl };
