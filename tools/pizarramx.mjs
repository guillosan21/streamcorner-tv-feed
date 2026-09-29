import { createHash } from "node:crypto";

export const PIZARRAMX_PAGE_URL = "https://pizarramx.com.mx/envivo";
export const PIZARRAMX_SOURCE_REF_PATTERN = /^pizarramx:v1~[em]~[0-9a-f]{64}~[0-9a-f]{64}$/;

const ORIGIN = "https://pizarramx.com.mx";
const ASSIGNMENTS = new Map([
  ["DATOS_REALES", { path: "/datos/salida/datos.js", root: "object", maxBytes: 512_000 }],
  ["TRANSMISIONES_MANUALES", { path: "/transmisiones-manuales.js", root: "array", maxBytes: 128_000 }],
]);
const MAX_PAGE_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 20_000;
const ALLOWED_EMBED_HOSTS = new Set(["la18hd.su", "exmxbxe.cfd", "streamx305.sbs"]);
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"]);

function skipTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("unterminated comment");
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function parseJsonValueEnd(source, start) {
  const first = source[start];
  if (first !== "{" && first !== "[") throw new Error("assignment value must be an object or array");
  const closers = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      closers.push(character === "{" ? "}" : "]");
      continue;
    }
    if (character === "}" || character === "]") {
      if (closers.pop() !== character) throw new Error("unbalanced JSON assignment");
      if (closers.length === 0) return index + 1;
    }
  }
  throw new Error("unterminated JSON assignment");
}

/** Parses one `window.NAME = JSON` assignment without evaluating JavaScript. */
export function parsePizarraMxAssignment(input, name) {
  const definition = ASSIGNMENTS.get(String(name || ""));
  if (!definition) throw new Error("unsupported assignment name");
  const source = String(input || "").replace(/^\uFEFF/, "");
  if (Buffer.byteLength(source, "utf8") > definition.maxBytes) throw new Error("assignment exceeds size limit");
  let index = skipTrivia(source, 0);
  if (!source.startsWith("window.", index)) throw new Error("expected window assignment");
  index += "window.".length;
  const variable = /^[A-Za-z_$][\w$]*/.exec(source.slice(index))?.[0] || "";
  if (variable !== name) throw new Error("unexpected assignment name");
  index += variable.length;
  index = skipTrivia(source, index);
  if (source[index] !== "=") throw new Error("expected assignment operator");
  index = skipTrivia(source, index + 1);
  const end = parseJsonValueEnd(source, index);
  let value;
  try { value = JSON.parse(source.slice(index, end)); }
  catch { throw new Error("assignment is not strict JSON"); }
  index = skipTrivia(source, end);
  if (source[index] === ";") index = skipTrivia(source, index + 1);
  if (index !== source.length) throw new Error("unexpected code after assignment");
  if (definition.root === "array" ? !Array.isArray(value) : !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("assignment has the wrong JSON root type");
  }
  return value;
}

function cleanLabel(value, maxLength = 100) {
  const label = String(value ?? "").normalize("NFC")
    .replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, " ").replace(/\s+/g, " ").trim();
  if (!label || label.length > maxLength) return "";
  return label;
}

