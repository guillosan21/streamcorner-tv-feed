import test from "node:test";
import assert from "node:assert/strict";
import { __testing } from "./timstreams.mjs";
import { inspectStreamCapabilities, sourceProvenanceErrors } from "./scrape-streams.mjs";
import { deduplicatePlaybackSources } from "./playback-identity.mjs";
test("fresh Tim opaque collector rows survive capability, provenance and deduplication stages", async () => {
  const source = __testing.buildResolvedSource({ name: "DAZN Canada" }, { url: "czechia-v-spain-unl-401861118" }, "https://exmxbxe.cfd/he5phqny-6982");
  assert.equal(await inspectStreamCapabilities(source, "timstreams"), source);
  assert.deepEqual(sourceProvenanceErrors([{ id: "tim-event", sources: [source] }]), []);
  assert.equal(deduplicatePlaybackSources([source]).length, 1);
  const unsafe = { ...source, headers: { Authorization: "secret" } };
  assert.equal(await inspectStreamCapabilities(unsafe, "timstreams"), null);
  assert.equal(sourceProvenanceErrors([{ id: "tim-event", sources: [unsafe] }]).length, 1);
});
