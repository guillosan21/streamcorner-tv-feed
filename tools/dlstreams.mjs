const DLSTREAMS_SITE = "https://dlstreams.st/";
const DLSTREAMS_CATALOG = new URL("24-7-channels.php", DLSTREAMS_SITE).href;
const CHANNEL_LOGOS = JSON.parse(await import("node:fs/promises").then(({ readFile }) =>
  readFile(new URL("./dlstreams-logos.json", import.meta.url), "utf8"),
));

const NON_SPORTS_PATTERN = /\b(?:adult|cartoon|cinema|comedy|documentary|family|food|kids?|movies?|music|news|reality|science|showtime|starz|weather)\b/i;
const SPORTS_CHANNEL_PATTERN = new RegExp([
  "a\\s+spor", "acc\\s+network", "abu\\s+dhabi\\s+sports?", "alkass", "altitude\\s+sports?",
  "arena\\s+sports?", "astro\\s+(?:cricket|supersport)", "bandsports", "be ?in\\s+sports?",
  "big\\s+ten\\s+network", "canal\\+\\s*(?:foot|formula|motogp|sports?)", "cbs\\s+sports?",
  "chicago\\s+sports\\s+network", "claro\\s+sports?", "cosmote\\s+sports?", "ct\\s+sport",
  "dazn", "dubai\\s+sports?", "eleven\\s+sports?", "espn", "eurosport", "fanduel\\s+sports?",
  "fox\\s+sports?", "golf\\s+channel", "l['’]?equipe", "match!?\\s*(?:football|premier|tv)",
  "masn", "max\\s+sport", "mlb\\s+network", "monumental\\s+sports", "motorvision",
  "nba\\s+tv", "nesn", "nfl\\s+network", "nhl\\s+network", "nova\\s+sports?",
  "oneplay\\s+sport", "olympic\\s+channel", "polsat\\s+sport", "premier\\s+sports?",
  "rai\\s+sport", "rally\\s+tv", "rmc\\s+sport", "root\\s+sports?", "sec\\s+network",
  "sky\\s+sports?", "sny", "space\\s+city\\s+home\\s+network", "sport\\s*klub",
  "sport\\s*tv", "sportsnet", "ssc\\s+sport", "star\\s+sports?", "supersport",
  "tennis\\s*channel", "tnt\\s+sports?", "tsn\\s*\\d*", "tudn", "tv4\\s+(?:football|hockey|motor|sport|tennis)",
  "tvc\\s+deportes", "tvp\\s+sport", "tyc\\s+sports?", "viaplay\\s+sports?",
  "willow", "win\\s+sports?", "wwe\\s+network", "yes\\s+network", "ziggo\\s+sport",
].join("|"), "i");

function decodeHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/Espa単ol/gi, "Español")
    .replace(/\s+/g, " ")
    .trim();
}

function isSportsChannel(name) {
  const value = decodeHtml(name);
  return value.length >= 2 && !NON_SPORTS_PATTERN.test(value) && SPORTS_CHANNEL_PATTERN.test(value);
}

function channelGroup(name) {
  const value = String(name || "");
  if (/\b(?:USA|US)\b|ESPN(?:2|U|ews)? USA|Fox Sports [12] USA|(?:NFL|MLB|NHL) Network|NBA TV|ACC Network|SEC Network|Big Ten Network|CBS Sports|Golf Channel|Tennis Channel|YES Network|SNY|NESN|MASN|FanDuel Sports|Root Sports|Space City Home Network|Monumental Sports/i.test(value)) return "United States Sports";
  if (/\bMX\b|Mexico/i.test(value)) return "Mexico Sports";
  if (/\b(?:CA|Canada)\b|TSN\d?|Sportsnet/i.test(value)) return "Canada Sports";
  if (/\bUK\b|TNT Sports [1-9]|Sky Sports/i.test(value)) return "United Kingdom Sports";
  if (/Argentina|Brasil|Brazil|Chile|Colombia|Columbia|Uruguay/i.test(value)) return "Latin America Sports";
  if (/MENA|Arabic|Qatar|UAE|Afrique|Africa|SSC Sport|Alkass/i.test(value)) return "Middle East & Africa Sports";
  if (/Australia|Malaysia|India|\bIN\b|\bPK\b|Turkey/i.test(value)) return "Asia Pacific Sports";
  if (/France|Germany|\bDE\b|Spain|Poland|Portugal|Netherland|\bNL\b|Serbia|Croatia|Greece|Italy|Sweden|Denmark|Norway|CZ|SK|Bulgaria|Romania/i.test(value)) return "Europe Sports";
  return "International Sports";
}

const GROUP_PRIORITY = new Map([
  ["United States Sports", 0],
  ["Mexico Sports", 1],
  ["Canada Sports", 2],
  ["United Kingdom Sports", 3],
  ["Latin America Sports", 4],
  ["Europe Sports", 5],
  ["Middle East & Africa Sports", 6],
  ["Asia Pacific Sports", 7],
  ["International Sports", 8],
]);

function compareChannels(left, right) {
  const groupDifference = (GROUP_PRIORITY.get(left.group) ?? 99) - (GROUP_PRIORITY.get(right.group) ?? 99);
  return groupDifference || left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" });
}

