const API_BASE = "https://streamed.pk/api";
const EMBED_HOST = "embed.st";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_EVENTS = 18;
const MAX_BODY_BYTES = 512_000;
const MAX_MQTT_BYTES = 65_536;

export function sportsUpaMainTopic(id) {
  if (typeof id !== "string" || !id || id.length > 180) return "";
  return `sportsupa-best-v2/${id.replace(/[^a-z0-9]/gi, "-").slice(0, 60)}`;
}

/** Parse MQTT data only. No wildcard subscriptions, JavaScript execution or publishing. */
export function parseSportsUpaMainPayload(payload) {
  if (typeof payload !== "string" || Buffer.byteLength(payload) > MAX_MQTT_BYTES) return [];
  try {
    const rows = JSON.parse(payload);
    if (!Array.isArray(rows) || rows.length > 16) return [];
    return rows.filter((row) => row && (typeof row.id === "number" || typeof row.id === "string") &&
      typeof row.url === "string" && row.url.length < 4096 &&
      (row.language === undefined || typeof row.language === "string"));
  } catch { return []; }
}

function safeMainEmbed(value) {
  try {
    if (typeof value !== "string" || !/^https:\/\/embed\.st\/embed\/ingest\/[A-Za-z0-9_-]{1,100}\/[1-9][0-9]{0,2}\/(?:#player=clappr&autoplay=true)?$/.test(value)) return "";
    const u = new URL(value);
    // Public bootstrap player preferences are not identity or media credentials.
    if (u.hash === "#player=clappr&autoplay=true") u.hash = "";
    if (u.protocol === "https:" && u.hostname === EMBED_HOST && !u.port && !u.username &&
        !u.password && !u.search && !u.hash && /^\/embed\/ingest\/[A-Za-z0-9_-]{1,100}\/[1-9][0-9]{0,2}\/$/.test(u.pathname)) return u.href;
  } catch {}
  return "";
}

export function isSportsUpaMainSource(source) {
  return source?.provider === "SportsUpa" && source.embedProvider === "SportsUpa" && source.hd === true &&
    source.url === "" && typeof source.embedUrl === "string" && safeMainEmbed(source.embedUrl) === source.embedUrl &&
    !source.providerSourceRef && !source.clearKey &&
    Object.keys(source.headers || {}).length === 1 && source.headers.Referer === "https://sportsupa.st/";
}

export function sportsUpaMainWrapperUrl(value) {
  try {
    if (typeof value !== "string" || !/^https:\/\/rockystream\.st\/source\/fetch\.php\?[^#\s]+$/.test(value)) return "";
    const u = new URL(value);
    if (u.protocol === "https:" && u.hostname === "rockystream.st" && !u.port &&
        !u.username && !u.password && !u.hash && u.pathname === "/source/fetch.php" &&
        u.search && u.href.length < 4096) return u.href;
  } catch {}
  return "";
}

/** Decode only literal atob data. Never evaluate the remote wrapper's scripts. */
export function decodeSportsUpaMainWrapper(html) {
  if (typeof html !== "string" || Buffer.byteLength(html) > MAX_BODY_BYTES) return "";
  const urls = new Set();
  for (const match of html.matchAll(/\batob\(\s*(['"])([A-Za-z0-9+/]{1,2048}={0,2})\1\s*\)/g)) {
    const data = match[2];
    if (data.length % 4 !== 0) continue;
    const decoded = Buffer.from(data, "base64");
    if (decoded.toString("base64") !== data) continue;
    const url = safeMainEmbed(decoded.toString("utf8"));
    if (url) urls.add(url);
  }
  return urls.size === 1 ? [...urls][0] : "";
}

/** A fresh provider declaration, not a measurement of each stream's resolution. */
export function sportsUpaMainDeclaredHd(html) {
  if (typeof html !== "string" || Buffer.byteLength(html) > MAX_BODY_BYTES) return false;
  const renderer = html.match(/function renderBestStreams\(\)\{([\s\S]*?)\n\}/)?.[1] || "";
  return /const streams=getBestStreams\(\)/.test(renderer) && /streams\.forEach\(/.test(renderer) &&
    /row\.dataset\.url=s\.url/.test(renderer) &&
    /row\.innerHTML=`<span class="event-source-qual qual-hd">HD<\/span>/.test(renderer);
}

async function publicText(fetchImpl, url) {
  const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers?.get("content-length")) > MAX_BODY_BYTES) throw new Error("body limit");
  if (!response.body) {
    const value = await response.text();
    if (Buffer.byteLength(value) > MAX_BODY_BYTES) throw new Error("body limit");
    return value;
  }
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("body limit");
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(parts).toString("utf8");
}

function mqttString(value) {
  const data = Buffer.from(value);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length);
  return Buffer.concat([length, data]);
}

function mqttPacket(type, body) {
  const length = [];
  let remaining = body.length;
  do { const digit = remaining % 128; remaining = Math.floor(remaining / 128); length.push(digit | (remaining ? 128 : 0)); } while (remaining);
  return Buffer.concat([Buffer.from([type, ...length]), body]);
}

/** Decode complete packets and retain incomplete tails for the next WebSocket frame. */
export function parseSportsUpaMqttPackets(bytes) {
  if (bytes.length > MAX_MQTT_BYTES * 2) throw new Error("MQTT body limit");
  const packets = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = offset + 1, length = 0, multiplier = 1, complete = false;
    for (let digit = 0; digit < 4; digit++) {
      if (end >= bytes.length) return { packets, rest: bytes.subarray(offset) };
      const byte = bytes[end++];
      length += (byte & 127) * multiplier;
      if (!(byte & 128)) { complete = true; break; }
      multiplier *= 128;
    }
    if (!complete || length > MAX_MQTT_BYTES) throw new Error("invalid MQTT length");
    if (end + length > bytes.length) break;
    const body = bytes.subarray(end, end + length);
    const type = bytes[offset] >> 4;
    if (type === 3) {
      const qos = (bytes[offset] >> 1) & 3;
      if (body.length < 2 || qos > 1) throw new Error("invalid MQTT publish");
      const topicLength = body.readUInt16BE(0);
      const start = 2 + topicLength + (qos ? 2 : 0);
      if (start > body.length) throw new Error("invalid MQTT topic");
      packets.push({ type, topic: body.subarray(2, 2 + topicLength).toString(), payload: body.subarray(start).toString() });
    } else packets.push({ type, body });
    offset = end + length;
  }
  return { packets, rest: bytes.subarray(offset) };
}

export async function readSportsUpaMainTopics(topics, { WebSocketImpl = WebSocket, timeoutMs = 8000 } = {}) {
  const allowed = new Set(topics.filter((topic) => /^sportsupa-best-v2\/[a-zA-Z0-9-]{1,60}$/.test(topic)).slice(0, MAX_EVENTS));
  if (!allowed.size) return new Map();
  return new Promise((resolve) => {
    const found = new Map();
    const socket = new WebSocketImpl("wss://broker.hivemq.com:8884/mqtt", "mqtt");
    socket.binaryType = "arraybuffer";
    let rest = Buffer.alloc(0), finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve(found);
    };
    const timer = setTimeout(finish, Math.min(REQUEST_TIMEOUT_MS, Math.max(1, timeoutMs)));
    socket.addEventListener("error", finish);
    socket.addEventListener("close", finish);
    socket.addEventListener("open", () => {
      socket.send(mqttPacket(0x10, Buffer.concat([mqttString("MQTT"), Buffer.from([4, 2, 0, 15]), mqttString(`sportsupa-read-${Math.random().toString(36).slice(2, 12)}`)])));
    });
    socket.addEventListener("message", (event) => {
      try {
        const parsed = parseSportsUpaMqttPackets(Buffer.concat([rest, Buffer.from(event.data)]));
        rest = parsed.rest;
        for (const packet of parsed.packets) {
          if (packet.type === 2) {
            if (packet.body.length !== 2 || packet.body[1] !== 0) return finish();
            socket.send(mqttPacket(0x82, Buffer.concat([Buffer.from([0, 1]), ...[...allowed].flatMap((topic) => [mqttString(topic), Buffer.from([0])])])));
          } else if (packet.type === 3 && allowed.has(packet.topic)) {
            found.set(packet.topic, parseSportsUpaMainPayload(packet.payload));
          }
        }
        if (found.size === allowed.size) finish();
      } catch { finish(); }
    });
  });
}

/** Normal feed: exact public Main topics only; canonical stable embeds only. */
export async function collectSportsUpaMainGames({ fetchImpl = fetch, readTopics = readSportsUpaMainTopics, now = new Date(), eventIds } = {}) {
  const matches = rowsFrom(await getJson(fetchImpl, `${API_BASE}/matches/all`));
  const candidates = matches.filter((match) => eventId(match) && asIsoDate(match) &&
    teamNames(match).home && teamNames(match).away && (!eventIds || eventIds.includes(eventId(match))))
    .sort((a, b) => {
      const x = kickoffPriority(a, now.getTime()), y = kickoffPriority(b, now.getTime());
      return x[0] - y[0] || x[1] - y[1] || eventId(a).localeCompare(eventId(b));
    }).slice(0, MAX_EVENTS);
  // Sanitizing/truncating is the site's wire format. Refuse catalog collisions rather than misbind an event.
  const counts = new Map();
  for (const match of matches) {
    const topic = sportsUpaMainTopic(eventId(match));
    counts.set(topic, (counts.get(topic) || 0) + 1);
  }
  const selected = candidates.filter((match) => counts.get(sportsUpaMainTopic(eventId(match))) === 1);
  if (!selected.length) return [];
  const declaredHd = sportsUpaMainDeclaredHd(await publicText(fetchImpl,
    `https://sportsupa.st/event/?id=${encodeURIComponent(eventId(selected[0]))}`));
  if (!declaredHd) return [];
  const topics = await readTopics(selected.map((match) => sportsUpaMainTopic(eventId(match))));
  const games = [];
  // At most 18 events x two Main selections; concurrency bounded to six.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, selected.length) }, async () => {
    while (next < selected.length) {
      const match = selected[next++];
      const rows = topics.get(sportsUpaMainTopic(eventId(match))) || [];
      const sources = [];
      for (const [index, row] of rows.slice(0, 2).entries()) {
        const wrapper = sportsUpaMainWrapperUrl(row.url);
        if (!wrapper) continue;
        try {
          const embedUrl = decodeSportsUpaMainWrapper(await publicText(fetchImpl, wrapper));
          if (!embedUrl || sources.some((s) => s.embedUrl === embedUrl)) continue;
          sources.push({ name: `SportsUpa • Main HD ${index + 1}`, url: "", embedUrl, provider: "SportsUpa", embedProvider: "SportsUpa", hd: true,
            headers: { Referer: "https://sportsupa.st/" } });
        } catch {}
      }
      if (!sources.length) continue;
      const teams = teamNames(match), id = eventId(match);
      games.push({ id: `sportsupa-${id}`, provider: "SportsUpa", sourceId: id,
        title: String(match.title ?? match.name ?? "Sports event"), league: String(match.league ?? match.category ?? "Sports"),
        sport: String(match.sport ?? match.category ?? "Sports"), startsAt: asIsoDate(match), status: "upcoming",
        homeTeam: teams.home, awayTeam: teams.away, sources });
    }
  }));
  return games.sort((a, b) => a.id.localeCompare(b.id));
}

/** Unverified SportsUpa rows are never part of the normal feed. */
export function sportsUpaDiagnosticPlaybackEnabled(value = process.env.SPORTSUPA_ENABLE_UNVERIFIED_PLAYBACK) {
  return value === "true";
}

export function gateSportsUpaDiagnosticGames(games, enabled = sportsUpaDiagnosticPlaybackEnabled()) {
  return enabled ? games : [];
}

function rowsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.matches)) return payload.matches;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function apiRowsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.streams)) return payload.streams;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function eventId(row) {
  return String(row?.id ?? row?.eventId ?? row?.event_id ?? "").trim();
}

function sourceCategory(row) {
  return String(row?.source ?? row?.src ?? row?.provider ?? "").trim().toLowerCase();
}

function asIsoDate(row) {
  const raw = row?.timestamp ?? row?.date ?? row?.startTime ?? row?.startsAt ?? row?.starts_at;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const millis = raw < 10_000_000_000 ? raw * 1000 : raw;
    return new Date(millis).toISOString();
  }
  if (typeof raw !== "string" || !raw.trim()) return "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function teamNames(row) {
  const nested = (value) => typeof value === "string" ? value : value?.name ?? value?.title ?? "";
  let home = String(nested(row?.homeTeam ?? row?.home_team ?? row?.home ?? row?.teams?.home)).trim();
  let away = String(nested(row?.awayTeam ?? row?.away_team ?? row?.away ?? row?.teams?.away)).trim();
  if ((!home || !away) && typeof (row?.title ?? row?.name ?? row?.event_name) === "string") {
    const sides = String(row.title ?? row.name ?? row.event_name).split(/\s+(?:vs\.?|v\.?|at|@)\s+/i);
    if (sides.length === 2) {
      home ||= sides[0].trim();
      away ||= sides[1].trim();
    }
  }
  return { home, away };
}

function kickoffPriority(row, nowMillis) {
  const startsAt = Date.parse(asIsoDate(row));
  if (!Number.isFinite(startsAt)) return [4, Number.MAX_SAFE_INTEGER];
  const delta = startsAt - nowMillis;
  if (delta <= 0 && delta >= -12 * 60 * 60 * 1000) return [0, Math.abs(delta)];
  if (delta > 0 && delta <= 7 * 24 * 60 * 60 * 1000) return [1, delta];
  if (delta < 0) return [2, Math.abs(delta)];
  return [3, delta];
}

function safeEmbedUrl(value) {
  if (typeof value !== "string") return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== EMBED_HOST ||
      url.username || url.password || url.port || url.search || url.hash) return "";
  if (!/^\/embed\/admin\/[A-Za-z0-9._~-]+\/\d{1,3}$/.test(url.pathname)) return "";
  return url.href;
}

