import test from "node:test";
import assert from "node:assert/strict";

import {
  filterKnownStandardDefinitionSources,
  isKnownStandardDefinition,
  maxHeightFromManifest,
  normalizeStreamedHd,
} from "./stream-quality.mjs";

test("Streamed HD metadata stays tri-state", () => {
  assert.equal(normalizeStreamedHd(true), true);
  assert.equal(normalizeStreamedHd(false), false);
  assert.equal(normalizeStreamedHd(undefined), null);
  assert.equal(normalizeStreamedHd("true"), null);
});

test("known SD metadata is filtered and unknown or HD quality is retained", () => {
  const heights = [480, 720, 1080, 2160, 0, undefined];
  const sources = heights.map((maxHeight, index) => ({
    provider: "DLStreams",
    url: `https://media.example/${index}.m3u8`,
    ...(maxHeight === undefined ? {} : { maxHeight }),
  }));
  sources.push({ provider: "Streamed", hd: false, embedUrl: "https://embed.st/embed/hotel/sd/1" });
  sources.push({ provider: "Streamed", hd: null, name: "Streamed • English 2", embedUrl: "https://embed.st/embed/hotel/unknown/2" });

  assert.equal(isKnownStandardDefinition(sources[0]), true);
  assert.equal(isKnownStandardDefinition(sources[1]), false);
  assert.equal(isKnownStandardDefinition(sources[4]), false);
  assert.equal(isKnownStandardDefinition(sources[5]), false);
  assert.equal(isKnownStandardDefinition({ hd: true, maxHeight: 480 }), true);

  const games = [{ id: "event", sources }];
  const result = filterKnownStandardDefinitionSources(games);
  assert.equal(result.excludedSourceCount, 2);
  assert.deepEqual(result.excludedSourcesByProvider, { DLStreams: 1, Streamed: 1 });
  assert.equal(result.excludedSourceKeys.length, 2);
  assert.deepEqual(games[0].sources.map((source) => source.maxHeight), [720, 1080, 2160, 0, undefined, undefined]);
});

test("manifest height is derived from HLS and DASH quality metadata with unknown defaulting to zero", () => {
  for (const height of [480, 720, 1080, 2160]) {
    assert.equal(maxHeightFromManifest(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=3840x${height}`), height);
    assert.equal(maxHeightFromManifest(`<MPD><Representation height=\"${height}\" /></MPD>`), height);
  }
  assert.equal(maxHeightFromManifest("#EXTM3U\n#EXT-X-TARGETDURATION:6"), 0);
  assert.equal(maxHeightFromManifest(null), 0);
});
