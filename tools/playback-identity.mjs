// Pizarra MX sources intentionally publish opaque refs instead of transport
// URLs. Keep the resolver identity stable across harmless display changes.
export const PIZARRAMX_SOURCE_REF_PATTERN = /^pizarramx:v1~[em]~[0-9a-f]{64}~[0-9a-f]{64}$/;

export function isValidPizarraMxSourceRef(value) {
  return PIZARRAMX_SOURCE_REF_PATTERN.test(String(value || ""));
}
const TIMSTREAMS_PLAYER_HOSTS = new Set(["exmxbxe.cfd", "epiembeds.online"]);
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
  if (source?.provider === "TimStreams" && source?.providerSourceRef) {
    return isOpaqueTimStreamsSource(source) ? `resolver:${source.providerSourceRef}:generation:v2` : "";
  }
  const provider = String(source?.provider || "").trim();
  const rawRef = String(source?.providerSourceRef || "");
  if (provider === "Pizarra MX") {
    if (rawRef !== rawRef.trim() || !isValidPizarraMxSourceRef(rawRef)) return "";
    const generation = String(source?.providerGeneration || "v1").trim() || "v1";
    return `resolver:${rawRef}:generation:${generation}`;
  }
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
