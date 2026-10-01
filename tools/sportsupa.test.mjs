import test from "node:test";
import assert from "node:assert/strict";
import {
  collectSportsUpaAdminGames,
  collectSportsUpaMainGames,
  decodeSportsUpaMainWrapper,
  parseSportsUpaMainPayload,
  parseSportsUpaMqttPackets,
  readSportsUpaMainTopics,
  sportsUpaMainDeclaredHd,
  sportsUpaMainTopic,
  sportsUpaMainWrapperUrl,
  gateSportsUpaDiagnosticGames,
  isSportsUpaMainSource,
  isSportsUpaAdminSource,
  sportsUpaAdminSources,
  sportsUpaDiagnosticPlaybackEnabled,
} from "./sportsupa.mjs";

const mainId = "houston-astros-vs-chicago-white-sox-2610873";
const mainEmbed = "https://embed.st/embed/ingest/mhoustonastros/1/";
const mainWrapper = "https://rockystream.st/source/fetch.php?id=public-bootstrap";
const hdDeclaration = `function renderBestStreams(){
const streams=getBestStreams();
streams.forEach((s,i)=>{
row.dataset.url=s.url;
row.innerHTML=\`<span class="event-source-qual qual-hd">HD</span>\`;
});
}`;
const wrapperHtml = (url = mainEmbed) => `f.src=atob("${Buffer.from(url).toString("base64")}");`;
const mainMatch = { id: mainId, title: "Houston Astros vs Chicago White Sox", date: 1790802000000,
  category: "baseball", teams: { home: { name: "Houston Astros" }, away: { name: "Chicago White Sox" } },
  sources: [{ source: "admin", id: "irrelevant-admin" }, { source: "delta", id: "irrelevant-delta" }] };

test("Main payload parser and topic formatting fail closed on malformed or oversized data", () => {
  assert.equal(sportsUpaMainTopic(mainId), `sportsupa-best-v2/${mainId}`);
  assert.equal(sportsUpaMainTopic("x".repeat(61)), `sportsupa-best-v2/${"x".repeat(60)}`);
  assert.equal(sportsUpaMainTopic("A/b"), "sportsupa-best-v2/A-b");
  for (const data of ["{", "{}", "null", "x".repeat(70_000), JSON.stringify(Array(17).fill({id:1,url:mainWrapper}))]) {
    assert.deepEqual(parseSportsUpaMainPayload(data), []);
  }
  assert.deepEqual(parseSportsUpaMainPayload(JSON.stringify([{id:1,url:mainWrapper,language:"English"}, {url:mainWrapper}])),
    [{id:1,url:mainWrapper,language:"English"}]);
});

test("Main wrapper permits only exact HTTPS public wrapper and canonical query-free ingest data", () => {
  assert.equal(sportsUpaMainWrapperUrl(mainWrapper), mainWrapper);
  for (const u of [mainWrapper.replace("https:", "http:"), mainWrapper.replace("rockystream.st", "rockystream.st.evil.test"),
    mainWrapper.replace("source/fetch", "admin/fetch"), mainWrapper.replace("rockystream.st", "user:pass@rockystream.st"), `${mainWrapper}#bad`]) {
    assert.equal(sportsUpaMainWrapperUrl(u), "");
  }
  assert.equal(decodeSportsUpaMainWrapper(wrapperHtml()), mainEmbed);
  assert.equal(decodeSportsUpaMainWrapper(wrapperHtml(`${mainEmbed}#player=clappr&autoplay=true`)), mainEmbed);
  for (const u of [`${mainEmbed}?sig=secret`, `${mainEmbed}#secret`, mainEmbed.replace("ingest", "admin"),
    mainEmbed.replace("embed.st", "evil.test"), mainEmbed.replace("https:", "http:")]) {
    assert.equal(decodeSportsUpaMainWrapper(wrapperHtml(u)), "");
  }
  assert.equal(decodeSportsUpaMainWrapper("atob(window.secret); eval('unknown');"), "");
  assert.equal(decodeSportsUpaMainWrapper(wrapperHtml() + wrapperHtml(mainEmbed.replace("/1/", "/2/"))), "");
  assert.equal(decodeSportsUpaMainWrapper("x".repeat(513_000)), "");
});

test("quality declaration is bound to fresh Main renderer, not arbitrary HD text", () => {
  assert.equal(sportsUpaMainDeclaredHd(hdDeclaration), true);
  for (const html of ["HD", "<span class=qual-hd>HD</span>", hdDeclaration.replace("HD</span>", "SD</span>"),
    hdDeclaration.replace("getBestStreams", "getAdminStreams")]) assert.equal(sportsUpaMainDeclaredHd(html), false);
});