function channelLogoUrl(id) {
  const value = String(CHANNEL_LOGOS[String(id)] || "");
  return /^https:\/\//i.test(value) ? value : "";
}

function channelPlayerUrl(id) {
  const channelId = String(id || "").trim();
  if (!/^\d+$/.test(channelId)) return "";
  return new URL(`stream/stream-${channelId}.php`, DLSTREAMS_SITE).href;
}

function channelPlayerHeaders(id) {
  const channelId = String(id || "").trim();
  if (!/^\d+$/.test(channelId)) return {};
  return { Referer: new URL(`watch.php?id=${channelId}`, DLSTREAMS_SITE).href };
}

function parseChannels(html) {
  const channels = [];
  const seen = new Set();
  const linkPattern = /<a\b[^>]*href=["']([^"']*watch\.php\?id=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(linkPattern)) {
    const id = String(match[2] || "").trim();
    const name = decodeHtml(match[3]).replace(/\s*ID:\s*\d+\s*$/i, "").trim();
    if (!id || seen.has(id) || !isSportsChannel(name)) continue;
    seen.add(id);
    channels.push({ id, name, group: channelGroup(name) });
  }
  return channels.sort(compareChannels);
}

function parsePlayerTemplate(html, expectedId) {
  const iframeUrls = [...String(html || "").matchAll(/<iframe\b[^>]*src=["']([^"']+)["']/gi)]
    .map((match) => decodeHtml(match[1]));
  for (const rawUrl of iframeUrls) {
    try {
      const url = new URL(rawUrl, DLSTREAMS_SITE);
      if (url.protocol !== "https:" || !url.host.endsWith(".romponalis.st") ||
          !url.pathname.startsWith("/premiumtv/") || url.searchParams.get("id") !== String(expectedId)) continue;
      url.searchParams.set("id", "__CHANNEL_ID__");
      return url.href;
    } catch { /* Ignore malformed third-party frames. */ }
  }
  return "";
}

export async function fetchDlStreamsGames(now) {
  try {
    const response = await fetch(`${DLSTREAMS_CATALOG}?updated=${Date.now()}`, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Referer: DLSTREAMS_SITE,
        "User-Agent": "StreamCorner-TV-Feed/1.14",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`catalog returned HTTP ${response.status}`);
    const html = await response.text();
    const allChannelCount = [...html.matchAll(/watch\.php\?id=\d+/gi)].length;
    const channels = parseChannels(html);
    if (allChannelCount < 100 || channels.length < 25) {
      throw new Error(`catalog validation failed (${allChannelCount} total links, ${channels.length} sports channels)`);
    }

    const probe = channels.find((channel) => channel.id === "44") || channels[0];
    const probeWatchUrl = new URL(`watch.php?id=${probe.id}`, DLSTREAMS_SITE).href;
    const probeEmbedUrl = new URL(`stream/stream-${probe.id}.php`, DLSTREAMS_SITE).href;
    const probeResponse = await fetch(probeEmbedUrl, {
      headers: { Accept: "text/html", Referer: probeWatchUrl, "User-Agent": "StreamCorner-TV-Feed/1.14" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!probeResponse.ok) throw new Error(`player route returned HTTP ${probeResponse.status}`);
    // Validate that the provider wrapper currently resolves a real player, but do not
    // reuse that nested host for every channel. DLStreams can assign different active
    // player routes per channel and rotate them independently (for example daddy2 vs
    // daddy3). Loading each stable wrapper lets the provider select its live route.
    const probePlayerUrl = parsePlayerTemplate(await probeResponse.text(), probe.id);
    if (!probePlayerUrl) throw new Error("player route validation failed");

    const nowSeconds = Math.floor(now.getTime() / 1000);
    const games = channels.map((channel) => {
      return {
        id: `dlstreams-${channel.id}`,
        provider: "dlstreams",
        sourceId: channel.id,
        title: channel.name,
        league: channel.group,
        sport: "Sports",
        startsAt: new Date((nowSeconds - 60) * 1000).toISOString(),
        endsAt: new Date((nowSeconds + (24 * 60 * 60)) * 1000).toISOString(),
        status: "live",
        is24x7: true,
        homeTeam: "",
        awayTeam: "",
        homeLogoUrl: "",
        awayLogoUrl: "",
        posterUrl: "",
        categoryLogoUrl: channelLogoUrl(channel.id),
        venue: "",
        sources: [{
          provider: "DLStreams",
          embedProvider: "DLStreams",
          name: `DLStreams • ${channel.name}`,
          url: "",
          clearKey: "",
          embedUrl: channelPlayerUrl(channel.id),
          headers: channelPlayerHeaders(channel.id),
        }],
      };
    });
    return {
      games,
      catalogCount: allChannelCount,
      playableCount: games.length,
      catalogUrl: DLSTREAMS_CATALOG,
      error: "",
    };
  } catch (error) {
    return { games: [], catalogCount: 0, playableCount: 0, catalogUrl: DLSTREAMS_CATALOG, error: String(error) };
  }
}

export const __testing = {
  channelGroup, channelLogoUrl, channelPlayerHeaders, channelPlayerUrl, compareChannels,
  decodeHtml, isSportsChannel, parseChannels, parsePlayerTemplate,
};