function normalizedIdentityText(value) {
  return cleanLabel(value, 180).normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function htmlDecode(value) {
  return String(value || "").replace(/&amp;/gi, "&").replace(/&#0*38;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'");
}

function embedAddress(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 8_192) return "";
  if (!/<iframe\b/i.test(raw)) return htmlDecode(raw);
  const sources = [...raw.matchAll(/\bsrc\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gi)];
  if (sources.length !== 1) return "";
  return htmlDecode(sources[0][2] ?? sources[0][3] ?? "").trim();
}

function hasRawPathTraversal(value) {
  const match = /^https:\/\/[^/?#]*(\/[^?#]*)?/i.exec(value);
  if (!match) return false;
  let path = match[1] || "/";
  for (let pass = 0; pass < 8; pass += 1) {
    const segments = path.replaceAll("\\", "/").split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) return true;
    let decoded;
    try { decoded = decodeURIComponent(path); }
    catch { return true; }
    if (decoded === path) return false;
    path = decoded;
  }
  return true;
}

function canonicalEmbed(value) {
  const raw = embedAddress(value);
  if (!raw || /[\u0000-\u0020<>\\]/.test(raw) || /%(?![0-9a-f]{2})/i.test(raw)) return "";
  const queryStart = raw.indexOf("?");
  if (queryStart >= 0) {
    const rawQuery = raw.slice(queryStart + 1).split("#", 1)[0];
    const segments = rawQuery.split("&");
    if (!rawQuery || segments.some((segment) => !segment || !segment.includes("=") || segment.startsWith("="))) return "";
  }
  // WHATWG URL normalizes encoded dot segments, so reject traversal in the
  // original path before parsing can erase that evidence.
  if (hasRawPathTraversal(raw)) return "";
  let url;
  try { url = new URL(raw); } catch { return ""; }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      YOUTUBE_HOSTS.has(hostname) || !ALLOWED_EMBED_HOSTS.has(hostname)) return "";
  const canonicalQuery = () => {
    const entries = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    const params = new URLSearchParams();
    for (const [key, value] of entries) params.append(key, value);
    const query = params.toString();
    return query ? `?${query}` : "";
  };

  if (hostname === "la18hd.su") {
    if (url.pathname !== "/vivo/canales.php") return "";
    const values = url.searchParams.getAll("stream");
    if (values.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(values[0])) return "";
    return `https://la18hd.su/vivo/canales.php${canonicalQuery()}`;
  }
  if (hostname === "streamx305.sbs") {
    if (url.pathname !== "/global1.php") return "";
    const values = url.searchParams.getAll("channel");
    if (values.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(values[0])) return "";
    return `https://streamx305.sbs/global1.php${canonicalQuery()}`;
  }
  if (url.pathname.length < 2 || url.pathname.length > 256 ||
      !/^\/(?:[A-Za-z0-9][A-Za-z0-9._~-]{0,80})(?:\/[A-Za-z0-9][A-Za-z0-9._~-]{0,80})*\/?$/.test(url.pathname) ||
      url.pathname.split("/").some((part) => part === "." || part === "..")) return "";
  return `https://exmxbxe.cfd${url.pathname}${canonicalQuery()}`;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function makeSourceRef(kind, eventIdentity, canonicalUrl) {
  const eventDigest = sha256(`${kind === "e" ? "event" : "manual"}\0${eventIdentity}`);
  const embedDigest = sha256(canonicalUrl);
  return `pizarramx:v1~${kind}~${eventDigest}~${embedDigest}`;
}

function sourceOptions(options, kind, eventIdentity) {
  const rows = Array.isArray(options) ? options : [];
  const seen = new Set();
  const sources = [];
  for (const option of rows) {
    if (!option || typeof option !== "object" || Array.isArray(option)) continue;
    const canonicalUrl = canonicalEmbed(option.embed ?? option.url ?? option.src);
    if (!canonicalUrl) continue;
    const providerSourceRef = makeSourceRef(kind, eventIdentity, canonicalUrl);
    if (seen.has(providerSourceRef)) continue;
    seen.add(providerSourceRef);
    const label = cleanLabel(option.fuente ?? option.label ?? option.name, 64) || "Señal";
    sources.push({
      provider: "Pizarra MX",
      name: `Pizarra MX • ${label}`,
      url: "",
      embedUrl: "",
      providerSourceRef,
      providerGeneration: "v1",
      headers: {},
      clearKey: "",
    });
  }
  return sources;
}

function parseStartsAt(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return "";
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function pizarraSport(competition) {
  const value = String(competition || "").toLowerCase();
  if (/\b(?:nfl|american football|futbol americano)\b/.test(value)) return "American Football";
  if (/\b(?:nba|wnba|basketball|baloncesto)\b/.test(value)) return "Basketball";
  if (/\b(?:mlb|baseball|beisbol)\b/.test(value)) return "Baseball";
  if (/\b(?:nhl|hockey)\b/.test(value)) return "Hockey";
  if (/\b(?:ufc|mma|boxing|boxeo)\b/.test(value)) return "Combat Sports";
  return "Soccer";
}

function eventGame(row, detail, nowMs) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const eventId = String(row.id ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,119}$/.test(eventId)) return null;
  const state = String(row.status || "").trim().toLowerCase();
  if (state !== "live" && state !== "ns") return null;
  const homeTeam = cleanLabel(row.home, 80);
  const awayTeam = cleanLabel(row.away, 80);
  const league = cleanLabel(row.competition, 80);
  if (!homeTeam || !awayTeam || !league) return null;
  const startsAt = [row.kickoff, row.startsAt, row.startTime, row.fechaISO].map(parseStartsAt).find(Boolean) || "";
  // Upcoming cards need a real kickoff for Android's scheduled-event model.
  // Pizarra's date-only values cannot be safely combined with its display time.
  if (state === "ns" && !startsAt) return null;
  const kind = "e";
  const kickoffMs = Date.parse(startsAt || "");
  const futureProviderLive = state === "live" && Number.isFinite(nowMs) &&
    Number.isFinite(kickoffMs) && kickoffMs > nowMs;
  const live = state === "live" && !futureProviderLive;
  const sources = sourceOptions(detail?.directo, kind, eventId)
    .map((source) => state === "live" ? { ...source, availableBeforeKickoff: true } : source);
  if (!sources.length) return null;
  return {
    id: `pizarramx-${eventId}`,
    provider: "pizarramx",
    sourceId: eventId,
    title: `${homeTeam} vs ${awayTeam}`,
    league,
    sport: pizarraSport(league),
    startsAt,
    endsAt: "",
    status: live ? "live" : "upcoming",
    scheduleState: live ? "in" : "pre",
    is24x7: false,
    homeTeam,
    awayTeam,
    homeLogoUrl: "",
    awayLogoUrl: "",
    posterUrl: "",
    categoryLogoUrl: "",
    venue: cleanLabel(row.venue, 100),
    sources,
  };
}