test("published Main provenance excludes SD, Admin, media, secrets and noncanonical URLs", () => {
  const source = { provider:"SportsUpa",embedProvider:"SportsUpa",hd:true,url:"",embedUrl:mainEmbed,
    headers:{Referer:"https://sportsupa.st/"} };
  assert.equal(isSportsUpaMainSource(source), true);
  for (const override of [{hd:false},{hd:undefined},{embedProvider:"StreamCorner"},{provider:"Other"},
    {url:"https://cdn.test/live.m3u8?sig=secret"},{clearKey:"secret"}, {headers:{Referer:"https://sportsupa.st/",Cookie:"secret"}},
    ...[mainEmbed.replace("/1/","/0/"),mainEmbed.replace("/1/","/001/"),mainEmbed.replace("embed.st","embed.st:443"),
      mainEmbed.replace("/ingest/","/x/../ingest/"),`${mainEmbed}#player=clappr&autoplay=true`,`${mainEmbed}?sig=x`,
      mainEmbed.replace("ingest","admin")].map(embedUrl=>({embedUrl}))]) assert.equal(isSportsUpaMainSource({...source,...override}), false);
});

function publishPacket(topic, payload) {
  const topicData = Buffer.from(topic), length = Buffer.alloc(2);
  length.writeUInt16BE(topicData.length);
  const body = Buffer.concat([length, topicData, Buffer.from(payload)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

test("MQTT parser supports concatenated and fragmented packets and rejects invalid lengths", () => {
  const packet = publishPacket("sportsupa-best-v2/test", "[]");
  assert.equal(parseSportsUpaMqttPackets(packet).packets[0].topic, "sportsupa-best-v2/test");
  assert.equal(parseSportsUpaMqttPackets(Buffer.concat([packet, packet])).packets.length, 2);
  const head = parseSportsUpaMqttPackets(packet.subarray(0, 10));
  assert.equal(head.packets.length, 0);
  assert.equal(parseSportsUpaMqttPackets(Buffer.concat([head.rest, packet.subarray(10)])).packets.length, 1);
  assert.throws(() => parseSportsUpaMqttPackets(Buffer.from([0x30,255,255,255,255])), /length/);
  assert.throws(() => parseSportsUpaMqttPackets(Buffer.from([0x30,2,0,50])), /topic/);
});

test("MQTT transport is anonymous, exact read-only subscription with no publish or request topic", async () => {
  const sent = [];
  class Socket extends EventTarget {
    constructor(url, protocol) {
      super(); assert.equal(url, "wss://broker.hivemq.com:8884/mqtt"); assert.equal(protocol, "mqtt");
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(packet) {
      sent.push(Buffer.from(packet));
      const bytes = sent.length === 1 ? Buffer.from([0x20,2,0,0]) : publishPacket("sportsupa-best-v2/test", "[]");
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {data:bytes})));
    }
    close() {}
  }
  const rows = await readSportsUpaMainTopics(["sportsupa-best-v2/test", "sportsupa-best-v2/#"], {WebSocketImpl:Socket, timeoutMs:100});
  assert.deepEqual([...rows.keys()], ["sportsupa-best-v2/test"]);
  assert.deepEqual(sent.map((p) => p[0] >> 4), [1,8]);
  assert.equal(sent[0][9], 2); // clean session; no username/password flags
  assert.equal(sent[1].includes(Buffer.from("#")), false);
});

test("normal Main collector binds catalog metadata, excludes other categories, strips transport data", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(url);
    if (url.endsWith("/matches/all")) return {ok:true, text:async()=>JSON.stringify([mainMatch])};
    assert.equal(options.redirect, "error");
    return {ok:true,text:async()=> url.startsWith("https://sportsupa.st/event/") ? hdDeclaration : wrapperHtml()};
  };
  const readTopics = async (topics) => {
    assert.deepEqual(topics, [sportsUpaMainTopic(mainId)]);
    return new Map([[topics[0],[{id:1,url:mainWrapper,language:"English"},
      {id:2,url:"https://embed.st/embed/admin/other/1"}]], ["sportsupa-best-v2/unrelated",[{id:1,url:mainWrapper}]]]);
  };
  const games = await collectSportsUpaMainGames({fetchImpl,readTopics,now:new Date("2026-09-30T22:00:00Z")});
  assert.equal(games.length, 1);
  assert.equal(games[0].sourceId, mainId);
  assert.equal(games[0].status, "upcoming");
  assert.equal(games[0].startsAt, "2026-09-30T21:00:00.000Z");
  assert.equal(games[0].homeTeam, "Houston Astros");
  assert.equal(games[0].sources.length, 1);
  assert.equal(games[0].sources[0].embedUrl, mainEmbed);
  assert.equal(games[0].sources[0].hd, true);
  assert.equal(games[0].sources[0].url, "");
  assert.equal(JSON.stringify(games).includes("public-bootstrap"), false);
  assert.equal(requests.some((u)=>u.includes("/stream/")), false);
});

test("Main collector excludes unknown quality, topic collisions, and failed wrapper responses", async () => {
  const collect = (matches, page, failWrapper=false) => collectSportsUpaMainGames({
    fetchImpl:async(url)=>url.endsWith("/matches/all") ? {ok:true,text:async()=>JSON.stringify(matches)} :
      {ok:!failWrapper||url.startsWith("https://sportsupa.st/"),text:async()=>url.startsWith("https://sportsupa.st/")?page:wrapperHtml()},
    readTopics:async()=>new Map([[sportsUpaMainTopic(mainId),[{id:1,url:mainWrapper}]]]),
  });
  assert.deepEqual(await collect([mainMatch], "SD"), []);
  assert.deepEqual(await collect([mainMatch], hdDeclaration, true), []);
  assert.deepEqual(await collect([{...mainMatch,id:"x".repeat(60)+"a"},{...mainMatch,id:"x".repeat(60)+"b"}], hdDeclaration), []);
});

