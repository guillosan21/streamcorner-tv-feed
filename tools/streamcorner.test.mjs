import test from "node:test";
import assert from "node:assert/strict";
import { decoderFor, isolatedDecoderFor, discoverStreamCornerRuntime, loadStreamCornerRuntime, streamCornerGameFromDetail } from "./streamcorner.mjs";

test("uses the integrity-checked local decoder when the site challenges a publisher runner", async () => {
  const runtime = await loadStreamCornerRuntime(async () => new Response("challenge", { status: 403 }));
  assert.match(runtime.fallbackWarning, /HTTP 403/);
  assert.ok(runtime.decoderCode.length > 1000);
  assert.ok(runtime.workers.length > 0);
  assert.ok(runtime.decoderUrl.startsWith("https://streamcorner.st/assets/"));
});

test("discovers the rotating decoder and workers from the current domain only", async () => {
  const pages = new Map([
    ["https://streamcorner.st/", '<script type="module" src="/assets/entry.js"></script>'],
    ["https://streamcorner.st/assets/entry.js", 'import{j as x}from"./runtime.js";'],
    ["https://streamcorner.st/assets/runtime.js",
      'import{j as Mr}from"./decoder.js";const Zo=["data.good.workers.dev","evil.example"];const Na="corner";'],
    ["https://streamcorner.st/assets/decoder.js", 'function decode(){};export{decode as j};'],
  ]);
  const fetcher = async (url) => new Response(pages.get(url) || "", { status: pages.has(url) ? 200 : 404 });
  const runtime = await discoverStreamCornerRuntime(fetcher);
  assert.deepEqual(runtime.workers, ["data.good.workers.dev"]);
  assert.equal(runtime.decoderExport, "decode");
  assert.equal(runtime.decoderUrl, "https://streamcorner.st/assets/decoder.js");
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
  assert.equal(game.sources[0].headers.Referer, "https://streamcorner.st/");
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


test("decoder invocation bounds a nonterminating synchronous provider decoder", () => {
  const decoder = decoderFor({
    workers: ["data.good.workers.dev"],
    decoderCode: "function decode(){while(true){}};export{decode as j};",
    decoderExport: "decode",
  }, async () => { throw new Error("unexpected fetch"); });
  const start = performance.now();
  assert.throws(() => decoder("https://data.good.workers.dev/corner", "alpha", "ALPHA"), /Script execution timed out/);
  assert.ok(performance.now() - start < 5000);
});

test("decoder worker transport rejects wrong origin path and method", async () => {
  let fetchCount = 0;
  const decoder = decoderFor({
    workers: ["data.good.workers.dev"],
    decoderCode: "async function decode(url,method){return fetch(url,{method})};export{decode as j};",
    decoderExport: "decode",
  }, async () => { fetchCount++; return new Response("{}"); });
  for (const [url, method] of [
    ["https://evil.example/corner", "POST"], ["https://data.good.workers.dev/other", "POST"],
    ["http://data.good.workers.dev/corner", "POST"], ["https://data.good.workers.dev/corner", "GET"],
  ]) await assert.rejects(decoder(url, method), /verified StreamCorner worker route/);
  assert.equal(fetchCount, 0);
  await decoder("https://data.good.workers.dev/corner", "POST");
  assert.equal(fetchCount, 1);
});

test("decoder recognizes host fetch and WebCrypto ArrayBuffers across VM boundary", async () => {
  const decoder = decoderFor({
    workers: ["data.good.workers.dev"],
    decoderCode: "async function decode(url){const body=await(await fetch(url,{method:'POST'})).arrayBuffer();if(!(body instanceof ArrayBuffer))throw Error('realm');const hash=await crypto.subtle.digest('SHA-256',body);if(!(hash instanceof ArrayBuffer))throw Error('crypto realm');return [new Uint8Array(body).length,hash.byteLength]};export{decode as j};",
    decoderExport: "decode",
  }, async () => new Response(new Uint8Array([1,2,3])));
  assert.deepEqual(Array.from(await decoder("https://data.good.workers.dev/corner")), [3,32]);
});

test("parent deadline terminates an infinite loop after an async boundary", async () => {
  const decode = isolatedDecoderFor({workers:[],decoderExport:'decode',
    decoderCode:'async function decode(){await Promise.resolve();while(true){}};export{decode as j};'}, 200);
  const start=performance.now();
  await assert.rejects(decode(), /timed out/);
  assert.ok(performance.now()-start<3000);
});

test("isolated decoder returns async data without raw provider errors", async () => {
  const decode=isolatedDecoderFor({workers:[],decoderExport:'decode',
    decoderCode:'async function decode(){await Promise.resolve();return [{id:1}]};export{decode as j};'});
  assert.deepEqual(await decode(),[{id:1}]);
  const fail=isolatedDecoderFor({workers:[],decoderExport:'decode',
    decoderCode:'async function decode(){throw Error("token=secret")};export{decode as j};'});
  await assert.rejects(fail(), {message:'provider decoder failed'});
});