function manualGame(row) {
  if (!row || typeof row !== "object" || Array.isArray(row) || row.activo !== true) return null;
  const homeTeam = cleanLabel(row.local, 80);
  const awayTeam = cleanLabel(row.visitante, 80);
  const league = cleanLabel(row.competicion, 80);
  if (!homeTeam || !awayTeam || !league) return null;
  const declaredKickoff = String(row.kickoff ?? "").trim();
  const eventKey = [league, homeTeam, awayTeam, declaredKickoff].map(normalizedIdentityText).join("\0");
  const eventDigest = sha256(`manual\0${eventKey}`);
  const sources = sourceOptions(row.opciones, "m", eventKey)
    .map((source) => ({ ...source, availableBeforeKickoff: true }));
  if (!sources.length) return null;
  return {
    id: `pizarramx-manual-${eventDigest}`,
    provider: "pizarramx",
    sourceId: eventDigest,
    title: `${homeTeam} vs ${awayTeam}`,
    league,
    sport: pizarraSport(league),
    // Manual transmissions have no stable provider event ID or reliable kickoff.
    startsAt: "",
    endsAt: "",
    status: "upcoming",
    scheduleState: "pre",
    is24x7: false,
    homeTeam,
    awayTeam,
    homeLogoUrl: "",
    awayLogoUrl: "",
    posterUrl: "",
    categoryLogoUrl: "",
    venue: "",
    sources,
  };
}

/** Maps the two static Pizarra data objects into URL-free opaque-source feed cards. */
export function parsePizarraMxCatalog(data, manual = [], now = new Date()) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.partidos)) {
    throw new Error("Pizarra DATOS_REALES must contain a partidos array");
  }
  const details = data.detalles && typeof data.detalles === "object" && !Array.isArray(data.detalles) ? data.detalles : {};
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const games = [];
  const gamesById = new Map();
  const addGame = (game) => {
    if (!game) return;
    const existing = gamesById.get(game.id);
    if (!existing) {
      gamesById.set(game.id, game);
      games.push(game);
      return;
    }
    const seenSources = new Set(existing.sources.map((source) => source.providerSourceRef));
    for (const source of game.sources) {
      if (seenSources.has(source.providerSourceRef)) continue;
      seenSources.add(source.providerSourceRef);
      existing.sources.push(source);
    }
  };
  for (const row of data.partidos) {
    addGame(eventGame(row, details[String(row?.id ?? "")], nowMs));
  }
  for (const row of Array.isArray(manual) ? manual : []) {
    addGame(manualGame(row));
  }
  return games;
}

/** Keeps only safe, not obviously expired Pizarra cards from a previous feed. */
export function retainPreviousPizarraMxGames(feed, now = new Date()) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs) || !Array.isArray(feed?.games)) return [];
  return feed.games.flatMap((game) => {
    if (!game || game.provider !== "pizarramx" || game.scheduleState === "post") return [];
    if (game.status !== "live" && game.status !== "upcoming") return [];
    const startsAt = Date.parse(game.startsAt || "");
    const untimedManual = !String(game.startsAt || "").trim() &&
      (game.sources || []).some((source) => source?.provider === "Pizarra MX" &&
        /^pizarramx:v1~m~[0-9a-f]{64}~[0-9a-f]{64}$/.test(String(source.providerSourceRef || "")));
    const futureProviderLive = game.status === "live" && Number.isFinite(startsAt) && startsAt > nowMs &&
      !String(game.scoreboardEventId || "").trim();
    const untimedManualAvailable = untimedManual &&
      (game.sources || []).some((source) => source?.provider === "Pizarra MX" &&
        source.availableBeforeKickoff === true && /^pizarramx:v1~m~[0-9a-f]{64}~[0-9a-f]{64}$/.test(String(source.providerSourceRef || "")));
    if (game.status === "upcoming" && !untimedManualAvailable && (!Number.isFinite(startsAt) || startsAt <= nowMs)) return [];
    if (game.status === "live" && Number.isFinite(startsAt) && nowMs - startsAt > 12 * 60 * 60 * 1000) return [];
    const sources = (Array.isArray(game.sources) ? game.sources : []).filter((source) =>
      source?.provider === "Pizarra MX" && PIZARRAMX_SOURCE_REF_PATTERN.test(String(source.providerSourceRef || "")) &&
      String(source.providerSourceRef) === String(source.providerSourceRef).trim() &&
      !source.url && !source.embedUrl && !Object.keys(source.headers || {}).length);
    if (!sources.length) return [];
    const normalizeToUpcoming = (untimedManual || futureProviderLive) && sources.length > 0;
    return [{
      ...game,
      ...(normalizeToUpcoming ? { status: "upcoming", scheduleState: "pre" } : {}),
      sources: normalizeToUpcoming ? sources.map((source) => ({ ...source, availableBeforeKickoff: true })) : sources,
    }];
  });
}