test("Main catalog JSON obeys advertised and streamed body limits before subscribing", async () => {
  const readTopics = async () => { throw new Error("must not subscribe"); };
  await assert.rejects(collectSportsUpaMainGames({
    fetchImpl: async () => new Response("[]", {headers: {"content-length": "512001"}}), readTopics,
  }), /body limit/);
  await assert.rejects(collectSportsUpaMainGames({
    fetchImpl: async () => new Response(" ".repeat(512001)), readTopics,
  }), /body limit/);
});

const hdRow = {
  source_name: "English - ESPN",
  hd: true,
  embedUrl: "https://embed.st/embed/admin/nhl-event/1",
};

test("SportsUpa admits only explicitly HD public Admin embed rows", () => {
  const sources = sportsUpaAdminSources([
    hdRow,
    { ...hdRow, hd: false, embedUrl: "https://embed.st/embed/admin/nhl-event/2" },
    { ...hdRow, hd: null, embedUrl: "https://embed.st/embed/admin/nhl-event/3" },
    { ...hdRow, hd: true, embedUrl: "https://evil.example/embed/admin/nhl-event/4" },
    { ...hdRow, hd: true, embedUrl: "https://embed.st/embed/delta/nhl-event/5" },
    { ...hdRow, hd: true, embedUrl: "https://embed.st/embed/admin/nhl-event/6?sig=opaque" },
  ]);

  assert.equal(sources.length, 1);
  assert.equal(sources[0].provider, "SportsUpa");
  assert.equal(sources[0].embedProvider, "SportsUpa");
  assert.equal(sources[0].hd, true);
  assert.equal(sources[0].name, "SportsUpa • Admin HD 1");
  assert.equal(isSportsUpaAdminSource(sources[0]), true);
  for (const bad of [
    {...sources[0], hd: false}, {...sources[0], hd: null},
    {...sources[0], embedUrl: "https://embed.st/embed/admin/event/0"},
    {...sources[0], embedUrl: "https://embed.st/embed/admin/../1"},
    {...sources[0], embedUrl: "https://embed.st:443/embed/admin/event/1"},
    {...sources[0], headers: {Referer: "https://sportsupa.st/", Authorization: "secret"}},
  ]) assert.equal(isSportsUpaAdminSource(bad), false);
  assert.equal(sources[0].headers.Referer, "https://sportsupa.st/");
  assert.deepEqual(sportsUpaAdminSources([hdRow], "main"), []);
  assert.deepEqual(sportsUpaAdminSources([hdRow], "delta"), []);
  assert.deepEqual(sportsUpaAdminSources([hdRow], "admin", "different-event"), []);
});

test("explicit diagnostics remain separately gated by literal true", () => {
  const candidate = [{ id: "sportsupa-event", status: "upcoming" }];

  assert.equal(sportsUpaDiagnosticPlaybackEnabled(undefined), false);
  assert.equal(sportsUpaDiagnosticPlaybackEnabled("TRUE"), false);
  assert.equal(sportsUpaDiagnosticPlaybackEnabled("1"), false);
  assert.equal(sportsUpaDiagnosticPlaybackEnabled("yes"), false);
  assert.deepEqual(gateSportsUpaDiagnosticGames(candidate, false), []);
  assert.equal(sportsUpaDiagnosticPlaybackEnabled("true"), true);
  assert.deepEqual(gateSportsUpaDiagnosticGames(candidate, true), candidate);
});

test("public Admin collector excludes other categories and never labels rows live", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith("/matches/all")) {
      return {
        ok: true,
        text: async () => JSON.stringify([
          { id: "event-1", title: "Example at Home", timestamp: 1_800_000_000, sources: [
            { source: "admin", id: "admin-one" },
            { source: "delta", id: "delta-one" },
          ] },
          { id: "event-2", title: "Not Admin", timestamp: 1_800_000_000, sources: [
            { source: "delta", id: "delta-two" },
          ] },
        ]),
      };
    }
    assert.match(url, /\/stream\/admin\/admin-one$/);
    const boundRow = { ...hdRow, embedUrl: "https://embed.st/embed/admin/admin-one/1" };
    return { ok: true, text: async () => JSON.stringify([boundRow, { ...boundRow, hd: false },
      { ...hdRow, embedUrl: "https://embed.st/embed/admin/unrelated-event/1" }]) };
  };

  const games = await collectSportsUpaAdminGames({ fetchImpl, now: new Date("2026-09-29T00:00:00Z") });

  assert.equal(requests.length, 2);
  assert.equal(games.length, 1);
  assert.equal(games[0].id, "sportsupa-event-1");
  assert.equal(games[0].status, "upcoming");
  assert.equal(games[0].sources.length, 1);
});
