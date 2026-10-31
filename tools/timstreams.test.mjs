import test from "node:test";
import assert from "node:assert/strict";

import { __testing } from "./timstreams.mjs";
test("browser-only catalog sources are reported references, not verified transports", async () => {
  const stream = { name: "ESPN", url: "https://ehgembxe.cfd/player?private=transient" };
  const event = { url: "utah-utes-v-colorado-buffaloes-401856833" };
  const options = { requirePublicUrl: async () => {}, fetchImpl: async () => { throw new Error("New host must resolve on device"); } };
  const source = await __testing.resolveStream(stream, event, true, options);
  assert.equal(source.availabilityEvidence, "provider-reported");
  assert.equal(source.url, ""); assert.equal(source.embedUrl, ""); assert.deepEqual(source.headers, {});
  assert.ok(source.providerSourceRef.startsWith("timstreams:v2~"));
  assert.ok(!JSON.stringify(source).includes("private"));
  for (const [s, e] of [[{ ...stream, vip: true }, event], [stream, { ...event, vip: true }],
    [{ ...stream, url: "https://ehgembxe.cfd/play/header..iv.ciphertext.tag" }, event],
    [stream, { url: "a".repeat(180) }],
  ]) assert.equal(await __testing.resolveStream(s, e, true, options), null);
  let requests = 0;
  assert.equal(await __testing.resolveStream({ ...stream, url: "https://exmxbxe.cfd/player" }, event, true, {
    requirePublicUrl: async () => {}, fetchImpl: async url => { requests++; return { status: 502, ok: false, url }; },
  }), null);
  assert.equal(requests, 1);
});
test("actual player fetch keeps raw opaque Location guards and exact one-hop proof", async () => {
  const first = "https://ehgembxe.cfd/player?session=fixture";
  const target = "https://ehgembxe.cfd/play/header..iv.ciphertext.tag";
  for (const location of [target, target.replace("https://ehgembxe.cfd", ""),
    target.replace(".cfd/", ".cfd:443/"), target.replace("/play/", "/play/../play/"),
    target + "?unexpected=fixture", target.replace(".cfd/", ".cfd.evil.example/"),
  ]) {
    const calls = [];
    const result = await __testing.fetchTimPlayerPage(first, {}, "selected-event", {
      requirePublicUrl: async () => {},
      fetchImpl: async (url, options) => {
        calls.push(url);
        assert.equal(options.redirect, "manual");
        return calls.length === 1
          ? { status: 302, url, headers: new Headers({ Location: location }), body: { cancel: async () => {} } }
          : { status: 200, url, headers: new Headers() };
      },
    });
    const accepted = location === target || location.startsWith("/play/header");
    assert.equal(Boolean(result), accepted);
    assert.deepEqual(calls, accepted ? [first, target] : [first]);
  }
});
test("rotated player host keeps opaque redirect proof request-local", () => {
  const first = "https://ehgembxe.cfd/player?session=fixture";
  const target = "https://ehgembxe.cfd/play/header..iv.ciphertext.tag";
  assert.equal(__testing.safeTimPlayerUrl(first), first);
  assert.equal(__testing.safeTimPlayerUrl(target), "");
  assert.equal(__testing.safeTimPlayerResponseUrl(target, first, "selected-event"), "");
  assert.equal(__testing.safeTimOpaqueRedirectUrl(target, first, first, 0), target);
  assert.equal(__testing.safeTimOpaqueRedirectUrl(target, first, first, 1), "");
  assert.equal(__testing.safeTimOpaqueRedirectUrl(target, first.split("?")[0], first, 0), "");
  for (const value of [target + "?token=fixture", target + "#fragment", target + "/extra",
    target.replace("https:", "http:"), target.replace(".cfd/", ".cfd.evil.example/"),
    target.replace("ehgembxe.cfd", "user@ehgembxe.cfd"), target.replace(".cfd/", ".cfd:443/"),
    target.replace("header", "%68eader"), target.replace("header", "a".repeat(2048)),
    target.replace("/play/", "/play/../play/"), target.replace("ehgembxe.cfd", "exmxbxe.cfd"),
  ]) assert.equal(__testing.safeTimOpaqueRedirectUrl(value, first, first, 0), "");
});
test("TimStreams mirrors Android NFL and MLB event-bound redirect contracts", () => {
  const initial = "https://exmxbxe.cfd/player";
  const accepted = [
    ["falcons-v-packers-401872948", "/play/opaque.nfl-401872948"],
    ["Falcons-v-Packers-401872948", "/play/opaque.NFL-401872948"],
    ["red-sox-v-yankees-401862000", "/play/opaque.mlb-red-sox"],
    ["red-sox-v-yankees-401862000", "/play/opaque.mlb-yankees"],
  ];
  for (const [slug, path] of accepted) {
    const redirect = "https://exmxbxe.cfd" + path;
    assert.equal(__testing.safeTimPlayerResponseUrl(redirect, initial, slug), redirect);
  }
  const rejected = [
    ["falcons-v-packers-401872948", "/play/opaque.nfl-401872949"],
    ["unknown-v-packers-401872948", "/play/opaque.nfl-401872948"],
    ["falcons-v-falcons-401872948", "/play/opaque.nfl-401872948"],
    ["falcons-v-packers-401872948", "/play/opaque.unl-401872948"],
    ["czechia-v-spain-unl-401861118", "/play/opaque.nfl-401861118"],
    ["red-sox-v-yankees-401862000", "/play/opaque.mlb-astros"],
    ["red-sox-v-yankees-401862000", "/play/opaque.mlb-unknown"],
    ["red-soxish-v-yankees-401862000", "/play/opaque.mlb-red-sox"],
    ["red-v-yankees-401862000", "/play/opaque.mlb-red-sox"],
    ["czechia-v-spain-unl-401861118", "/play/opaque.mlb-yankees"],
  ];
  for (const [slug, path] of rejected) assert.equal(__testing.safeTimPlayerResponseUrl("https://exmxbxe.cfd" + path, initial, slug), "");
  assert.equal(__testing.safeTimPlayerResponseUrl("https://epiembeds.online/play/opaque.nfl-401872948", initial, accepted[0][0]), "");
});

