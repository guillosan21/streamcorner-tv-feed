import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const SITE_URL = "https://streamcorner.st/";
const DEFAULT_DECODER_URL = "https://streamcorner.st/assets/BjKHyKrh.js";
const CONFIGURED_DECODER_URL = process.env.STREAMCORNER_DECODER_URL || "";
const APP_FEED_OUTPUT = process.env.APP_FEED_OUTPUT || "app/src/main/assets/games.json";
const SCRAPE_OUTPUT = process.env.SCRAPE_OUTPUT || "data/scraped-streams.json";
const STATUS_OUTPUT = process.env.STATUS_OUTPUT || "";

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

const tempDirectory = await mkdtemp(join(tmpdir(), "streamcorner-scrape-"));

try {
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
  const games = jobs.map((job, index) => {
    const detail = details[index] || job.row;
    const timestamp = Number(detail.timestamp || job.row.timestamp || 0);
    const startsAt = timestamp > 0 ? new Date(timestamp * 1000).toISOString() : now.toISOString();
    const sources = (Array.isArray(detail.streams) ? detail.streams : [])
      .map((source, sourceIndex) => ({
        name: String(source.source_name || `Source ${sourceIndex + 1}`),
        url: String(source.stream_url || ""),
        clearKey: String(source.stream_keys || ""),
        embedUrl: String(source.embed_url || ""),
      }))
      .filter((source) => source.url || source.embedUrl);

    return {
      id: `${job.provider}-${job.id}`,
      provider: job.provider,
      sourceId: job.id,
      title: String(detail.event_name || job.row.event_name || `${providerNames[job.provider]} ${job.id}`),
      league: String(detail.league || detail.category || job.row.league || job.row.category || providerNames[job.provider]),
      sport: String(detail.category || job.row.category || detail.league || job.row.league || "Sports"),
      startsAt,
      status: timestamp > nowSeconds ? "upcoming" : "live",
      is24x7: /24\s*(?:\/|x)\s*7/i.test(
        `${detail.title || job.row.title || ""} ${detail.league || job.row.league || ""} ${detail.category || job.row.category || ""}`,
      ),
      homeTeam: String(detail.home_team || job.row.home_team || ""),
      awayTeam: String(detail.away_team || job.row.away_team || ""),
      homeLogoUrl: String(detail.home_team_logo || job.row.home_team_logo || ""),
      awayLogoUrl: String(detail.away_team_logo || job.row.away_team_logo || ""),
      posterUrl: String(detail.poster || job.row.poster || ""),
      categoryLogoUrl: String(detail.category_logo || job.row.category_logo || ""),
      sources,
    };
  }).filter((game) => !NON_SPORTS_ENTERTAINMENT.test(`${game.title} ${game.league} ${game.sport}`));

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

  const feed = {
    updatedAt: now.toISOString(),
    catalogCounts,
    games,
  };
  const scrape = {
    scrapedAt: now.toISOString(),
    decoderUrl,
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
    }, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    catalogCounts,
    gameCount: games.length,
    directStreamCount: directStreams.length,
    m3u8Count: m3u8.length,
    decoderUrl,
    feedOutput: APP_FEED_OUTPUT,
    scrapeOutput: SCRAPE_OUTPUT,
  }, null, 2));
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
