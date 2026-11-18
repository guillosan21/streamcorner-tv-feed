import test from "node:test";
import assert from "node:assert/strict";
import { collectSportsUpaMainGames, sportsUpaMainDeclaredHd, isSportsUpaMainSource } from "./sportsupa.mjs";

const api = "https://spotsupa.st/spotsupa-api/index.php/main";
const embed = "https://embed.st/embed/ingest/authoredmatch/1/";
const hd = 'function renderMainGroup(m){\nconst id=m.id;\nconst streams=getBestStreams(id);\nstreams.forEach((s,i)=>{\nrows+=`<a href="event/?src=best&bid=${s.id}&sid=${encodeURIComponent(id)}"><span class="sq-hd">HD</span></a>`;\n});\n}';
const meta = (id = "authored-match") => ({ id, title: "Home vs Away", date: Date.parse("2026-11-03T07:00:00Z"), teams: {home:{name:"Home"},away:{name:"Away"}} });
const record = (overrides = {}) => ({rev:123,streams:[{id:1,url:embed,language:"English"}],meta:meta(),...overrides});
const payload = (rec = record()) => ({items:{"authored-match":rec}});
async function collect(data, page = hd) {
  const requests = [];
  const games = await collectSportsUpaMainGames({now:new Date("2026-11-03T08:00:00Z"),
    fetchImpl: async (url, options) => {
      requests.push(url); assert.equal(options.redirect,"error");
      if(url === api) return new Response(JSON.stringify(data));
      if(url.includes("/matches/all")) return new Response("<!doctype html><html>SPA</html>");
      if(url === "https://spotsupa.st/") return new Response(page);
      throw new Error("Unexpected request");
    }, readTopics:async()=>{throw new Error("Current records must not borrow retained MQTT data");}});
  return {games, requests};
}

test("current public Main records bind authored metadata without the obsolete HTML API or MQTT", async () => {
  const {games,requests} = await collect(payload());
  assert.equal(games.length,1); assert.equal(games[0].sourceId,"authored-match");
  assert.equal(games[0].sources[0].embedUrl,embed); assert.equal(games[0].sources[0].hd,true);
  assert.equal(games[0].status,"upcoming"); assert.equal(requests.some(u=>u.includes("/matches/all")),false);
});
test("validated current API date remains authoritative over malformed or stale timestamp aliases", async () => {
  for(const timestamp of [1e100,Date.parse("2026-10-01T07:00:00Z"),"2026-12-25T07:00:00Z"]){
    const {games}=await collect(payload(record({meta:{...meta(),timestamp}})));
    assert.equal(games.length,1);
    assert.equal(games[0].startsAt,"2026-11-03T07:00:00.000Z");
  }
});
test("current API quality cannot borrow a legacy renderer HD declaration", async () => {
  const legacy='function renderBestStreams(){\nconst streams=getBestStreams();\nstreams.forEach((s,i)=>{row.dataset.url=s.url;row.innerHTML=`<span class="event-source-qual qual-hd">HD</span>`;});\n}';
  for(const page of [legacy,hd.replace('class="sq-hd">HD','class="sq-sd">SD')+"\n"+legacy]){
    assert.deepEqual((await collect(payload(),page)).games,[]);
  }
});
test("current Main HD declaration is scoped to its exact renderer and match-bound best links", () => {
  assert.equal(sportsUpaMainDeclaredHd(hd),true);
  for(const page of ["<span class=\"sq-hd\">HD</span>",hd.replace("getBestStreams(id)","getAdminStreams(id)"),hd.replace("sid=${encodeURIComponent(id)}","sid=other"),hd.replace(">HD<",">SD<")]) assert.equal(sportsUpaMainDeclaredHd(page),false);
});
test("authoritative empty, deleted, malformed identities, and unsupported players never revive legacy sources", async () => {
  const variants = [{items:{}},payload(record({meta:{...meta(),deleted:true}})),
    payload(record({meta:meta("different-match")})),payload(record({rev:-1})),
    payload(record({streams:[{id:1,url:embed.replace("embed.st","rockyembed.st") }]})),
    payload(record({meta:{...meta(),ppv:true,id:"ppv-123"}})),
    {items:{"authored-match":record(),"authored/match":record({meta:meta("authored/match")})}},
    payload(record({meta:{...meta(),date:1e100}})),payload(record({streams:Array(17).fill({id:1,url:embed})})),
    payload(record({meta:{...meta(),date:Date.parse("2026-10-01T07:00:00Z")}}))];
  for(const data of variants){const {games,requests}=await collect(data);assert.deepEqual(games,[]);assert.equal(requests.some(u=>u.includes("/matches/all")),false);}
});
test("deleted title aliases and PPV-derived metadata cannot relabel another provider as Main", async () => {
  const data={items:{"authored-match":record(),"deleted-match":record({meta:{...meta("deleted-match"),deleted:true}})}};
  assert.deepEqual((await collect(data)).games,[]);
  assert.deepEqual((await collect(payload(record({meta:{...meta(),sources:[{source:"ppv",id:"ppv-123"}]}})))).games,[]);
});
test("current Main can resolve only the existing exact public wrapper without admitting a new host", async () => {
  const wrapper="https://rockystream.st/source/fetch.php?hd=123";
  const requests=[];
  const games=await collectSportsUpaMainGames({now:new Date("2026-11-03T08:00:00Z"),fetchImpl:async(url)=>{
    requests.push(url);
    if(url===api)return new Response(JSON.stringify(payload(record({streams:[{id:1,url:wrapper}]}))));
    if(url==="https://spotsupa.st/")return new Response(hd);
    if(url===wrapper)return new Response(`atob("${Buffer.from(embed).toString("base64")}")`);
    throw new Error("Unexpected host");
  }});
  assert.equal(games[0].sources[0].embedUrl,embed);assert.equal(requests.length,3);
});
test("unavailable or malformed current API alone permits the legacy read-only fallback", async () => {
  const legacyHd='function renderBestStreams(){\nconst streams=getBestStreams();\nstreams.forEach((s,i)=>{row.dataset.url=s.url;row.innerHTML=`<span class="event-source-qual qual-hd">HD</span>`;});\n}';
  for(const primary of [()=>new Response("offline",{status:503}),()=>new Response("<!doctype html>"),()=>new Response('{"wrong":[]}')]){
    const games=await collectSportsUpaMainGames({now:new Date("2026-11-03T08:00:00Z"),fetchImpl:async(url)=>{
      if(url===api)return primary();
      if(url.endsWith("/matches/all"))return new Response(JSON.stringify([meta()]));
      if(url.startsWith("https://sportsupa.st/event/"))return new Response(legacyHd);
      return new Response(`atob("${Buffer.from(embed).toString("base64")}")`);
    },readTopics:async()=>new Map([["sportsupa-best-v2/authored-match",[{id:1,url:"https://rockystream.st/source/fetch.php?hd=123"}]]])});
    assert.equal(games.length,1);
  }
});

