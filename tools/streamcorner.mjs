import vm from "node:vm";
import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const SITE = "https://streamcorner.st/";
// #001 uses the exact versioned native HLS binding, independently verified on Android.
const PROVIDERS = ["admin", "nba", "nfl", "alpha", "beta", "001", "003"];
const MAX_ASSET_BYTES = 600_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const WORKER_HOST = /^data\.[a-z0-9-]+\.workers\.dev$/;
const DIRECT_PATH = /\.(?:m3u8|mpd)$/i;
const INGEST_PATH = /^\/embed\/ingest\/(?:[A-Za-z0-9_-]{1,64}\/){0,3}[A-Za-z0-9_-]{1,128}\/?$/;
const INGEST_FRAGMENT = "#player=clappr&autoplay=true";
const MAX_WRAPPER_BYTES = 100_000;
// Exact observed 003 player bootstrap. Captures only the literal assigned to the mounted iframe.
const INGEST_BOOTSTRAP = /^\s*\(\(\)\s*=>\s*\{\s*const\s+playerFrame\s*=\s*document\.createElement\(\s*(["'])iframe\1\s*\)\s*;\s*playerFrame\.allow\s*=\s*(["'])autoplay;encrypted-media;picture-in-picture;fullscreen\2\s*;\s*playerFrame\.allowFullscreen\s*=\s*true\s*;\s*playerFrame\.src\s*=\s*atob\(\s*(["'])([A-Za-z0-9+/]{1,4096}={0,2})\3\s*\)\s*;\s*document\.getElementById\(\s*(["'])player\5\s*\)\.appendChild\(\s*playerFrame\s*\)\s*;\s*\}\)\(\)\s*;\s*$/;

const WRAPPER_ELEMENTS = new Set(["html", "head", "body", "meta", "link", "div", "section", "span", "p", "a", "script", "style", "noscript", "textarea", "title", "xmp", "br", "img"]);
const WRAPPER_VOID_ELEMENTS = new Set(["meta", "link", "br", "img"]);
const WRAPPER_RAW_ELEMENTS = new Set(["script", "style", "noscript", "textarea", "title", "xmp"]);

/** Minimal fail-closed HTML lexer, bounded by MAX_WRAPPER_BYTES. Attribute values are
 * consumed whole, so quoted markup never becomes an element or a second attribute. */
function wrapperTag(html, start) {
  let cursor = start + 1;
  const closing = html[cursor] === "/";
  if (closing) cursor++;
  const nameStart = cursor;
  while (/[A-Za-z0-9-]/.test(html[cursor] || "") && cursor < html.length) cursor++;
  if (cursor === nameStart) return null;
  const name = html.slice(nameStart, cursor).toLowerCase();
  const attrs = new Map();
  while (cursor < html.length) {
    const gapStart = cursor;
    while (/\s/.test(html[cursor] || "") && cursor < html.length) cursor++;
    if (html[cursor] === ">") return { name, closing, attrs, end: cursor + 1 };
    if (html[cursor] === "/" && html[cursor + 1] === ">" && !closing && WRAPPER_VOID_ELEMENTS.has(name)) {
      return { name, closing, attrs, end: cursor + 2 };
    }
    if (closing || cursor === gapStart) return null;
    const attrStart = cursor;
    while (cursor < html.length && !/[\s"'<>\/=]/.test(html[cursor])) cursor++;
    if (cursor === attrStart) return null;
    const key = html.slice(attrStart, cursor).toLowerCase();
    if (attrs.has(key) || key.startsWith("on")) return null;
    const attrNameEnd = cursor;
    while (/\s/.test(html[cursor] || "") && cursor < html.length) cursor++;
    let value = "";
    if (html[cursor] === "=") {
      cursor++;
      while (/\s/.test(html[cursor] || "") && cursor < html.length) cursor++;
      const quote = html[cursor];
      if (quote === '"' || quote === "'") {
        const valueStart = ++cursor;
        while (cursor < html.length && html[cursor] !== quote) cursor++;
        if (cursor === html.length) return null;
        value = html.slice(valueStart, cursor++);
      } else {
        const valueStart = cursor;
        while (cursor < html.length && !/[\s>]/.test(html[cursor])) {
          if (/["'<=`]/.test(html[cursor])) return null;
          cursor++;
        }
        if (cursor === valueStart) return null;
        value = html.slice(valueStart, cursor);
      }
    } else cursor = attrNameEnd;
    // Entity-encoded IDs can alias the active mount in browser parsing.
    if (key === "id" && value.includes("&")) return null;
    attrs.set(key, value);
  }
  return null;
}

function ingestBootstrapPayload(html) {
  const scripts = [];
  let playerIds = 0;
  let mounts = 0;
  let cursor = 0;
  const lower = html.toLowerCase();
  while (cursor < html.length) {
    if (html[cursor] !== "<") { cursor++; continue; }
    if (html.startsWith("<!--", cursor)) {
      const end = html.indexOf("-->", cursor + 4);
      if (end < 0) return null;
      cursor = end + 3;
      continue;
    }
    if (lower.startsWith("<!doctype", cursor)) {
      const declaration = /^<!doctype\s+html\s*>/i.exec(html.slice(cursor));
      if (!declaration) return null;
      cursor += declaration[0].length;
      continue;
    }
    const tag = wrapperTag(html, cursor);
    // Exclude template/foreign/parser-sensitive contexts instead of approximating
    // their DOM construction, foster parenting or inert descendants.
    if (!tag || !WRAPPER_ELEMENTS.has(tag.name)) return null;
    cursor = tag.end;
    if (tag.closing) {
      if (WRAPPER_RAW_ELEMENTS.has(tag.name)) return null;
      continue;
    }
    if (tag.attrs.get("id") === "player") {
      playerIds++;
      if (tag.name === "div" || tag.name === "section") mounts++;
    }
    if (!WRAPPER_RAW_ELEMENTS.has(tag.name)) continue;
    const contentStart = cursor;
    let close;
    while (cursor < html.length) {
      const next = lower.indexOf(`</${tag.name}`, cursor);
      if (next < 0) return null;
      const boundary = html[next + tag.name.length + 2];
      if (boundary === ">" || /\s/.test(boundary || "")) {
        close = wrapperTag(html, next);
        if (!close || !close.closing || close.name !== tag.name) return null;
        cursor = close.end;
        if (tag.name === "script") scripts.push({ attrs: tag.attrs, content: html.slice(contentStart, next) });
        break;
      }
      cursor = next + 2;
    }
    if (!close) return null;
  }
  const bootstraps = scripts.map((script) => ({ script, match: INGEST_BOOTSTRAP.exec(script.content) }))
    .filter(({ script, match }) => match && match[0] === script.content && !script.attrs.size);
  if (mounts !== 1 || playerIds !== 1 || bootstraps.length !== 1 || [...html.matchAll(/\batob\s*\(/g)].length !== 1) return null;
  const selected = bootstraps[0];
  if (scripts.some((script) => script !== selected.script &&
      /\b(?:atob|playerFrame|location)\b|createElement\s*\(\s*["']iframe["']/.test(script.content))) return null;
  return selected.match[4];
}

/** Read only the verified 003 wrapper; never execute its JavaScript or follow redirects. */
export async function resolveStreamCornerIngestSource(provider, source, index = 0, fetcher = fetch) {
  const wrapper = source?.embed_url;
  if (["alpha", "beta"].includes(provider) && typeof wrapper === "string" && wrapper.length <= 1100 &&
      /^https:\/\/amazon\.com\.pandecocogaming\.sbs\/\?p=[A-Za-z0-9_-]{32,1024}={0,2}$/.test(wrapper) &&
      wrapper === wrapper.trim() && !source.stream_url && !source.stream_keys) {
    const channel = String(source.source_name || `Source ${index + 1}`).trim().slice(0, 70);
    return {provider:"StreamCorner", embedProvider:"StreamCorner", name:`StreamCorner • ${provider.toUpperCase()} ${channel}`,
      url:"", embedUrl:wrapper, clearKey:"", headers:{Referer:SITE},
      providerSourceRef:`streamcorner:v3~${Buffer.from(wrapper,"utf8").toString("base64url")}`,
      providerGeneration:"v3", availabilityEvidence:"provider-reported"};
  }
  if (provider === "001" && typeof wrapper === "string" &&
      /^https:\/\/taifood-blog\.asia\/embed\/(?:nhl|nfl|mlb|nba|soccer|ucl|efl-league-two|efl-championship)\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/[a-z0-9]+(?:-[a-z0-9]+){1,8}$/.test(wrapper) &&
      wrapper === wrapper.trim() && !source.stream_url && !source.stream_keys) {
    const path = new URL(wrapper).pathname;
    const channel = String(source.source_name || `Source ${index + 1}`).trim().slice(0, 70);
    return {provider: "StreamCorner", embedProvider: "StreamCorner", name: `StreamCorner • #001 ${channel}`,
      url: "", embedUrl: wrapper, clearKey: "", headers: {Referer: SITE},
      providerSourceRef: `streamcorner:v2~${Buffer.from(path, "utf8").toString("base64url")}`,
      providerGeneration: "v2", availabilityEvidence: "provider-reported"};
  }
  if (provider !== "003" || typeof wrapper !== "string" ||
      wrapper !== wrapper.trim() ||
      !/^https:\/\/rockyembed\.st\/source\/fetch\.php\?hd=[0-9]+$/.test(wrapper) ||
      source?.stream_url || source?.stream_keys) return null;
  try {
    const signal = AbortSignal.timeout(8_000);
    const response = await fetcher(wrapper, { signal, redirect: "error" });
    if (!response.ok || response.redirected || (response.url && response.url !== wrapper) ||
        Number(response.headers.get("content-length") || 0) > MAX_WRAPPER_BYTES || !response.body) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_WRAPPER_BYTES) return null;
        chunks.push(Buffer.from(value));
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    const html = Buffer.concat(chunks).toString("utf8");
    const encoded = ingestBootstrapPayload(html);
    if (!encoded) return null;
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) return null;
    const target = decoded.toString("utf8");
    // Match the raw spelling before URL parsing can normalize ports, dot segments or escapes.
    const match = /^https:\/\/embed\.st(\/embed\/ingest\/[^?#]+)(#player=clappr&autoplay=true)?$/.exec(target);
    if (!match || match[0] !== target || !INGEST_PATH.test(match[1])) return null;
    const path = match[1];
    const channel = String(source?.source_name || `Source ${index + 1}`).trim().slice(0, 70);
    return {
      provider: "StreamCorner", embedProvider: "StreamCorner", name: `StreamCorner • ${channel || `Source ${index + 1}`}`,
      url: "", embedUrl: `https://embed.st${path}${INGEST_FRAGMENT}`, clearKey: "", headers: { Referer: SITE },
      providerSourceRef: `streamcorner:v1~${Buffer.from(path, "utf8").toString("base64url")}`,
      providerGeneration: "v1", availabilityEvidence: "provider-reported",
      ...(typeof source?.hd === "boolean" ? { hd: source.hd } : {}),
      ...(Number.isInteger(source?.maxHeight) ? { maxHeight: source.maxHeight } : {}),
    };
  } catch { return null; }
}

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

export function decoderFor(runtime, fetcher) {
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
    TextEncoder, TextDecoder, ArrayBuffer, atob, btoa, setTimeout, clearTimeout,
    AbortController, AbortSignal,
  };
  vm.createContext(sandbox);
  const source = runtime.decoderCode.replace(/export\{[^}]+\};?/, `globalThis.__decode=${runtime.decoderExport};`);
  vm.runInContext(source, sandbox, { timeout: 2_000 });
  if (typeof sandbox.__decode !== "function") throw new Error("StreamCorner decoder did not initialize");
  // Invoke untrusted synchronous decoder work inside the same bounded VM. Keep arguments
  // private to this factory invocation, and remove them even when execution times out.
  const argumentKey = `__streamCornerArgs_${randomUUID().replaceAll("-", "")}`;
  return (...args) => {
    sandbox[argumentKey] = args;
    try {
      return vm.runInContext(`globalThis.__decode(...globalThis[${JSON.stringify(argumentKey)}])`, sandbox, { timeout: 2_000 });
    } finally {
      delete sandbox[argumentKey];
    }
  };
}

/** Parent deadline also interrupts decoder work resumed after an async boundary.
 * A worker is CPU/lifetime isolation, not a security sandbox for arbitrary code.
 */
export function isolatedDecoderFor(runtime, timeoutMs = 13_000) {
  return (...args) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./streamcorner-decoder-worker.mjs', import.meta.url), {
      workerData: { runtime, args },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('provider decoder timed out')), timeoutMs);
    worker.once('message', result => result.ok ? finish(null, result.value) : finish(new Error('provider decoder failed')));
    worker.once('error', () => finish(new Error('provider decoder failed')));
    worker.once('exit', () => { if (!settled) finish(new Error('provider decoder exited')); });
  });
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

export function streamCornerGameFromDetail(job, detail, now, estimatedDurationSeconds, nativeSources = []) {
  const timestamp = Number(detail?.timestamp || job.row.timestamp || 0);
  const title = String(detail?.event_name || job.row.event_name || detail?.title || job.row.title || "").trim();
  const league = String(detail?.league || detail?.category || job.row.league || job.row.category || "Sports").trim();
  const sport = String(detail?.category || job.row.category || detail?.league || job.row.league || "Sports").trim();
  const is24x7 = /24\s*(?:\/|x)\s*7/i.test(`${title} ${league} ${sport}`);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const endSeconds = timestamp > 0 ? timestamp + estimatedDurationSeconds(title, league, sport) : nowSeconds + 8 * 60 * 60;
  const status = timestamp > nowSeconds ? "upcoming" : (is24x7 || timestamp <= 0 || nowSeconds < endSeconds ? "live" : null);
  const sources = [...(Array.isArray(detail?.streams) ? detail.streams : []).map(directSource).filter(Boolean), ...nativeSources]
    .filter((source, index, all) => all.findIndex((item) => item.url === source.url && item.clearKey === source.clearKey &&
      item.embedUrl === source.embedUrl && item.providerSourceRef === source.providerSourceRef) === index);
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
    const decoder = fetcher === fetch ? isolatedDecoderFor(runtime) : decoderFor(runtime, fetcher);
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
          const streams = Array.isArray(detail?.streams) ? detail.streams.slice(0, 30) : [];
          const nativeSources = (await Promise.all(streams.map((source, index) =>
            resolveStreamCornerIngestSource(job.provider, source, index, fetcher)))).filter(Boolean);
          const game = streamCornerGameFromDetail(job, detail, now, estimatedDurationSeconds, nativeSources);
          if (game) games.push(game);
        } catch { /* One rotating event does not invalidate another event's verified source. */ }
      }
    }));
    return {
      games, catalogCounts, decoderUrl: runtime.decoderUrl,
      warning: runtime.fallbackWarning,
      error: games.length ? "" : `no direct HLS/DASH or native ingest sources passed validation (${catalogErrors.slice(0, 2).join("; ")})`,
    };
  } catch (error) {
    return { games: [], catalogCounts, decoderUrl: "", warning: "", error: String(error) };
  }
}
