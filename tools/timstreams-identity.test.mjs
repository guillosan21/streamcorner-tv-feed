import test from "node:test";
import assert from "node:assert/strict";
import { __testing } from "./timstreams.mjs";
import { isValidTimStreamsSourceRef, isOpaqueTimStreamsSource, playbackIdentity, deduplicatePlaybackSources } from "./playback-identity.mjs";
const source = () => __testing.buildResolvedSource({ name: "DAZN Canada" }, { url: "czechia-v-spain-unl-401861118" }, "https://exmxbxe.cfd/he5phqny-6982?private=transient");
test("Tim v2 sources survive deduplication without publishing transport state", () => {
  const row = source();
  assert.ok(isValidTimStreamsSourceRef(row.providerSourceRef));
  assert.ok(isOpaqueTimStreamsSource(row));
  assert.ok(playbackIdentity(row).startsWith("resolver:timstreams:v2~"));
  assert.equal(deduplicatePlaybackSources([row, { ...row }]).length, 1);
  assert.equal(row.url, "");
  assert.equal(row.embedUrl, "");
  assert.ok(!JSON.stringify(row).includes("private"));
});
test("Tim v2 publication rejects malformed identities and transport credentials", () => {
  const row = source();
  const ref = (event, host, path) => "timstreams:v2~" + [event, host, path].map(value => Buffer.from(value).toString("base64url")).join("~");
  for (const rejected of [
    { ...row, providerSourceRef: " " + row.providerSourceRef },
    { ...row, providerSourceRef: row.providerSourceRef + "=" },
    { ...row, providerSourceRef: ref("event", "exmxbxe.cfd.evil.test", "/player") },
    { ...row, providerSourceRef: ref("../event", "exmxbxe.cfd", "/player") },
    { ...row, providerSourceRef: ref("event", "exmxbxe.cfd", "/../player") },
    { ...row, providerSourceRef: ref("event", "exmxbxe.cfd", "/player?token=secret") },
    { ...row, providerGeneration: "v1" }, { ...row, embedProvider: "Other" },
    { ...row, url: "https://media.example/live.m3u8?secret=one" },
    { ...row, embedUrl: "https://exmxbxe.cfd/player" },
    { ...row, headers: { Cookie: "secret" } }, { ...row, clearKey: "private" },
  ]) {
    assert.equal(isOpaqueTimStreamsSource(rejected), false);
    assert.equal(playbackIdentity(rejected), "");
  }
  assert.ok(isValidTimStreamsSourceRef(ref("event", "epiembeds.online", "/player")));
});