/** Only affirmative HD rows from the public Admin stream catalog are eligible. */
export function sportsUpaAdminSources(rows, category = "admin") {
  if (String(category).trim().toLowerCase() !== "admin" || !Array.isArray(rows)) return [];
  const seen = new Set();
  return rows.flatMap((row, index) => {
    if (row?.hd !== true) return [];
    const embedUrl = safeEmbedUrl(row.embedUrl ?? row.embed_url ?? row.url);
    if (!embedUrl || seen.has(embedUrl)) return [];
    seen.add(embedUrl);
    return [{
      name: String(row.source_name ?? row.name ?? `Admin HD ${index + 1}`).trim() || `Admin HD ${index + 1}`,
      url: "",
      embedUrl,
      provider: "SportsUpa",
      embedProvider: "SportsUpa",
      hd: true,
      headers: { Referer: "https://sportsupa.st/" },
    }];
  });
}

async function getJson(fetchImpl, url) {
  return JSON.parse(await publicText(fetchImpl, url));
}

/** Reads only public Admin routes; no credential, admin-write, or private config routes. */
export async function collectSportsUpaAdminGames({ fetchImpl = fetch, now = new Date() } = {}) {
  const matches = rowsFrom(await getJson(fetchImpl, `${API_BASE}/matches/all`));
  const candidates = matches.flatMap((match) => {
    const sources = Array.isArray(match?.sources) ? match.sources : [];
    const admin = sources.filter((source) => sourceCategory(source) === "admin");
    const startsAt = asIsoDate(match);
    const { home, away } = teamNames(match);
    return admin.slice(0, 1).map((source) => ({ match, source, startsAt, home, away }));
  }).filter(({ startsAt, home, away }) => startsAt && home && away)
    .sort((first, second) => {
      const [firstRank, firstDistance] = kickoffPriority(first.match, now.getTime());
      const [secondRank, secondDistance] = kickoffPriority(second.match, now.getTime());
      return firstRank - secondRank || firstDistance - secondDistance || eventId(first.match).localeCompare(eventId(second.match));
    }).slice(0, MAX_EVENTS);

  let next = 0;
  const results = new Array(candidates.length);
  await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= candidates.length) return;
      const { match, source, startsAt, home, away } = candidates[index];
      const id = String(source.id ?? source.eventId ?? source.event_id ?? eventId(match)).trim();
      if (!id || id.length > 180) continue;
      try {
        const streamPayload = await getJson(fetchImpl, `${API_BASE}/stream/admin/${encodeURIComponent(id)}`);
        const streams = apiRowsFrom(streamPayload);
        const playable = sportsUpaAdminSources(streams, "admin");
        if (!playable.length || !startsAt) continue;
        const label = String(match.title ?? match.name ?? match.event_name ?? "Sports event").trim();
        const gameId = eventId(match) || id;
        results[index] = {
          id: `sportsupa-${gameId}`,
          provider: "SportsUpa",
          sourceId: gameId,
          title: label,
          league: String(match.league ?? match.category ?? "Sports").trim() || "Sports",
          sport: String(match.sport ?? match.category ?? "Sports").trim() || "Sports",
          startsAt,
          // ESPN is the sole authority for live/pre/post state in the app. Never infer live from
          // a past kickoff or from the presence of a stream in this third-party catalog.
          status: "upcoming",
          homeTeam: home,
          awayTeam: away,
          sources: playable,
        };
      } catch {
        // A failed public event route contributes no source and cannot create a false-live card.
      }
    }
  }));

  const byId = new Map();
  for (const game of results.filter(Boolean)) {
    const existing = byId.get(game.id);
    if (!existing) byId.set(game.id, game);
    else existing.sources = [...existing.sources, ...game.sources]
      .filter((source, index, all) => all.findIndex((candidate) => candidate.embedUrl === source.embedUrl) === index);
  }
  return [...byId.values()];
}
