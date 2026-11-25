import { createCipheriv, createHash, randomBytes } from "node:crypto";

export const ZLIVE_STREAMS_ENDPOINT = "https://iptv.zlive.st/streams";
const ZLIVE_SITE_ORIGIN = "https://zlive.st";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 20_000;

// These are the public bundle's XOR-obfuscated client-string bytes and XOR key.
// The bundle decodes them with output[i] = bytes[i] ^ key[i % key.length].
// No account token or per-user secret is embedded here.
const CLIENT_STRING_BYTES = Uint8Array.from([
  90, 60, 239, 235, 212, 205, 249, 180, 217, 191, 73, 88, 239, 208, 186,
  248, 244, 243, 198, 162, 91, 95, 133, 199, 145, 194, 247, 197, 242, 192,
  106, 34, 145, 129, 180, 191, 241, 182, 152, 253, 88, 53, 238,
]);
const CLIENT_STRING_XOR_KEY = Uint8Array.from([40, 111, 218, 177, 249, 137, 188, 132, 160, 143]);
const ZLIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,119}$/;
const ZLIVE_SOURCE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const MAX_EVENT_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_MS = 14 * 24 * 60 * 60 * 1000;

function clientString() {
  let value = "";
  for (let index = 0; index < CLIENT_STRING_BYTES.length; index += 1) {
    value += String.fromCharCode(CLIENT_STRING_BYTES[index] ^ CLIENT_STRING_XOR_KEY[index % CLIENT_STRING_XOR_KEY.length]);
  }
  return value;
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function utcDateStamp(date) {
  return date.toISOString().slice(0, 10);
}

/** Reproduces the public client AES-GCM request envelope for /streams. */
export function encodeZLiveStreamsRequest(now = new Date(), ivBytes = randomBytes(12)) {
  const instant = asDate(now);
  if (!instant) throw new TypeError("A valid ZLive request time is required");
  const iv = Buffer.from(ivBytes);
  if (iv.length !== 12) throw new TypeError("ZLive AES-GCM requires a 12-byte IV");

  const date = utcDateStamp(instant);
  const key = createHash("sha256").update(`${clientString()}:${date}`, "utf8").digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify({ ts: Math.floor(instant.getTime() / 1000) }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    q: ciphertext.toString("base64"),
    s: iv.toString("base64"),
    t: cipher.getAuthTag().toString("base64"),
    d: date,
  };
}

/** Only short, URL-free opaque event IDs may become public resolver refs. */
export function zliveSourceRef(value) {
  const id = String(value ?? "");
  if (!ZLIVE_ID_PATTERN.test(id) || id === "." || id === "..") return "";
  return `zlive:${id}`;
}

function zliveSport(type) {
  const value = String(type || "").normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ").trim();
  const key = value.toLowerCase();
  if (!key || key.length > 80) return null;

  if (/\b(?:american football|nfl)\b/.test(key)) return { sport: "American Football", league: /\bnfl\b/.test(key) ? "NFL" : value };
  if (/\bwnba\b/.test(key)) return { sport: "Basketball", league: "WNBA" };
  if (/\bnba\b/.test(key)) return { sport: "Basketball", league: "NBA" };
  if (/\b(?:basketball)\b/.test(key)) return { sport: "Basketball", league: value };
  if (/\bmlb\b|\bbaseball\b/.test(key)) return { sport: "Baseball", league: /\bmlb\b/.test(key) ? "MLB" : value };
  if (/\bnhl\b|\bice hockey\b|\bhockey\b/.test(key)) return { sport: "Hockey", league: /\bnhl\b/.test(key) ? "NHL" : value };
  if (/\bsoccer\b|\bpremier league\b|\bla liga\b|\blaliga\b|\bserie a\b|\bbundesliga\b|\bligue\s*1\b|\buefa\b|\bchampions league\b|\beuropa league\b|\bliga mx\b|\bmls\b|\bnwsl\b/.test(key)) {
    return { sport: "Soccer", league: value };
  }
  if (/\b(?:tennis)\b/.test(key)) return { sport: "Tennis", league: value };
  if (/\b(?:cricket)\b/.test(key)) return { sport: "Cricket", league: value };
  if (/\b(?:golf)\b/.test(key)) return { sport: "Golf", league: value };
  if (/\b(?:mma|ufc|boxing)\b/.test(key)) return { sport: "Combat", league: /\bufc\b/.test(key) ? "UFC" : value };
  if (/\b(?:motorsport|motor racing|formula\s*1|f1)\b/.test(key)) return { sport: "Motorsports", league: value };
  if (/\b(?:rugby)\b/.test(key)) return { sport: "Rugby", league: value };
  // Bare "football" is ambiguous between association and American football.
  return null;
}

function parseStartTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  if (/^\d{9,13}$/.test(raw)) {
    const numeric = Number(raw);
    return new Date(raw.length <= 10 ? numeric * 1000 : numeric);
  }
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

function safeThumbnail(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2048 || /[\s\u0000-\u001f]/.test(raw)) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) return "";
    return url.href;
  } catch {
    return "";
  }
}

