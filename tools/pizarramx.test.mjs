import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchPizarraMxGames,
  parsePizarraMxAssignment,
  parsePizarraMxCatalog,
  PIZARRAMX_PAGE_URL,
  PIZARRAMX_SOURCE_REF_PATTERN,
  retainPreviousPizarraMxGames,
} from "./pizarramx.mjs";
import {
  deduplicatePlaybackSources,
  feedSourceKey,
  isValidPizarraMxSourceRef,
  playbackIdentity,
} from "./playback-identity.mjs";

const eventSource = (embed, fuente = "CANAL 5") => ({ fuente, embed: `<iframe src="${embed}" title="signal"></iframe>` });

function sampleData() {
  return {
    data: {
      partidos: [
        {
          id: "match-42", competition: "Liga BBVA MX", home: "<b>Cruz Azul</b>", away: "Toluca",
          status: "live", fechaISO: "2026-09-26T20:30:00Z",
        },
        {
          id: "match-up", competition: "Liga MX", home: "Santos Laguna", away: "Pachuca",
          status: "ns", fechaISO: "2026-09-27", kickoff: "2026-09-27T01:05:00Z",
        },
        {
          id: "match-final", competition: "Liga MX", home: "Atlas", away: "Monterrey", status: "ft",
        },
      ],
      detalles: {
        "match-42": { directo: [
          eventSource("https://la18hd.su/vivo/canales.php?stream=canal5", "CANAL 5"),
          eventSource("https://la18hd.su/vivo/canales.php?stream=canal5", " CANAL   5 "),
          eventSource("https://exmxbxe.cfd/q2u5urq3-392", "TUDN HD"),
          eventSource("https://www.youtube.com/embed/video-1", "YouTube"),
          eventSource("https://not-approved.example/embed/1", "Unsafe"),
        ] },
        "match-up": { directo: [eventSource("https://streamx305.sbs/global1.php?channel=global1", "TUDN") ] },
        "match-final": { directo: [eventSource("https://exmxbxe.cfd/final") ] },
      },
    },
    manual: [
      {
        activo: true, competicion: "Amistoso Internacional", local: "EE.UU.", visitante: "Perú",
        kickoff: "2026-09-26T20:30:00Z",
        opciones: [
          eventSource("https://exmxbxe.cfd/friendly-42", "TELEMUNDO"),
          eventSource("https://www.youtube.com/watch?v=not-native", "YouTube"),
        ],
      },
      {
        activo: false, competicion: "Liga MX", local: "Pumas", visitante: "León",
        opciones: [eventSource("https://exmxbxe.cfd/inactive")],
      },
    ],
  };
}

test("Pizarra assignments accept only bounded JSON on one exact window variable", () => {
  assert.deepEqual(parsePizarraMxAssignment(
    "// generated\nwindow.DATOS_REALES = {\"partidos\":[],\"detalles\":{}};\n",
    "DATOS_REALES",
  ), { partidos: [], detalles: {} });
  assert.deepEqual(parsePizarraMxAssignment("window.TRANSMISIONES_MANUALES = [];", "TRANSMISIONES_MANUALES"), []);
  for (const [source, variable] of [
    ["window.DATOS_REALES = {partidos:[]};", "DATOS_REALES"],
    ["window.OTHER = {};", "DATOS_REALES"],
    ["window.DATOS_REALES = {}; globalThis.compromised = true;", "DATOS_REALES"],
    ["window.DATOS_REALES = {}; window.DATOS_REALES = {};", "DATOS_REALES"],
    ["window.DATOS_REALES = [];", "DATOS_REALES"],
  ]) assert.throws(() => parsePizarraMxAssignment(source, variable));
  assert.equal(globalThis.compromised, undefined);
  assert.throws(() => parsePizarraMxAssignment(`window.DATOS_REALES = {"padding":"${"x".repeat(512_001)}"};`, "DATOS_REALES"), /size limit/);
});

