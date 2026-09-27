// Pizarra MX sources intentionally publish opaque refs instead of transport
// URLs. Keep the resolver identity stable across harmless display changes.
export const PIZARRAMX_SOURCE_REF_PATTERN = /^pizarramx:v1~[em]~[0-9a-f]{64}~[0-9a-f]{64}$/;

export function isValidPizarraMxSourceRef(value) {
  return PIZARRAMX_SOURCE_REF_PATTERN.test(String(value || ""));
}

export function feedSourceKey(source) {
  const providerSourceRef = String(source?.providerSourceRef || "");
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