function htmlDecodeAttribute(value) {
  return String(value || "").replace(/&amp;/gi, "&").replace(/&#0*38;/gi, "&");
}

function scriptUrl(page, pathname) {
  const scriptSources = [...String(page || "").matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"'<>]{1,2048})\1[^>]*>/gi)]
    .map((match) => htmlDecodeAttribute(match[2]));
  for (const source of scriptSources) {
    let url;
    try { url = new URL(source, `${ORIGIN}/`); } catch { continue; }
    if (url.origin !== ORIGIN || url.pathname !== pathname || url.username || url.password || url.hash || url.port) continue;
    const entries = [...url.searchParams.entries()];
    if (entries.some(([key, value]) => key !== "v" || !/^[A-Za-z0-9._-]{1,40}$/.test(value)) ||
        entries.filter(([key]) => key === "v").length > 1) continue;
    url.searchParams.sort();
    return url.href;
  }
  return "";
}

async function boundedText(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("response exceeds size limit");
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let text = "";
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error("response exceeds size limit");
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("response exceeds size limit");
  return text;
}

function requestTimeout(value) {
  const timeout = Math.trunc(Number(value));
  return Number.isFinite(timeout) && timeout > 0 ? Math.min(MAX_TIMEOUT_MS, timeout) : DEFAULT_TIMEOUT_MS;
}

async function fetchText(url, maxBytes, fetcher, timeoutMs) {
  const response = await fetcher(url, {
    headers: { Accept: "text/html, application/javascript, text/javascript;q=0.9, */*;q=0.5", "User-Agent": "StreamCorner-TV-Feed/1.0" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response?.ok) throw new Error(`HTTP ${Number(response?.status) || 0}`);
  if (response.url) {
    const actual = new URL(response.url);
    const expected = new URL(url);
    if (actual.origin !== ORIGIN || actual.origin !== expected.origin || actual.pathname !== expected.pathname ||
        actual.search !== expected.search || actual.hash) throw new Error("unexpected response location");
  }
  return boundedText(response, maxBytes);
}

/** Fetches only the exact Pizarra page and same-origin data scripts it references. */
export async function fetchPizarraMxGames(now = new Date(), {
  fetcher = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetcher !== "function") return { games: [], catalogCount: 0, error: "fetch unavailable" };
  const timeout = requestTimeout(timeoutMs);
  try {
    const page = await fetchText(PIZARRAMX_PAGE_URL, MAX_PAGE_BYTES, fetcher, timeout);
    const dataUrl = scriptUrl(page, ASSIGNMENTS.get("DATOS_REALES").path);
    const manualUrl = scriptUrl(page, ASSIGNMENTS.get("TRANSMISIONES_MANUALES").path);
    if (!dataUrl || !manualUrl) throw new Error("expected same-origin data scripts were not found");
    const [dataText, manualText] = await Promise.all([
      fetchText(dataUrl, ASSIGNMENTS.get("DATOS_REALES").maxBytes, fetcher, timeout),
      fetchText(manualUrl, ASSIGNMENTS.get("TRANSMISIONES_MANUALES").maxBytes, fetcher, timeout),
    ]);
    const data = parsePizarraMxAssignment(dataText, "DATOS_REALES");
    const manual = parsePizarraMxAssignment(manualText, "TRANSMISIONES_MANUALES");
    const games = parsePizarraMxCatalog(data, manual, now);
    return { games, catalogCount: games.length, error: "" };
  } catch (error) {
    const message = String(error?.message || "");
    const errorLabel = /^HTTP \d+$/.test(message) ? message :
      message === "response exceeds size limit" ? message : "source unavailable or invalid";
    return { games: [], catalogCount: 0, error: errorLabel };
  }
}