test("Pizarra event and manual mapping emits URL-free refs with live and schedule state", () => {
  const { data, manual } = sampleData();
  const games = parsePizarraMxCatalog(data, manual);
  assert.equal(games.length, 3);
  const live = games.find((game) => game.id === "pizarramx-match-42");
  assert.equal(live.status, "live");
  assert.equal(live.scheduleState, "in");
  assert.equal(live.startsAt, "2026-09-26T20:30:00.000Z");
  assert.equal(live.homeTeam, "Cruz Azul");
  assert.equal(live.title, "Cruz Azul vs Toluca");
  assert.equal(live.sport, "Soccer");
  assert.equal(live.is24x7, false);
  assert.equal(live.sources.length, 2);
  const upcoming = games.find((game) => game.id === "pizarramx-match-up");
  assert.equal(upcoming.status, "upcoming");
  assert.equal(upcoming.scheduleState, "pre");
  assert.equal(upcoming.startsAt, "2026-09-27T01:05:00.000Z");

  const manualGame = games.find((game) => game.id.startsWith("pizarramx-manual-"));
  assert.equal(manualGame.status, "live");
  assert.equal(manualGame.scheduleState, "in");
  assert.equal(manualGame.startsAt, "");
  assert.equal(manualGame.is24x7, false);
  assert.equal(manualGame.sources.length, 1);

  const serialized = JSON.stringify(games);
  for (const privateValue of ["la18hd.su", "exmxbxe.cfd", "streamx305.sbs", "youtube.com", "global1", "canal5", "friendly-42"]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
  for (const game of games) {
    assert.ok(game.sources.every((source) => source.url === "" && source.embedUrl === "" &&
      Object.keys(source.headers).length === 0 && isValidPizarraMxSourceRef(source.providerSourceRef)));
  }
});

test("Pizarra catalog requires partidos while accepting a valid empty catalog", () => {
  for (const invalid of [{}, { partidos: null }, { partidos: {} }, null, []]) {
    assert.throws(() => parsePizarraMxCatalog(invalid), /partidos array/);
  }
  assert.deepEqual(parsePizarraMxCatalog({ partidos: [], detalles: {} }), []);
});

test("Pizarra references use the shared event and canonical-embed digest vector", () => {
  // Kotlin resolver parity vector: event key `match-42`, canonical embed below.
  const { data, manual } = sampleData();
  const game = parsePizarraMxCatalog(data, manual).find((item) => item.id === "pizarramx-match-42");
  assert.equal(
    game.sources[0].providerSourceRef,
    "pizarramx:v1~e~7568565023f6f4ee101b0775ce8cca3340c08e724f17d852799f2363c139bc46~453f7419178d3f109a0c3cc4b3f392b1f0baa87080fc1710470eb5038813b50f",
  );
  assert.match(game.sources[0].providerSourceRef, PIZARRAMX_SOURCE_REF_PATTERN);
  assert.equal(playbackIdentity(game.sources[0]), `resolver:${game.sources[0].providerSourceRef}:generation:v1`);
  assert.equal(deduplicatePlaybackSources([game.sources[0], { ...game.sources[0] }]).length, 1);
  assert.equal(isValidPizarraMxSourceRef("pizarramx:v1~e~bad~bad"), false);
  assert.equal(feedSourceKey(game.sources[0]), feedSourceKey({ ...game.sources[0] }));
  assert.notEqual(feedSourceKey(game.sources[0]), feedSourceKey({
    ...game.sources[0],
    providerSourceRef: game.sources[0].providerSourceRef.replace(/([0-9a-f])$/, (_, nibble) => nibble === "0" ? "1" : "0"),
  }));

  const manualVector = parsePizarraMxCatalog({ partidos: [], detalles: {} }, [{
    activo: true,
    competicion: "Amistoso Internacional",
    local: "EE.UU.",
    visitante: "Perú",
    kickoff: "2026-09-26T20:30:00Z",
    opciones: [eventSource("https://exmxbxe.cfd/friendly-42", "TELEMUNDO")],
  }]);
  assert.equal(
    manualVector[0].sources[0].providerSourceRef,
    "pizarramx:v1~m~15e6c3ba00e66ef9977d01987cd3842a5ede445c42ff52283e46aff2295e7d02~13321651a15fc5303e8cbbc18294ce9e545dbeaecfa951a26f15bdb0b9d2a843",
  );
});

test("Pizarra reference canonicalizes query order and preserves unknown query parameters", () => {
  const first = eventSource("https://la18hd.su/vivo/canales.php?stream=canal5&lang=es", "CANAL 5");
  const reordered = eventSource("https://la18hd.su/vivo/canales.php?lang=es&stream=canal5", "CANAL 5");
  const data = {
    partidos: [{ id: "match-42", competition: "Liga MX", home: "Cruz Azul", away: "Toluca", status: "live" }],
    detalles: { "match-42": { directo: [first, reordered] } },
  };
  const refs = parsePizarraMxCatalog(data).flatMap((game) => game.sources.map((source) => source.providerSourceRef));
  assert.equal(refs.length, 1);
  assert.notEqual(refs[0], "pizarramx:v1~e~7568565023f6f4ee101b0775ce8cca3340c08e724f17d852799f2363c139bc46~453f7419178d3f109a0c3cc4b3f392b1f0baa87080fc1710470eb5038813b50f");
  const changedQuery = parsePizarraMxCatalog({
    ...data,
    detalles: { "match-42": { directo: [eventSource("https://la18hd.su/vivo/canales.php?stream=canal5&lang=en", "CANAL 5")] } },
  }).flatMap((game) => game.sources.map((source) => source.providerSourceRef));
  assert.notEqual(changedQuery[0], refs[0]);
});

test("Pizarra omits upcoming events when only a date, not a kickoff timestamp, is available", () => {
  const games = parsePizarraMxCatalog({
    partidos: [{
      id: "date-only", competition: "Liga MX", home: "Santos Laguna", away: "Pachuca",
      status: "ns", fechaISO: "2026-09-27", time: "26 sep · 03:05",
    }],
    detalles: { "date-only": { directo: [eventSource("https://la18hd.su/vivo/canales.php?stream=canal5")] } },
  });
  assert.deepEqual(games, []);
});

test("Pizarra upcoming event uses a validated ISO kickoff over date-only fechaISO", () => {
  const games = parsePizarraMxCatalog({
    partidos: [{
      id: "kickoff-check", competition: "Liga MX", home: "Tigres", away: "Puebla",
      status: "ns", fechaISO: "2026-09-27", kickoff: "2026-09-27T03:05:00Z",
      time: "26 sep · 10:05 PM",
    }],
    detalles: { "kickoff-check": { directo: [eventSource("https://la18hd.su/vivo/canales.php?stream=canal5")] } },
  });
  assert.equal(games.length, 1);
  assert.equal(games[0].status, "upcoming");
  assert.equal(games[0].scheduleState, "pre");
  assert.equal(games[0].startsAt, "2026-09-27T03:05:00.000Z");
});

test("Pizarra rejects raw or encoded path traversal on every allowed embed host", () => {
  // Shared JS/Kotlin admission parity vectors: each must fail before URL normalization.
  const unsafeEmbeds = [
    "https://exmxbxe.cfd/a/%2e%2e/b",
    "https://exmxbxe.cfd/a/%2f..%2fb",
    "https://exmxbxe.cfd/a/%252e%252e/b",
    "https://la18hd.su/vivo/%2e%2e/vivo/canales.php?stream=canal5",
    "https://streamx305.sbs/a/%2E%2e/global1.php?channel=global1",
  ];
  for (const [index, embed] of unsafeEmbeds.entries()) {
    const games = parsePizarraMxCatalog({
      partidos: [{ id: `unsafe-${index}`, competition: "Liga MX", home: "Home", away: "Away", status: "live" }],
      detalles: { [`unsafe-${index}`]: { directo: [eventSource(embed)] } },
    });
    assert.deepEqual(games, [], embed);
  }
});

test("Pizarra rejects malformed percent escapes before canonical URL parsing", () => {
  const malformedEmbeds = [
    "https://exmxbxe.cfd/channel%",
    "https://exmxbxe.cfd/channel%2",
    "https://exmxbxe.cfd/channel/%GG",
    "https://exmxbxe.cfd/channel?token=%GG",
    "https://la18hd.su/vivo/canales.php?stream=canal5&lang=%",
    "https://streamx305.sbs/global1.php?channel=global1&lang=%2",
  ];
  for (const [index, embed] of malformedEmbeds.entries()) {
    const games = parsePizarraMxCatalog({
      partidos: [{ id: `bad-escape-${index}`, competition: "Liga MX", home: "Home", away: "Away", status: "live" }],
      detalles: { [`bad-escape-${index}`]: { directo: [eventSource(embed)] } },
    });
    assert.deepEqual(games, [], embed);
  }
});

test("Pizarra rejects empty or ambiguous raw query segments", () => {
  const invalidQueries = [
    "https://la18hd.su/vivo/canales.php?stream=one&",
    "https://la18hd.su/vivo/canales.php?&stream=one",
    "https://la18hd.su/vivo/canales.php?stream=one&&lang=es",
    "https://la18hd.su/vivo/canales.php?stream=one&lang",
    "https://streamx305.sbs/global1.php?channel=one&=value",
    "https://exmxbxe.cfd/opaque?",
  ];
  for (const [index, embed] of invalidQueries.entries()) {
    const games = parsePizarraMxCatalog({
      partidos: [{ id: `ambiguous-query-${index}`, competition: "Liga MX", home: "Home", away: "Away", status: "live" }],
      detalles: { [`ambiguous-query-${index}`]: { directo: [eventSource(embed)] } },
    });
    assert.deepEqual(games, [], embed);
  }
});

test("Pizarra fallback carries forward only recent-looking valid opaque refs", () => {
  const now = new Date("2026-09-26T20:00:00Z");
  const games = parsePizarraMxCatalog(sampleData().data, sampleData().manual);
  const feed = {
    updatedAt: "2026-09-26T19:55:00Z",
    games: [
      ...games.map((game, index) => index === 0 ? {
        ...game,
        sources: [...game.sources, { provider: "PPV", name: "PPV • stale", url: "https://old.example/live.m3u8" }],
      } : game),
      { ...games[0], id: "bad-pizarra", sources: [{ ...games[0].sources[0], url: "https://old.example/live.m3u8" }] },
      { ...games[0], id: "expired-pizarra", startsAt: "2026-09-26T01:00:00Z" },
    ],
  };
  const retained = retainPreviousPizarraMxGames(feed, now);
  assert.deepEqual(retained.map((game) => game.id), games.map((game) => game.id));
  assert.ok(retained.every((game) => game.sources.every((source) =>
    source.provider === "Pizarra MX" && isValidPizarraMxSourceRef(source.providerSourceRef) && !source.url && !source.embedUrl)));
});

test("duplicate Pizarra event and manual rows merge only distinct option refs", () => {
  const firstManual = {
    activo: true, competicion: "Friendly", local: "Mexico", visitante: "Canada",
    opciones: [eventSource("https://exmxbxe.cfd/friendly-a", "A")],
  };
  const secondManual = {
    ...firstManual,
    opciones: [eventSource("https://exmxbxe.cfd/friendly-a", "A"), eventSource("https://exmxbxe.cfd/friendly-b", "B")],
  };
  const games = parsePizarraMxCatalog({
    partidos: [
      { id: "match-1", competition: "Liga MX", home: "Mexico", away: "Canada", status: "live" },
      { id: "match-1", competition: "Liga MX", home: "Mexico", away: "Canada", status: "live" },
    ],
    detalles: { "match-1": { directo: [eventSource("https://la18hd.su/vivo/canales.php?stream=one", "One")] } },
  }, [firstManual, secondManual]);
  assert.equal(games.length, 2);
  assert.equal(games[0].sources.length, 1);
  assert.equal(games[1].sources.length, 2);
});

test("Pizarra fetch is restricted to the exact page and its same-origin assignment scripts", async () => {
  const { data, manual } = sampleData();
  const dataScript = `// comment\nwindow.DATOS_REALES = ${JSON.stringify(data)};`;
  const manualScript = `window.TRANSMISIONES_MANUALES = ${JSON.stringify(manual)};`;
  const requested = [];
  const result = await fetchPizarraMxGames(new Date("2026-09-26T20:30:00Z"), {
    timeoutMs: 1_000,
    fetcher: async (url, init) => {
      requested.push({ url, init });
      const body = url === PIZARRAMX_PAGE_URL
        ? '<script src="/datos/salida/datos.js?v=4.2"></script><script src="/transmisiones-manuales.js?v=1.60"></script>'
        : url.endsWith("/datos/salida/datos.js?v=4.2") ? dataScript
          : url.endsWith("/transmisiones-manuales.js?v=1.60") ? manualScript : "not found";
      return new Response(body, { status: body === "not found" ? 404 : 200 });
    },
  });

  assert.equal(result.error, "");
  assert.equal(result.catalogCount, 3);
  assert.deepEqual(requested.map(({ url }) => url), [
    PIZARRAMX_PAGE_URL,
    "https://pizarramx.com.mx/datos/salida/datos.js?v=4.2",
    "https://pizarramx.com.mx/transmisiones-manuales.js?v=1.60",
  ]);
  assert.ok(requested.every(({ init }) => init.redirect === "error" && init.signal));
});

test("Pizarra fetch rejects off-origin script paths without following them", async () => {
  const requested = [];
  const result = await fetchPizarraMxGames(new Date(), {
    fetcher: async (url) => {
      requested.push(url);
      return new Response('<script src="https://evil.example/datos/salida/datos.js"></script>', { status: 200 });
    },
  });
  assert.deepEqual(requested, [PIZARRAMX_PAGE_URL]);
  assert.equal(result.games.length, 0);
  assert.equal(result.catalogCount, 0);
  assert.equal(result.error, "source unavailable or invalid");
});

test("Pizarra fetch reports missing partidos as invalid but accepts an empty catalog", async () => {
  const fetchCatalog = async (catalog) => fetchPizarraMxGames(new Date(), {
    fetcher: async (url) => {
      if (url === PIZARRAMX_PAGE_URL) {
        return new Response('<script src="/datos/salida/datos.js"></script><script src="/transmisiones-manuales.js"></script>', { status: 200 });
      }
      if (url.endsWith("/datos/salida/datos.js")) return new Response(`window.DATOS_REALES = ${JSON.stringify(catalog)};`, { status: 200 });
      if (url.endsWith("/transmisiones-manuales.js")) return new Response("window.TRANSMISIONES_MANUALES = [];", { status: 200 });
      return new Response("not found", { status: 404 });
    },
  });

  const invalid = await fetchCatalog({ detalles: {} });
  assert.equal(invalid.games.length, 0);
  assert.equal(invalid.catalogCount, 0);
  assert.equal(invalid.error, "source unavailable or invalid");

  const empty = await fetchCatalog({ partidos: [], detalles: {} });
  assert.deepEqual(empty, { games: [], catalogCount: 0, error: "" });
});