test("current exmxbxe catalog row maps to an opaque event and player path ref", () => {
  const source = __testing.buildResolvedSource(
    { name: "DAZN Canada" },
    { url: "malta-v-andorra-unl-401861047" },
    "https://exmxbxe.cfd/hwjtsa6o-9268?session=short-lived",
    "https://media.example/live/master.m3u8?token=one",
    { Referer: "https://exmxbxe.cfd/", Origin: "https://exmxbxe.cfd" },
  );
  assert.equal(source.provider, "TimStreams");
  assert.equal(source.embedProvider, "TimStreams");
  assert.equal(source.url, "");
  assert.equal(source.embedUrl, "");
  assert.equal(source.providerSourceRef,
    "timstreams:v2~bWFsdGEtdi1hbmRvcnJhLXVubC00MDE4NjEwNDc~ZXhteGJ4ZS5jZmQ~L2h3anRzYTZvLTkyNjg");
  assert.equal(source.providerGeneration, "v2");
  assert.deepEqual(source.headers, {});
});

test("TimStreams player mapping rejects lookalike hosts, ports, traversal, and unsafe schemes", () => {
  for (const url of [
    "https://exmxbxe.cfd.attacker.test/player",
    "https://exmxbxe.cfd:443/player",
    "https://user@exmxbxe.cfd/player",
    "https://exmxbxe.cfd/../player",
    "https://exmxbxe.cfd/a/player",
    "http://exmxbxe.cfd/player",
    "https://evil.example/player",
  ]) {
    assert.equal(__testing.safeTimPlayerUrl(url), "", url);
    assert.equal(__testing.timProviderSourceRef({ url: "event-1" }, url), "", url);
  }
  assert.equal(__testing.safeTimPlayerUrl("https://exmxbxe.cfd/hwjtsa6o-9268"),
    "https://exmxbxe.cfd/hwjtsa6o-9268");
});