function cleanTitle(value) {
  const title = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!title || title.length > 200 || /^https?:\/\//i.test(title)) return "";
  return title.replace(/\s+/g, " ");
}

function safeSourceInfo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = String(value.key ?? "");
  if (!ZLIVE_SOURCE_KEY_PATTERN.test(key)) return null;
  const rawLabel = String(value.label ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  const label = !rawLabel || rawLabel.length > 64 || /(?:https?:\/\/|www\.)/i.test(rawLabel) ? "Main" : rawLabel;
  return { label };
}

function eventRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray(payload.events)) return payload.events;
  return [];
}

function zliveSource(ref, label) {
  return {
    provider: "ZLive",
    name: `ZLive • ${label}`,
    url: "",
    embedUrl: "",
    providerSourceRef: ref,
    providerGeneration: "v1",
    headers: {},
    clearKey: "",
  };
}

/** Maps catalog metadata only. The response's `sources` field is intentionally discarded. */
export function parseZLiveEvents(payload, now = new Date()) {
  const instant = asDate(now);
  if (!instant) return [];
  const current = instant.getTime();
  const byRef = new Map();
  for (const row of eventRows(payload)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const ref = zliveSourceRef(row.id);
    const title = cleanTitle(row.name);
    const type = zliveSport(row.type);
    const start = parseStartTime(row.startTime);
    const source = safeSourceInfo(row.source);
    if (!ref || !title || !type || !source || !start || !Number.isFinite(start.getTime()) ||
        typeof row.live !== "boolean" || start.getTime() < current - MAX_EVENT_AGE_MS ||
        start.getTime() > current + MAX_EVENT_FUTURE_MS) continue;

    const previous = byRef.get(ref);
    if (previous && (previous.status === "live" || row.live !== true)) continue;
    const durationHours = /baseball|american football|motorsports/i.test(type.sport) ? 6 : 4;
    const game = {
      id: ref,
      provider: "zlive",
      sourceId: ref,
      title,
      league: type.league,
      sport: type.sport,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + durationHours * 60 * 60 * 1000).toISOString(),
      status: row.live ? "live" : "upcoming",
      is24x7: false,
      homeTeam: "",
      awayTeam: "",
      homeLogoUrl: "",
      awayLogoUrl: "",
      posterUrl: safeThumbnail(row.thumbnail),
      categoryLogoUrl: "",
      venue: "",
      // The client resolves by event ID alone; source.key is only availability metadata.
      sources: [zliveSource(ref, source.label)],
    };
    byRef.set(ref, game);
  }
  return [...byRef.values()];
}

async function readBoundedJson(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw new Error("response too large");
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
        if (total > MAX_RESPONSE_BYTES) throw new Error("response too large");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(text);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("response too large");
  return JSON.parse(text);
}

function safeTimeout(value) {
  const timeout = Math.trunc(Number(value));
  return Number.isFinite(timeout) && timeout > 0 ? Math.min(MAX_TIMEOUT_MS, timeout) : DEFAULT_TIMEOUT_MS;
}

/** Fetches one public event catalog with bounded time and body size; failures are isolated. */
export async function fetchZLiveGames(now = new Date(), {
  fetcher = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ivBytes,
} = {}) {
  const instant = asDate(now);
  if (!instant) return { games: [], catalogCount: 0, error: "invalid request time" };
  if (typeof fetcher !== "function") return { games: [], catalogCount: 0, error: "fetch is unavailable" };
  let body;
  try {
    body = encodeZLiveStreamsRequest(instant, ivBytes ?? randomBytes(12));
  } catch {
    return { games: [], catalogCount: 0, error: "request encoding failed" };
  }

  let response;
  try {
    response = await fetcher(ZLIVE_STREAMS_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: ZLIVE_SITE_ORIGIN,
        Referer: `${ZLIVE_SITE_ORIGIN}/streams`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(safeTimeout(timeoutMs)),
    });
  } catch (error) {
    return {
      games: [], catalogCount: 0,
      error: error?.name === "TimeoutError" || error?.name === "AbortError" ? "request timed out" : "request failed",
    };
  }
  if (!response?.ok) {
    await response?.body?.cancel?.().catch(() => {});
    return { games: [], catalogCount: 0, error: `HTTP ${Number(response?.status) || 0}` };
  }
  try {
    const payload = await readBoundedJson(response);
    const games = parseZLiveEvents(payload, instant);
    return { games, catalogCount: games.length, error: "" };
  } catch (error) {
    const message = String(error?.message || "");
    return { games: [], catalogCount: 0, error: message === "response too large" ? message : "invalid JSON response" };
  }
}