const dynamicHd = hd.replace('<span class="sq-hd">HD</span>', "${qualityBadge(s.quality,'sq-hd','sq-sd')}");
const currentEmbed = "https://streamec.st/embed/ch30.php";

test("new public Main catalog publishes exact Streamec HD and FHD rows with current provenance", async () => {
  for (const quality of ["HD", "FHD"]) {
    const { games, requests } = await collect(payload(record({streams:[{id:1,url:currentEmbed,quality}]})), dynamicHd);
    assert.equal(games.length, 1);
    assert.deepEqual(games[0].sources[0], {name:"SportsUpa • Main HD 1",url:"",embedUrl:currentEmbed,
      provider:"SportsUpa",embedProvider:"SportsUpa",hd:true,headers:{Referer:"https://spotsupa.st/"}});
    assert.equal(isSportsUpaMainSource(games[0].sources[0]), true);
    assert.deepEqual(requests, [api, "https://spotsupa.st/"]);
  }
});

test("dynamic Main quality is row-specific and cannot borrow unrelated HD markup", async () => {
  assert.equal(sportsUpaMainDeclaredHd(dynamicHd, "current"), true);
  for (const quality of [undefined, null, true, "SD", "", "hd", "1080p", " HD "]) {
    for (const url of [currentEmbed, embed]) {
      assert.deepEqual((await collect(payload(record({streams:[{id:1,url,quality}]})),dynamicHd)).games, []);
    }
    assert.deepEqual((await collect(payload(record({streams:[{id:1,url:currentEmbed,quality}]})),hd)).games, []);
  }
  const unrelated = dynamicHd.replace("qualityBadge(s.quality,'sq-hd','sq-sd')", "qualityBadge(s.quality,'sq-sd','sq-hd')") +
    "\nfunction renderAdmin(){return qualityBadge(s.quality,'sq-hd','sq-sd')}";
  assert.equal(sportsUpaMainDeclaredHd(unrelated,"current"), false);
  const {games}=await collect(payload(record({streams:[{id:1,url:currentEmbed,quality:"SD"},
    {id:2,url:"https://streamec.st/embed/ch31.php",quality:"HD"}]})),dynamicHd);
  assert.equal(games[0].sources.length,1);
  assert.equal(games[0].sources[0].embedUrl,"https://streamec.st/embed/ch31.php");
});

test("new Main source contract rejects credentials, media state, alternate routes and origins", async () => {
  const source = {provider:"SportsUpa",embedProvider:"SportsUpa",hd:true,url:"",embedUrl:currentEmbed,
    headers:{Referer:"https://spotsupa.st/"}};
  for (const embedUrl of ["",currentEmbed+"?token=secret",currentEmbed+"#player",currentEmbed+"/",
    currentEmbed.replace("https:","http:"),currentEmbed.replace("streamec.st","streamec.st:443"),
    currentEmbed.replace("streamec.st","user@streamec.st"),currentEmbed.replace("streamec.st","sub.streamec.st"),
    currentEmbed.replace("ch30","ch0"),currentEmbed.replace("ch30","ch030"),currentEmbed.replace("ch30","ch1000"),
    currentEmbed.replace("/embed/","/x/../embed/"),currentEmbed.replace("ch30","ch%33%30"),
    currentEmbed.replace(".php",".m3u8"),currentEmbed+"\n"]) {
    assert.equal(isSportsUpaMainSource({...source,embedUrl}),false,embedUrl);
    assert.deepEqual((await collect(payload(record({streams:[{id:1,url:embedUrl,quality:"HD"}]})),dynamicHd)).games,[]);
  }
  for (const override of [{provider:"PPV"},{embedProvider:"PPV"},{hd:false},{url:"https://cdn.test/live.m3u8"},
    {clearKey:"secret"},{providerSourceRef:"ppv:1"},{headers:{Referer:"https://sportsupa.st/"}},
    {headers:{Referer:"https://spotsupa.st/",Cookie:"secret"}}]) {
    assert.equal(isSportsUpaMainSource({...source,...override}),false);
  }
});