test("legacy unrecognized Tim hosts retain the pre-resolver bridge source", () => {
  const source = __testing.buildResolvedSource(
    { name: "Upcoming feed" },
    { url: "upcoming" },
    "https://timstreams.st/watch/upcoming",
  );
  assert.equal(source.url, "");
  assert.equal(source.embedUrl, "https://timstreams.st/watch/upcoming");
  assert.equal(source.provider, "TimStreams");
  assert.deepEqual(source.headers, { Referer: "https://tim-streams.com/" });
});

test("TimStreams canonicalizes only the exact Major League Baseball league label", () => {
  assert.equal(__testing.canonicalLeague("Major League Baseball", "Baseball", ""), "MLB");
  assert.equal(__testing.canonicalLeague("Minor League Baseball", "Baseball", ""), "Minor League Baseball");
  assert.equal(__testing.canonicalLeague("Baseball", "Baseball", "Major League Baseball Night"), "Baseball");
});

test("TimStreams corrects only the exact UEFA Nations League typo", () => {
  assert.equal(__testing.canonicalLeague("UEFA Nations Leauge", "Soccer", ""), "UEFA Nations League");
  assert.equal(__testing.canonicalLeague("UEFA Nations League 2", "Soccer", ""), "UEFA Nations League 2");
  assert.equal(__testing.canonicalLeague("UEFA Nations Leauge Special", "Soccer", ""), "UEFA Nations Leauge Special");
});

test("TimStreams prefers the current exact catalog domain and retains exact fallbacks", () => {
  assert.deepEqual(__testing.apiOrigins, ["https://tim-streams.com", "https://timst.top", "https://timst.cfd", "https://timstreams.st"]);
  assert.equal(__testing.safeWatchUrl({ url: "czechia-v-spain-unl-401861118" }), "https://tim-streams.com/watch/czechia-v-spain-unl-401861118");
  for (const slug of ["//attacker.test", "../escape", "https://attacker.test"]) {
    const watch = __testing.safeWatchUrl({ url: slug });
    assert.ok(!watch || new URL(watch).origin === "https://tim-streams.com");
  }
});

test("TimStreams UNL player redirects stay on the exact host and catalog event", () => {
  const initial = "https://exmxbxe.cfd/player";
  const event = "czechia-v-spain-unl-401861118";
  assert.equal(__testing.safeTimPlayerResponseUrl("https://exmxbxe.cfd/play/opaque.unl-401861118", initial, event), "https://exmxbxe.cfd/play/opaque.unl-401861118");
  for (const rejected of ["https://exmxbxe.cfd/play/opaque.unl-401861119", "https://epiembeds.online/play/opaque.unl-401861118", "https://exmxbxe.cfd:443/play/opaque.unl-401861118", "https://exmxbxe.cfd/play/opaque%2Fother.unl-401861118", "https://exmxbxe.cfd/play/../opaque.unl-401861118"]) {
    assert.equal(__testing.safeTimPlayerResponseUrl(rejected, initial, event), "");
  }
  assert.equal(__testing.timProviderSourceRef({ url: event }, "https://exmxbxe.cfd/play/opaque.unl-401861118"), "");
  assert.equal(__testing.safeTimPlayerResponseUrl("https://exmxbxe.cfd/unrelated", initial, event), "");
  assert.equal(__testing.safeTimPlayerResponseUrl("https://exmxbxe.cfd/play/opaque.unl-401861118", initial, "unknown-event"), "");
});

test("approved Tim players with invalid refs never publish signed transport fallback", () => {
  for (const event of [{ url: "../event" }, { url: "x".repeat(181) }]) {
    assert.equal(__testing.buildResolvedSource({ name: "Feed" }, event,
      "https://exmxbxe.cfd/player", "https://media.example/live.m3u8?private=transient",
      { Cookie: "private" }), null);
  }
});
