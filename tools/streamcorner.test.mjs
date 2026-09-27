import test from "node:test";
import assert from "node:assert/strict";
import { discoverStreamCornerRuntime, loadStreamCornerRuntime, streamCornerGameFromDetail } from "./streamcorner.mjs";

test("uses the integrity-checked local decoder when the site challenges a publisher runner", async () => {
  const runtime = await loadStreamCornerRuntime(async () => new Response("challenge", { status: 403 }));
  assert.match(runtime.fallbackWarning, /HTTP 403/);
  assert.ok(runtime.decoderCode.length > 1000);
  assert.ok(runtime.workers.length > 0);
  assert.ok(runtime.decoderUrl.startsWith("https://cornerstream.tech/assets/"));
});

test("discovers the rotating decoder and workers from the current domain only", async () => {
  const pages = new Map([
    ["https://cornerstream.tech/", '<script type="module" src="/assets/entry.js"></script>'],
    ["https://cornerstream.tech/assets/entry.js", 'import{j as x}from"./runtime.js";'],
    ["https://cornerstream.tech/assets/runtime.js",
      'import{j as Mr}from"./decoder.js";const Zo=["data.good.workers.dev","evil.example"];const Na="corner";'],
    ["https://cornerstream.tech/assets/decoder.js", 'function decode(){};export{decode as j};'],
  ]);
  const fetcher = async (url) => new Response(pages.get(url) || "", { status: pages.has(url) ? 200 : 404 });
  const runtime = await discoverStreamCornerRuntime(fetcher);
  assert.deepEqual(runtime.workers, ["data.good.workers.dev"]);
  assert.equal(runtime.decoderExport, "decode");
  assert.equal(runtime.decoderUrl, "https://cornerstream.tech/assets/decoder.js");
});

test("publishes only direct HLS/DASH from the new catalog and preserves ClearKey", () => {
  const now = new Date("2026-09-27T18:00:00Z");
  const job = { provider: "alpha", id: "event-1", row: { timestamp: 1790528400 } };
  const game = streamCornerGameFromDetail(job, {
    event_name: "England vs Sri Lanka", category: "CRICKET", league: "Cricket", timestamp: 1790528400,
    streams: [
      { source_name: "WILLOW", stream_url: "https://cdn.example/live.mpd?token=abc", stream_keys: `${"a".repeat(32)}:${"b".repeat(32)}` },
      { source_name: "Web wrapper", embed_url: "https://rockystream.st/source/fetch.php" },
      { source_name: "Wrong format", stream_url: "https://cdn.example/landing.html" },
      { source_name: "Bad key", stream_url: "https://cdn.example/bad.mpd", stream_keys: "bad" },
    ],
  }, now, () => 8 * 60 * 60);
  assert.equal(game.sources.length, 1);
  assert.equal(game.sources[0].provider, "StreamCorner");
  assert.equal(game.sources[0].headers.Referer, "https://cornerstream.tech/");
  assert.equal(game.sources[0].clearKey, `${"a".repeat(32)}:${"b".repeat(32)}`);
  assert.equal(game.sources[0].url, "https://cdn.example/live.mpd?token=abc");
});

test("a catalog row with only web players is not advertised as playable direct media", () => {
  const now = new Date("2026-09-27T18:00:00Z");
  const game = streamCornerGameFromDetail({ provider: "003", id: "id", row: { timestamp: 1790500000 } }, {
    event_name: "Game", streams: [{ embed_url: "https://rockystream.st/source/fetch.php" }],
  }, now, () => 8 * 60 * 60);
  assert.equal(game, null);
});
