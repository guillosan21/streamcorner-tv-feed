import test from "node:test";
import assert from "node:assert/strict";

import {
  encodeZLiveStreamsRequest,
  fetchZLiveGames,
  parseZLiveEvents,
  zliveSourceRef,
  ZLIVE_STREAMS_ENDPOINT,
} from "./zlive.mjs";

const now = new Date("2026-09-24T12:00:00.000Z");

test("ZLive request follows the public daily AES-GCM envelope", () => {
  const request = encodeZLiveStreamsRequest(now, Buffer.from([...Array(12).keys()]));

  assert.deepEqual(request, {
    q: "PrRrDQUiMg17vU+nTsXhXUw=",
    s: "AAECAwQFBgcICQoL",
    t: "lWQVKYzcLSs2AVmsOndGGw==",
    d: "2026-09-24",
  });
  assert.deepEqual(Object.keys(request), ["q", "s", "t", "d"]);
  assert.equal(request.d, "2026-09-24");
  assert.equal(Buffer.from(request.s, "base64").length, 12);
  assert.equal(Buffer.from(request.t, "base64").length, 16);
  assert.equal(Buffer.from(request.q, "base64").length, Buffer.byteLength(JSON.stringify({ ts: now.getTime() / 1000 })));
  assert.throws(() => encodeZLiveStreamsRequest(new Date("invalid")), /valid ZLive request time/);
  assert.throws(() => encodeZLiveStreamsRequest(now, Buffer.alloc(11)), /12-byte IV/);
});

test("ZLive accepts only stable opaque event IDs", () => {
  assert.equal(zliveSourceRef("event-42"), "zlive:event-42");
  for (const id of [
    "https://zlive.st/watch/event-42", "//zlive.st/event", "/watch/event-42",
    "event-42?source=1", "event:42", "../event", " event-42 ", "", " ", "a".repeat(121),
  ]) {
    assert.equal(zliveSourceRef(id), "", id);
  }
});

test("event parser preserves catalog fields and discards all stream URLs", () => {
  const games = parseZLiveEvents([
    {
      id: "event-42",
      name: "Boston Red Sox at New York Yankees",
      type: "MLB",
      startTime: "2026-09-24T11:00:00Z",
      thumbnail: "https://images.example/event-42.jpg",
      live: true,
      source: { key: "main-42", label: "English 1080p" },
      sources: [
        { name: "Main", url: "https://media.example/live.m3u8?token=private" },
        { name: "Backup", embedUrl: "https://player.example/embed/42" },
      ],
    },
    {
      id: "event-43",
      name: "New York Liberty vs Indiana Fever",
      type: "WNBA",
      startTime: 1790272800,
      thumbnail: "http://images.example/not-https.jpg",
      live: false,
      source: { key: "source-43", label: "International" },
      sources: [{ url: "https://media.example/other.m3u8" }],
    },
  ], now);

  assert.equal(games.length, 2);
  assert.equal(games[0].id, "zlive:event-42");
  assert.equal(games[0].provider, "zlive");
  assert.equal(games[0].status, "live");
  assert.equal(games[0].league, "MLB");
  assert.equal(games[0].sport, "Baseball");
  assert.equal(games[0].posterUrl, "https://images.example/event-42.jpg");
  assert.deepEqual(games[0].sources, [{
    provider: "ZLive",
    name: "ZLive • English 1080p",
    url: "",
    embedUrl: "",
    providerSourceRef: "zlive:event-42",
    providerGeneration: "v1",
    headers: {},
    clearKey: "",
  }]);
  assert.equal(games[1].status, "upcoming");
  assert.equal(games[1].posterUrl, "");
  assert.equal(JSON.stringify(games).includes("media.example"), false);
  assert.equal(JSON.stringify(games).includes("player.example"), false);
  assert.equal(JSON.stringify(games).includes("token=private"), false);
  assert.equal(JSON.stringify(games).includes("main-42"), false);
});

test("malformed, ambiguous, URL-shaped, duplicate, and stale rows yield no unsafe cards", () => {
  const rows = [
    null,
    { id: "https://zlive.st/event", name: "Boston Red Sox vs New York Yankees", type: "MLB", startTime: now.toISOString(), live: true, source: { key: "event" } },
    { id: "no-start", name: "Boston Red Sox vs New York Yankees", type: "MLB", live: true, source: { key: "event" } },
    { id: "ambiguous", name: "New York vs Boston", type: "Football", startTime: now.toISOString(), live: true, source: { key: "event" } },
    { id: "old", name: "Boston Red Sox vs New York Yankees", type: "MLB", startTime: "2026-09-23T12:00:00Z", live: false, source: { key: "event" } },
    { id: "duplicate", name: "Boston Red Sox vs New York Yankees", type: "MLB", startTime: now.toISOString(), live: false, source: { key: "event" } },
    { id: "duplicate", name: "Boston Red Sox vs New York Yankees", type: "MLB", startTime: now.toISOString(), live: true, source: { key: "event" } },
    { id: "missing-source", name: "Boston Red Sox vs New York Yankees", type: "MLB", startTime: now.toISOString(), live: true },
  ];
  const games = parseZLiveEvents(rows, now);

  assert.equal(games.length, 1);
  assert.equal(games[0].id, "zlive:duplicate");
  assert.equal(games[0].status, "live");
  assert.deepEqual(parseZLiveEvents({ malformed: true }, now), []);
  assert.deepEqual(parseZLiveEvents("not an event array", now), []);
  assert.deepEqual(parseZLiveEvents([], new Date("invalid")), []);
});

test("fetch uses one bounded encrypted POST and accepts an empty catalog", async () => {
  let requested;
  const result = await fetchZLiveGames(now, {
    ivBytes: Buffer.alloc(12),
    timeoutMs: 5000,
    fetcher: async (url, init) => {
      requested = { url, init };
      return {
        ok: true,
        headers: { get: () => null },
        text: async () => "[]",
      };
    },
  });

  assert.equal(requested.url, ZLIVE_STREAMS_ENDPOINT);
  assert.equal(requested.init.method, "POST");
  assert.equal(requested.init.redirect, "error");
  assert.equal(requested.init.headers.Origin, "https://zlive.st");
  assert.equal(requested.init.headers.Referer, "https://zlive.st/streams");
  const envelope = JSON.parse(requested.init.body);
  assert.deepEqual(Object.keys(envelope), ["q", "s", "t", "d"]);
  assert.equal(envelope.d, "2026-09-24");
  assert.ok(requested.init.signal);
  assert.deepEqual(result, { games: [], catalogCount: 0, error: "" });
});

test("malformed response and transport failure safely return zero events without leaking details", async () => {
  const malformed = await fetchZLiveGames(now, {
    fetcher: async () => ({ ok: true, headers: { get: () => null }, text: async () => "{broken" }),
  });
  const failed = await fetchZLiveGames(now, {
    fetcher: async () => { throw new Error("token=private https://media.example/live.m3u8"); },
  });

  assert.deepEqual(malformed, { games: [], catalogCount: 0, error: "invalid JSON response" });
  assert.equal(failed.games.length, 0);
  assert.equal(failed.catalogCount, 0);
  assert.equal(failed.error, "request failed");
  assert.equal(JSON.stringify(failed).includes("private"), false);
  assert.equal(JSON.stringify(failed).includes("media.example"), false);
});
