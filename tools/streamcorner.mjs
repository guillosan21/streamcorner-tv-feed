import vm from "node:vm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const SITE = "https://cornerstream.tech/";
const PROVIDERS = ["admin", "nba", "nfl", "alpha", "beta", "001", "003"];
const MAX_ASSET_BYTES = 600_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const WORKER_HOST = /^data\.[a-z0-9-]+\.workers\.dev$/;
const DIRECT_PATH = /\.(?:m3u8|mpd)$/i;

async function textResponse(fetcher, url, timeoutMs = 12_000) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
  if (Number(response.headers.get("content-length") || 0) > MAX_ASSET_BYTES) throw new Error("asset too large");
  const text = await response.text();
  if (text.length > MAX_ASSET_BYTES) throw new Error("asset too large");
  return text;
}

/** Resolve the current site's decoder and worker pool instead of pinning rotating asset hashes. */
export async function discoverStreamCornerRuntime(fetcher = fetch) {
  const html = await textResponse(fetcher, SITE);
  const entryPath = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+\.js)["']/gi)]
    .map((match) => match[1])[0] ||
    [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']*\/assets\/[^"']+\.js)["']/gi)]
      .map((match) => match[1]).find((path) => path.startsWith("/assets/"));
  if (!entryPath) throw new Error("current StreamCorner entry asset not found");
  const entryUrl = new URL(entryPath, SITE);
  if (entryUrl.origin !== new URL(SITE).origin || !entryUrl.pathname.startsWith("/assets/")) {
    throw new Error("entry asset left the provider origin");
  }
  const entry = await textResponse(fetcher, entryUrl.href);
  const imports = [...entry.matchAll(/from["']\.\/([^"']+\.js)["']/g)].map((match) => match[1]);
  let runtime;
  let runtimeUrl;
  for (const name of imports.slice(0, 8)) {
    if (!/^[A-Za-z0-9_-]+\.js$/.test(name)) continue;
    const candidateUrl = new URL(name, entryUrl);
    const candidate = await textResponse(fetcher, candidateUrl.href);
    if (/data\.[a-z0-9-]+\.workers\.dev/.test(candidate) && /\bZo=\[/.test(candidate)) {
      runtime = candidate;
      runtimeUrl = candidateUrl.href;
      break;
    }
  }
  if (!runtime) throw new Error("current StreamCorner worker runtime not found");
  const workerList = /\bZo=\[([^\]]+)\]/.exec(runtime)?.[1] || "";
  const workers = [...workerList.matchAll(/["'](data\.[a-z0-9-]+\.workers\.dev)["']/g)]
    .map((match) => match[1]).filter((host) => WORKER_HOST.test(host));
  if (!workers.length) throw new Error("current StreamCorner worker list is unavailable");
  const decoderName = /import\{\s*j\s+as\s+\w+\s*\}from["']\.\/([A-Za-z0-9_-]+\.js)["']/.exec(runtime)?.[1];
  if (!decoderName) throw new Error("current StreamCorner decoder reference not found");
  const decoderUrl = new URL(decoderName, runtimeUrl);
  const decoderCode = await textResponse(fetcher, decoderUrl.href);
  const exportMatch = /export\{([^}]+)\}/.exec(decoderCode);
  const decoderExport = exportMatch?.[1].split(",").map((part) => part.trim())
    .find((part) => /\s+as\s+j$/.test(part))?.split(/\s+as\s+/)[0];
  if (!decoderExport || !/^[A-Za-z_$][\w$]*$/.test(decoderExport) || /\bimport\s*(?:\{|\()/m.test(decoderCode)) {
    throw new Error("current StreamCorner decoder shape is unsupported");
  }
  return { workers: workers.slice(0, 12), decoderCode, decoderExport, decoderUrl: decoderUrl.href };
}

export async function loadStreamCornerRuntime(fetcher) {
  try {
    return { ...(await discoverStreamCornerRuntime(fetcher)), fallbackWarning: "" };
  } catch (liveError) {
    // GitHub-hosted runners can receive a site-level Cloudflare 403 even while the
    // provider's worker API remains available. The owner's last verified public
    // decoder asset is a bounded fallback; the site can refresh it explicitly.
    const cached = JSON.parse(await readFile(new URL("./assets/streamcorner-runtime.json", import.meta.url), "utf8"));
    const digest = createHash("sha256").update(cached.decoderCode).digest("hex");
    if (digest !== cached.decoderSha256 || cached.decoderCode.length > MAX_ASSET_BYTES ||
        !Array.isArray(cached.workers) || !cached.workers.length ||
        !cached.workers.every((host) => WORKER_HOST.test(host)) ||
        !new URL(cached.decoderUrl).href.startsWith(`${SITE}assets/`) ||
        !/^[A-Za-z_$][\w$]*$/.test(cached.decoderExport)) {
      throw new Error(`live runtime failed and cached runtime is invalid: ${String(liveError)}`);
    }
    return { ...cached, fallbackWarning: `current site unavailable (${String(liveError)}); using checked-in decoder` };
  }
}

function decoderFor(runtime, fetcher) {
  const allowedHosts = new Set(runtime.workers);
  const providerFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.pathname !== "/corner" ||
      String(init.method || "GET").toUpperCase() !== "POST") {
      throw new Error("decoder request left the verified StreamCorner worker route");
    }
    if (String(init.body || "").length > 4096) throw new Error("decoder request body too large");
    const response = await fetcher(url.href, { ...init, signal: AbortSignal.timeout(12_000), redirect: "error" });
    if (Number(response.headers.get("content-length") || 0) > MAX_RESPONSE_BYTES) throw new Error("worker response too large");
    return response;
  };
  const sandbox = {
    fetch: providerFetch, crypto: globalThis.crypto, URL, URLSearchParams,
    TextEncoder, TextDecoder, atob, btoa, setTimeout, clearTimeout,
    AbortController, AbortSignal,
  };
  vm.createContext(sandbox);
  const source = runtime.decoderCode.replace(/export\{[^}]+\};?/, `globalThis.__decode=${runtime.decoderExport};`);
  vm.runInContext(source, sandbox, { timeout: 2_000 });
  if (typeof sandbox.__decode !== "function") throw new Error("StreamCorner decoder did not initialize");
  return sandbox.__decode;
}

async function request(decoder, workers, provider, id = "") {
  let lastError;
  for (const host of workers.slice(0, 3)) {
    const url = new URL(`https://${host}/corner`);
    url.searchParams.set("p", provider);
    if (id) url.searchParams.set("id", id);
    try {
      return await Promise.race([
        decoder(url.href, provider, provider.toUpperCase()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("provider request timed out")), 13_000)),
      ]);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("provider workers returned no result");
}

function directSource(source, index) {
  const rawUrl = String(source?.stream_url || "").trim();
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "https:" || !DIRECT_PATH.test(url.pathname)) return null;
  const rawKey = String(source?.stream_keys || "").trim();
  if (rawKey && !/^[0-9a-f]{32}:[0-9a-f]{32}$/i.test(rawKey)) return null;
  const channel = String(source?.source_name || `Source ${index + 1}`).trim().slice(0, 70);
  return {
    provider: "StreamCorner", embedProvider: "StreamCorner", name: `StreamCorner • ${channel || `Source ${index + 1}`}`,
    url: url.href, clearKey: rawKey, embedUrl: "", headers: { Referer: SITE },
    ...(typeof source?.hd === "boolean" ? { hd: source.hd } : {}),
    ...(Number.isInteger(source?.maxHeight) ? { maxHeight: source.maxHeight } : {}),
  };
}

export function streamCornerGameFromDetail(job, detail, now, estimatedDurationSeconds) {
  const timestamp = Number(detail?.timestamp || job.row.timestamp || 0);
  const title = String(detail?.event_name || job.row.event_name || detail?.title || job.row.title || "").trim();
  const league = String(detail?.league || detail?.category || job.row.league || job.row.category || "Sports").trim();
  const sport = String(detail?.category || job.row.category || detail?.league || job.row.league || "Sports").trim();
  const is24x7 = /24\s*(?:\/|x)\s*7/i.test(`${title} ${league} ${sport}`);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const endSeconds = timestamp > 0 ? timestamp + estimatedDurationSeconds(title, league, sport) : nowSeconds + 8 * 60 * 60;
  const status = timestamp > nowSeconds ? "upcoming" : (is24x7 || timestamp <= 0 || nowSeconds < endSeconds ? "live" : null);
  const sources = (Array.isArray(detail?.streams) ? detail.streams : [])
    .map(directSource).filter(Boolean)
    .filter((source, index, all) => all.findIndex((item) => item.url === source.url && item.clearKey === source.clearKey) === index);
  if (!title || !status || !sources.length) return null;
  return {
    id: `streamcorner-${job.provider}-${job.id}`, provider: "streamcorner", sourceId: job.id,
    title, league, sport,
    startsAt: timestamp > 0 ? new Date(timestamp * 1000).toISOString() : now.toISOString(),
    endsAt: new Date(endSeconds * 1000).toISOString(), status, is24x7,
    homeTeam: String(detail?.home_team || job.row.home_team || ""),
    awayTeam: String(detail?.away_team || job.row.away_team || ""),
    homeLogoUrl: String(detail?.home_team_logo || job.row.home_team_logo || ""),
    awayLogoUrl: String(detail?.away_team_logo || job.row.away_team_logo || ""),
    posterUrl: String(detail?.poster || job.row.poster || ""),
    categoryLogoUrl: String(detail?.category_logo || job.row.category_logo || ""),
    venue: String(detail?.venue?.fullName || detail?.venue_name || detail?.venue || detail?.location || job.row.venue || ""),
    sources,
  };
}

export async function fetchStreamCornerGames(now, estimatedDurationSeconds, fetcher = fetch) {
  const catalogCounts = Object.fromEntries(PROVIDERS.map((provider) => [provider, 0]));
  try {
    const runtime = await loadStreamCornerRuntime(fetcher);
    const decoder = decoderFor(runtime, fetcher);
    const catalogErrors = [];
    const catalogs = await Promise.all(PROVIDERS.map(async (provider) => {
      try {
        const result = await request(decoder, runtime.workers, provider);
        const rows = Array.isArray(result) ? result : (Array.isArray(result?.channels) ? result.channels : []);
        catalogCounts[provider] = rows.length;
        return rows.map((row) => ({ provider, row, id: String(row.stream_id || row.game_id || row.channel_id || "").trim() }))
          .filter((job) => job.id);
      } catch (error) {
        catalogErrors.push(`${provider}: ${String(error)}`);
        return [];
      }
    }));
    const jobs = [...new Map(catalogs.flat().map((job) => [`${job.provider}:${job.id}`, job])).values()]
      .filter((job) => {
        const starts = Number(job.row.timestamp || 0);
        if (!starts) return true;
        const title = String(job.row.event_name || job.row.title || "");
        const league = String(job.row.league || job.row.category || "");
        const sport = String(job.row.category || job.row.league || "");
        return starts + estimatedDurationSeconds(title, league, sport) > Math.floor(now.getTime() / 1000);
      }).slice(0, 300);
    const games = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          const detail = await request(decoder, runtime.workers, job.provider, job.id);
          const game = streamCornerGameFromDetail(job, detail, now, estimatedDurationSeconds);
          if (game) games.push(game);
        } catch { /* One rotating event does not invalidate another event's verified source. */ }
      }
    }));
    return {
      games, catalogCounts, decoderUrl: runtime.decoderUrl,
      warning: runtime.fallbackWarning,
      error: games.length ? "" : `no direct HLS/DASH sources passed validation (${catalogErrors.slice(0, 2).join("; ")})`,
    };
  } catch (error) {
    return { games: [], catalogCounts, decoderUrl: "", warning: "", error: String(error) };
  }
}
