export function isRetiredPizarraSource(source) {
  if ([source?.provider, source?.embedProvider, source?.name].some((value) =>
    String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "").startsWith("pizarra"))) return true;
  if (String(source?.providerSourceRef || "").trim().toLowerCase().startsWith("pizarramx:")) return true;
  return [source?.url, source?.embedUrl, source?.headers?.Referer, source?.headers?.Origin].some((value) => {
    try { return new URL(String(value || "")).hostname.toLowerCase().includes("pizarra"); } catch { return false; }
  });
}

const TIMSTREAMS_PLAYER_HOSTS = new Set(["exmxbxe.cfd", "epiembeds.online", "ehgembxe.cfd"]);
const STREAMCORNER_INGEST_PATH = /^\/embed\/ingest\/(?:[A-Za-z0-9_-]{1,64}\/){0,3}[A-Za-z0-9_-]{1,128}\/?$/;
const STREAMCORNER_001_PATH = /^\/embed\/(?:nhl|nfl|mlb|nba|soccer|ucl|efl-league-two|efl-championship)\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/[a-z0-9]+(?:-[a-z0-9]+){1,8}$/;

export function streamCornerIngestPath(value) {
  if (typeof value !== "string" || value.length > 2064) return null;
  const match = /^streamcorner:(v[123])~([A-Za-z0-9_-]+)$/.exec(value);
  if (!match || match[0] !== value) return null;
  if (match[2].length > (match[1] === "v3" ? 2048 : 512)) return null;
  const bytes = Buffer.from(match[2], "base64url");
  const path = bytes.toString("utf8");
  return bytes.toString("base64url") === match[2] && Buffer.from(path, "utf8").equals(bytes) &&
    (match[1] === "v3" ? path.length <= 1100 && /^https:\/\/amazon\.com\.pandecocogaming\.sbs\/\?p=[A-Za-z0-9_-]{32,1024}={0,2}$/.test(path) :
      (match[1] === "v2" ? STREAMCORNER_001_PATH : STREAMCORNER_INGEST_PATH).test(path)) && path === path.trim() ? path : null;
}

export function isNativeStreamCornerSource(source) {
  const path = streamCornerIngestPath(source?.providerSourceRef);
  const v2 = String(source?.providerSourceRef || "").startsWith("streamcorner:v2~");
  const v3 = String(source?.providerSourceRef || "").startsWith("streamcorner:v3~");
  return Boolean(path && source.provider === "StreamCorner" && source.embedProvider === "StreamCorner" &&
    String(source.name || "").startsWith("StreamCorner • ") && source.url === "" && !source.clearKey &&
    source.providerGeneration === (v3 ? "v3" : v2 ? "v2" : "v1") && source.availabilityEvidence === "provider-reported" &&
    source.embedUrl === (v3 ? path : v2 ? `https://taifood-blog.asia${path}` : `https://embed.st${path}#player=clappr&autoplay=true`) &&
    source.headers?.Referer === "https://streamcorner.st/" && Object.keys(source.headers).length === 1);
}

export function isStreamCornerNativeCandidate(source) {
  return (source?.provider === "StreamCorner" && Boolean(source?.providerSourceRef || source?.embedUrl)) ||
    /^streamcorner:/i.test(String(source?.providerSourceRef || "").trim());
}
export function isValidTimStreamsSourceRef(value) {
  const ref = String(value || "");
  if (!ref.startsWith("timstreams:") || ref.length > 191) return false;
  const parts = ref.slice("timstreams:".length).match(/^v2~([A-Za-z0-9_-]+)~([A-Za-z0-9_-]+)~([A-Za-z0-9_-]+)$/);
  if (!parts) return false;
  const decoded = parts.slice(1).map((part) => {
    const bytes = Buffer.from(part, "base64url");
    const text = bytes.toString("utf8");
    return bytes.toString("base64url") === part && Buffer.from(text, "utf8").equals(bytes) ? text : null;
  });
  const [event, host, path] = decoded;
  return Boolean(event && host && path &&
    /^[A-Za-z0-9][A-Za-z0-9._~-]{0,180}$/.test(event) && !event.includes("..") &&
    TIMSTREAMS_PLAYER_HOSTS.has(host) &&
    /^\/[A-Za-z0-9][A-Za-z0-9._~-]{0,180}$/.test(path) && !path.includes(".."));
}

export function isOpaqueTimStreamsSource(source) {
  return source?.provider === "TimStreams" && source?.embedProvider === "TimStreams" &&
    source?.providerGeneration === "v2" && isValidTimStreamsSourceRef(source?.providerSourceRef) &&
    !source.url && !source.embedUrl && !source.clearKey && !Object.keys(source.headers || {}).length;
}

export function feedSourceKey(source) {
  if (isRetiredPizarraSource(source)) return "";
  if (isStreamCornerNativeCandidate(source) && !isNativeStreamCornerSource(source)) return "";
  const providerSourceRef = String(source?.providerSourceRef || "");
  if (source?.provider === "TimStreams" && (source?.providerGeneration === "v2" || providerSourceRef.trim().startsWith("timstreams:v2~")) && !isOpaqueTimStreamsSource(source)) return "";
  if (providerSourceRef) {
    const generation = String(source?.providerGeneration || "v1").trim() || "v1";
    return `resolver:${providerSourceRef}:generation:${generation}`;
  }
  const url = String(source?.url || "");
  if (url) return `direct:${url}:${String(source?.clearKey || "")}`;
  const embedUrl = String(source?.embedUrl || "");
  return embedUrl ? `web:${embedUrl}` : "";
}

export function playbackIdentity(source) {
  if (isStreamCornerNativeCandidate(source)) {
    return isNativeStreamCornerSource(source) ? `resolver:${source.providerSourceRef}:generation:${source.providerGeneration}` : "";
  }
  if (source?.provider === "TimStreams" && source?.providerSourceRef) {
    return isOpaqueTimStreamsSource(source) ? `resolver:${source.providerSourceRef}:generation:v2` : "";
  }
  if (isRetiredPizarraSource(source)) return "";
  const endpoint = String(source?.url || source?.embedUrl || "").trim();
  return endpoint ? `endpoint:${endpoint}` : "";
}

export function deduplicatePlaybackSources(sources) {
  const seen = new Set();
  return (Array.isArray(sources) ? sources : []).filter((source) => {
    const identity = playbackIdentity(source);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
