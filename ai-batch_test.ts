/**
 * Cache-meting, systeemdelen, auto-caching en batch (0.34.0). Geen echte calls: `fetch` is nep.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  AiBatchGeweigerd,
  type AiBeleid,
  aiVerbruikWachtrij,
  BATCH_BELEIDSNAAM,
  BATCH_URL,
  batchToegestaan,
  batchWisWachtrij,
  bouwAnthropicBody,
  cacheTokens,
  callAi,
  callAiBatch,
  indienBatch,
  meldAiVerbruik,
  ophalenBatch,
  ruimBatchesOp,
  schatUsd,
  stelAiBeleidIn,
  wisAiVerbruik,
  wisBatch,
  wisBatchWachtrijLeeg,
  wisOpenBatches,
  wisTegoedCache,
} from "./ai.ts";
import { AI_BELEID } from "./ai-beleid.ts";

const VARS = [
  "GEMINI_API_KEY",
  "LOVABLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BATCH_API_KEY",
  "ANDERE_BATCH_SLEUTEL",
  "META_MODEL_API_KEY",
  "HOLIE_AI_PROJECT",
  "HOLIE_AI_BELEID_URL",
  "HOLIE_AI_VERBRUIK_URL",
];
const NEP = "https://verbruik.test/verbruik";
const SYNC = "https://api.anthropic.com/v1/messages";
const RESULTATEN =
  "https://api.anthropic.com/v1/messages/batches/msgbatch_1/results";
const ID = `${BATCH_URL}/msgbatch_1`;
const vraag = [{ role: "user", content: "hoi" }];

type Oproep = {
  url: string;
  method: string;
  body?: string;
  key?: string;
  signal?: AbortSignal | null;
};
type Handler = (o: Oproep) => Response | Promise<Response>;

function bericht(
  tekst: string,
  extra: Record<string, unknown> = {},
  usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5 },
) {
  return {
    id: "msg_1",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: tekst }],
    stop_reason: "end_turn",
    usage,
    ...extra,
  };
}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status });
const lijnen = (xs: unknown[]) =>
  new Response(xs.map((x) => JSON.stringify(x)).join("\n"));

function test(
  naam: string,
  fn: (c: {
    oproepen: Oproep[];
    zet: (h: Handler) => void;
    log: string[];
  }) => Promise<void>,
) {
  Deno.test(naam, async () => {
    const bewaard = VARS.map((v) => [v, Deno.env.get(v)] as const);
    for (const v of VARS) Deno.env.delete(v);
    Deno.env.set("HOLIE_AI_BELEID_URL", "uit");
    wisTegoedCache();
    wisAiVerbruik();
    wisBatchWachtrijLeeg();
    stelAiBeleidIn({});
    const echt = globalThis.fetch;
    const warn = console.warn;
    const log: string[] = [];
    console.warn = (...a: unknown[]) => log.push(a.join(" "));
    const oproepen: Oproep[] = [];
    let handler: Handler = () => new Response("{}", { status: 500 });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      const o: Oproep = {
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body as string | undefined,
        key: h["x-api-key"],
        signal: init?.signal,
      };
      oproepen.push(o);
      return await handler(o);
    }) as typeof fetch;
    try {
      await fn({ oproepen, zet: (h) => (handler = h), log });
    } finally {
      console.warn = warn;
      wisAiVerbruik();
      wisBatchWachtrijLeeg();
      globalThis.fetch = echt;
      stelAiBeleidIn({});
      wisTegoedCache();
      for (const [v, w] of bewaard) {
        if (w === undefined) Deno.env.delete(v);
        else Deno.env.set(v, w);
      }
    }
  });
}

/** Een beleid met extra toelatingen (bv. batch voor persoon). */
function metToelatingen(extra: AiBeleid["toelatingen"]): AiBeleid {
  const b = structuredClone(AI_BELEID) as AiBeleid;
  b.toelatingen.push(...extra);
  return b;
}
const batchRegel = (
  gegevens: "publiek" | "prive-peter" | "persoon" | "gezondheid",
  status: "onderbouwd" | "uitgesloten",
  project?: string,
) =>
  ({
    provider: BATCH_BELEIDSNAAM,
    gegevens,
    status,
    ...(project ? { project } : {}),
    reden: "test",
    wie: "test",
    datum: "2026-11-11",
  }) as AiBeleid["toelatingen"][number];

const SLEUTELS = { anthropic: "sleutel-gewoon" };
const basis = (project: string, extra: Record<string, unknown> = {}) => ({
  label: "t",
  project,
  sleutels: SLEUTELS,
  volgorde: ["anthropic" as const],
  pollMs: 0,
  ...extra,
});

/** Een nep-API: batch indienen, status, resultaten, annuleren, wissen, en gewone aanroepen. */
function nepApi(
  uit: {
    status?: string[];
    resultaten?: (ids: string[]) => unknown[];
    wis?: number;
    sync?: () => Response;
  } = {},
): Handler {
  let ids: string[] = [];
  const stat = [...(uit.status ?? ["ended"])];
  return (o) => {
    if (o.url === BATCH_URL && o.method === "POST") {
      ids = JSON.parse(o.body!).requests.map((r: { custom_id: string }) =>
        r.custom_id
      );
      return json({ id: "msgbatch_1" });
    }
    if (o.url === ID && o.method === "GET") {
      const s = stat.length > 1 ? stat.shift()! : stat[0];
      return json({
        id: "msgbatch_1",
        processing_status: s,
        ...(s === "ended" ? { results_url: RESULTATEN } : {}),
      });
    }
    if (o.url === RESULTATEN) {
      return lijnen(
        (uit.resultaten ?? ((x) =>
          x.map((id) => ({
            custom_id: id,
            result: { type: "succeeded", message: bericht(`batch ${id}`) },
          }))))(ids),
      );
    }
    if (o.url === `${ID}/cancel`) {
      return json({ id: "msgbatch_1", processing_status: "canceling" });
    }
    if (o.url === ID && o.method === "DELETE") {
      return uit.wis ? new Response("nee", { status: uit.wis }) : json({
        id: "msgbatch_1",
        type: "message_batch_deleted",
      });
    }
    if (o.url === SYNC) return uit.sync?.() ?? json(bericht("sync"));
    return new Response("{}", { status: 500 });
  };
}

const batchOproepen = (os: Oproep[]) =>
  os.filter((o) => o.url.startsWith(BATCH_URL));
const acties = (os: Oproep[]) =>
  batchOproepen(os).map((o) =>
    `${o.method} ${
      o.url.replace(BATCH_URL, "").replace("/results", "/results")
    }`
  );

// --- bouwAnthropicBody -----------------------------------------------------

Deno.test("systemVast krijgt het breakpoint, systemVariabel en berichten-system erachter", () => {
  const body = bouwAnthropicBody({
    model: "claude-haiku-5-5",
    messages: [
      { role: "system", content: "uit-berichten" },
      { role: "user", content: "x" },
    ],
    systemVast: "VAST",
    systemVariabel: "VAR",
  }) as { system: { text: string; cache_control?: unknown }[] };
  assertEquals(body.system.length, 2);
  assertEquals(body.system[0].text, "VAST");
  assertEquals(body.system[0].cache_control, { type: "ephemeral" });
  assertEquals(body.system[1].text, "uit-berichten\n\nVAR");
  assertEquals(body.system[1].cache_control, undefined);
});

Deno.test("zonder systemVast blijft het oude gedrag: alles uit berichten is vast", () => {
  const body = bouwAnthropicBody({
    model: "claude-haiku-5-5",
    messages: [
      { role: "system", content: "een" },
      { role: "system", content: "twee" },
      { role: "user", content: "x" },
    ],
    responseFormat: { type: "json_object" },
  }) as { system: { text: string; cache_control?: unknown }[] };
  assertEquals(body.system.length, 1);
  assertStringIncludes(
    body.system[0].text,
    "een\n\ntwee\n\nAntwoord uitsluitend",
  );
  assertEquals(body.system[0].cache_control, { type: "ephemeral" });
});

Deno.test("systemVariabel alleen: variabel blok zonder breakpoint, geen vast blok", () => {
  const body = bouwAnthropicBody({
    model: "claude-haiku-5-5",
    messages: vraag,
    systemVariabel: "VAR",
  }) as { system: { text: string; cache_control?: unknown }[] };
  assertEquals(body.system as unknown, [{ type: "text", text: "VAR" }]);
});

Deno.test("cacheTtl false: system als gewone tekst, geen cache_control, ook niet auto", () => {
  const body = bouwAnthropicBody({
    model: "claude-haiku-5-5",
    messages: vraag,
    systemVast: "A",
    systemVariabel: "B",
    cacheTtl: false,
    cacheModus: "auto",
  });
  assertEquals(body.system, "A\n\nB");
  assertEquals("cache_control" in body, false);
});

Deno.test("cacheModus auto zet een top-level cache_control met dezelfde TTL", () => {
  const b1 = bouwAnthropicBody({
    model: "claude-haiku-5-5",
    messages: vraag,
    systemVast: "A",
    cacheModus: "auto",
  });
  assertEquals(b1.cache_control, { type: "ephemeral" });
  const b2 = bouwAnthropicBody({
    model: "claude-haiku-5-5",
    messages: vraag,
    systemVast: "A",
    cacheModus: "auto",
    cacheTtl: "1h",
  }) as { cache_control: unknown; system: { cache_control: unknown }[] };
  assertEquals(b2.cache_control, { type: "ephemeral", ttl: "1h" });
  assertEquals(b2.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
  // standaard geen auto
  assertEquals(
    "cache_control" in bouwAnthropicBody({ model: "m", messages: vraag }),
    false,
  );
});

test("callAi: andere providers krijgen systemVast en systemVariabel als één system-bericht vooraan", async ({ oproepen, zet }) => {
  zet(() =>
    json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })
  );
  await callAi(vraag, {
    label: "t",
    sleutels: { deepseek: "d" },
    volgorde: ["deepseek"],
    systemVast: "VAST",
    systemVariabel: "VAR",
  });
  const body = JSON.parse(oproepen[0].body!);
  assertEquals(body.messages[0], { role: "system", content: "VAST\n\nVAR" });
  assertEquals(body.messages.length, 2);
});

// --- meting ----------------------------------------------------------------

Deno.test("cacheTokens splitst 5 minuten en 1 uur", () => {
  assertEquals(
    cacheTokens({
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_1h_input_tokens: 200 },
    }),
    { lees: 100, schrijf5m: 100, schrijf1u: 200 },
  );
  assertEquals(cacheTokens(undefined), { lees: 0, schrijf5m: 0, schrijf1u: 0 });
  assertEquals(
    cacheTokens({ cache_creation_input_tokens: 50 }),
    { lees: 0, schrijf5m: 50, schrijf1u: 0 },
  );
});

Deno.test("schatUsd: Sonnet 5.5 leest voor 0,05x, Haiku voor 0,1x, batch halveert alles", () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
  };
  const son = schatUsd("claude-sonnet-5-5", usage);
  // 2 (input) + 10 (output) + 0,10 (lees 0,05x) + 4 (1u-schrijf 2x)
  assert(Math.abs(son.usd - 16.1) < 1e-9, String(son.usd));
  assertEquals(son.cacheLees, 1_000_000);
  assertEquals(son.cacheSchrijf1u, 1_000_000);
  assertEquals(son.cacheSchrijf5m, 0);
  const hai = schatUsd("claude-haiku-5-5", usage);
  // 0,10 + 0,50 + 0,01 (lees 0,1x) + 0,20
  assert(Math.abs(hai.usd - 0.81) < 1e-9, String(hai.usd));
  const bat = schatUsd("claude-sonnet-5-5", usage, { batch: true });
  assert(Math.abs(bat.usd - 8.05) < 1e-9, String(bat.usd));
  const opus = schatUsd("claude-opus-5-5", {
    cache_read_input_tokens: 1_000_000,
  });
  assert(Math.abs(opus.usd - 0.2) < 1e-9, String(opus.usd));
  // zonder cacheverkeer geen extra velden
  assertEquals(
    "cacheLees" in schatUsd("claude-haiku-5-5", { input_tokens: 5 }),
    false,
  );
});

test("callAi meldt de cache-tokens aan de teller", async ({ zet }) => {
  stelAiBeleidIn({
    project: "podcast",
    momentopname: AI_BELEID,
    verbruik: NEP,
  });
  zet(() =>
    json(bericht("ok", {}, {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 600,
      cache_creation: { ephemeral_1h_input_tokens: 100 },
    }))
  );
  await callAi(vraag, {
    label: "t",
    sleutels: SLEUTELS,
    volgorde: ["anthropic"],
    gegevens: "publiek",
  });
  const [r] = aiVerbruikWachtrij();
  assertEquals(r.cache_lees, 400);
  assertEquals(r.cache_schrijf_5m, 500);
  assertEquals(r.cache_schrijf_1u, 100);
  assertEquals(r.batch_aanroepen, undefined);
});

test("zonder cacheverkeer geen extra velden op de regel", async ({ zet }) => {
  stelAiBeleidIn({
    project: "podcast",
    momentopname: AI_BELEID,
    verbruik: NEP,
  });
  zet(() => json(bericht("ok")));
  await callAi(vraag, {
    label: "t",
    sleutels: SLEUTELS,
    volgorde: ["anthropic"],
  });
  const [r] = aiVerbruikWachtrij();
  assertEquals(Object.keys(r).filter((k) => k.startsWith("cache_")), []);
});

// --- beleidspoort ----------------------------------------------------------

test("poort: prive-peter mag met DELETE-plicht, publiek zonder plicht", async () => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  const a = await batchToegestaan(basis("vacatures"));
  assertEquals([a.toegestaan, a.gegevens, a.wisPlicht], [
    true,
    "prive-peter",
    true,
  ]);
  const b = await batchToegestaan(basis("podcast"));
  assertEquals([b.toegestaan, b.gegevens, b.wisPlicht], [
    true,
    "publiek",
    false,
  ]);
});

test("poort: persoon en gezondheid standaard geweigerd", async () => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  const p = await batchToegestaan(basis("billara"));
  assertEquals([p.toegestaan, p.gegevens], [false, "persoon"]);
  assertStringIncludes(p.reden, "standaard niet");
  const g = await batchToegestaan(basis("foodie"));
  assertEquals([g.toegestaan, g.gegevens], [false, "gezondheid"]);
  // ook een expliciet label op een projectloos beleid
  const x = await batchToegestaan(basis("vacatures", { gegevens: "persoon" }));
  assertEquals(x.toegestaan, false);
});

test("poort: één beleidsregel geeft persoon vrij, ook enkel per project", async () => {
  stelAiBeleidIn({
    momentopname: metToelatingen([batchRegel("persoon", "onderbouwd")]),
  });
  assertEquals((await batchToegestaan(basis("billara"))).toegestaan, true);
  assertEquals((await batchToegestaan(basis("billara"))).wisPlicht, true);
  stelAiBeleidIn({
    momentopname: metToelatingen([
      batchRegel("persoon", "onderbouwd", "billara"),
    ]),
  });
  assertEquals((await batchToegestaan(basis("billara"))).toegestaan, true);
  assertEquals((await batchToegestaan(basis("phyllox"))).toegestaan, false);
});

test("poort: een beleidsregel kan batch ook afsluiten voor prive-peter", async () => {
  stelAiBeleidIn({
    momentopname: metToelatingen([batchRegel("prive-peter", "uitgesloten")]),
  });
  const p = await batchToegestaan(basis("vacatures"));
  assertEquals(p.toegestaan, false);
  assertStringIncludes(p.reden, "sluit batch uit");
});

test("poort: het gewone beleid voor Anthropic blijft gelden", async () => {
  const b = structuredClone(AI_BELEID) as AiBeleid;
  b.toelatingen = b.toelatingen.map((t) =>
    t.provider === "anthropic" && t.gegevens === "prive-peter"
      ? { ...t, status: "uitgesloten" as const }
      : t
  );
  stelAiBeleidIn({ momentopname: b });
  const p = await batchToegestaan(basis("vacatures"));
  assertEquals(p.toegestaan, false);
  assertStringIncludes(p.reden, "Anthropic");
});

test("poort: zonder project enkel met expliciete gegevens; zonder sleutel geweigerd", async () => {
  const geen = await batchToegestaan({ label: "t", sleutels: SLEUTELS });
  assertEquals(geen.toegestaan, false);
  const ok = await batchToegestaan({
    label: "t",
    sleutels: SLEUTELS,
    gegevens: "prive-peter",
  });
  assertEquals([ok.toegestaan, ok.wisPlicht], [true, true]);
  const persoon = await batchToegestaan({
    label: "t",
    sleutels: SLEUTELS,
    gegevens: "persoon",
  });
  assertEquals(persoon.toegestaan, false);
  const zonder = await batchToegestaan({ label: "t", gegevens: "publiek" });
  assertEquals(zonder.toegestaan, false);
  assertStringIncludes(zonder.reden, "sleutel");
});

test("indienBatch gooit AiBatchGeweigerd en dient niets in", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi());
  await assertRejects(
    () => indienBatch([{ id: "a", messages: vraag }], basis("billara")),
    AiBatchGeweigerd,
  );
  assertEquals(oproepen.length, 0);
});

// --- callAiBatch -----------------------------------------------------------

test("geweigerd: elk verzoek gaat door callAi, er is geen enkele batch-oproep", async ({ oproepen, zet, log }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi());
  const r = await callAiBatch(
    [{ id: "a", messages: vraag }, { id: "b", messages: vraag }],
    basis("billara"),
  );
  assertEquals(batchOproepen(oproepen).length, 0);
  assertEquals(r.map((x) => [x.id, x.bron, x.antwoord?.content]), [
    ["a", "terugval", "sync"],
    ["b", "terugval", "sync"],
  ]);
  assertStringIncludes(r[0].reden!, "batch geweigerd");
  assert(log.some((l) => l.includes("alles via callAi")));
});

test("geslaagd: koppeling op custom_id ondanks andere volgorde, DELETE na ended", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi({
    status: ["in_progress", "in_progress", "ended"],
    resultaten: (ids) =>
      [...ids].reverse().map((id) => ({
        custom_id: id,
        result: { type: "succeeded", message: bericht(`antwoord-${id}`) },
      })),
  }));
  const r = await callAiBatch(
    [
      { id: "een", messages: vraag },
      { id: "twee", messages: vraag },
      { id: "drie", messages: vraag },
    ],
    basis("vacatures"),
  );
  assertEquals(r.map((x) => [x.id, x.bron, x.antwoord?.content]), [
    ["een", "batch", "antwoord-een"],
    ["twee", "batch", "antwoord-twee"],
    ["drie", "batch", "antwoord-drie"],
  ]);
  assertEquals(r[0].antwoord?.provider, "anthropic");
  assertEquals(r[0].antwoord?.gegevens, "prive-peter");
  assertEquals(acties(oproepen), [
    "POST ",
    "GET /msgbatch_1",
    "GET /msgbatch_1",
    "GET /msgbatch_1",
    "GET /msgbatch_1/results",
    "GET /msgbatch_1", // wisBatch controleert ended
    "DELETE /msgbatch_1",
  ]);
  assertEquals(batchWisWachtrij(), []);
});

test("het indienen: custom_id, params met 1h-cache, nooit stream of speed", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi());
  await callAiBatch(
    [
      { id: "a-1", messages: vraag },
      { id: "b_2", messages: vraag, systemVariabel: "ander" },
    ],
    basis("podcast", { systemVast: "VAST", maxTokens: 100 }),
  );
  const post = oproepen.find((o) =>
    o.url === BATCH_URL && o.method === "POST"
  )!;
  const body = JSON.parse(post.body!);
  assertEquals(body.requests.map((r: { custom_id: string }) => r.custom_id), [
    "a-1",
    "b_2",
  ]);
  const p0 = body.requests[0].params;
  assertEquals(p0.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assertEquals(p0.system[0].text, "VAST");
  assertEquals(body.requests[1].params.system[1].text, "ander");
  for (const r of body.requests) {
    assertEquals("stream" in r.params, false);
    assertEquals("speed" in r.params, false);
    assertEquals("fallbacks" in r.params, false);
    assert(r.params.max_tokens >= 1);
  }
  assertEquals(post.key, "sleutel-gewoon");
});

test("terugval per verzoek: errored, expired, canceled, ontbrekend, refusal, afgekapt, afgekeurd", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi({
    resultaten: () => [
      {
        custom_id: "ok",
        result: { type: "succeeded", message: bericht("goed") },
      },
      {
        custom_id: "fout",
        result: {
          type: "errored",
          error: { type: "error", error: { type: "api_error" } },
        },
      },
      { custom_id: "oud", result: { type: "expired" } },
      { custom_id: "weg", result: { type: "canceled" } },
      {
        custom_id: "nee",
        result: {
          type: "succeeded",
          message: { ...bericht(""), content: [], stop_reason: "refusal" },
        },
      },
      {
        custom_id: "lang",
        result: {
          type: "succeeded",
          message: bericht("half", { stop_reason: "max_tokens" }),
        },
      },
      {
        custom_id: "afgekeurd",
        result: { type: "succeeded", message: bericht("SLECHT") },
      },
      // "mist" staat niet in de resultaten
    ],
  }));
  const ids = ["ok", "fout", "oud", "weg", "nee", "lang", "afgekeurd", "mist"];
  const r = await callAiBatch(
    ids.map((id) => ({ id, messages: vraag })),
    basis("podcast", { aanvaard: (c: string) => c !== "SLECHT" }),
  );
  assertEquals(r.map((x) => [x.id, x.bron]), [
    ["ok", "batch"],
    ["fout", "terugval"],
    ["oud", "terugval"],
    ["weg", "terugval"],
    ["nee", "terugval"],
    ["lang", "terugval"],
    ["afgekeurd", "terugval"],
    ["mist", "terugval"],
  ]);
  assertStringIncludes(r[1].reden!, "errored");
  assertStringIncludes(r[2].reden!, "expired");
  assertStringIncludes(r[3].reden!, "canceled");
  assertStringIncludes(r[4].reden!, "lege inhoud");
  assertStringIncludes(r[5].reden!, "afgekapt");
  assertStringIncludes(r[6].reden!, "afgekeurd");
  assertStringIncludes(r[7].reden!, "geen resultaat");
  assertEquals(r[1].antwoord?.content, "sync");
  // zeven synchrone aanroepen, geen enkele voor het geslaagde verzoek
  assertEquals(oproepen.filter((o) => o.url === SYNC).length, 7);
});

test("terugval die ook faalt: fout per verzoek, de rest blijft heel", async ({ zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi({
    resultaten: () => [
      { custom_id: "a", result: { type: "expired" } },
      { custom_id: "b", result: { type: "succeeded", message: bericht("b") } },
    ],
    sync: () => new Response("kapot", { status: 400 }),
  }));
  const r = await callAiBatch(
    [{ id: "a", messages: vraag }, { id: "b", messages: vraag }],
    basis("podcast"),
  );
  assertEquals(r[0].antwoord, undefined);
  assert(r[0].fout);
  assertEquals(r[1].antwoord?.content, "b");
});

test("tool_use in een batch komt als toolCalls terug", async ({ zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi({
    resultaten: () => [{
      custom_id: "a",
      result: {
        type: "succeeded",
        message: {
          ...bericht(""),
          content: [{
            type: "tool_use",
            id: "t1",
            name: "doe",
            input: { x: 1 },
          }],
          stop_reason: "tool_use",
        },
      },
    }],
  }));
  const r = await callAiBatch(
    [{ id: "a", messages: vraag }],
    basis("podcast", {
      tools: [{ type: "function", function: { name: "doe", parameters: {} } }],
    }),
  );
  assertEquals(r[0].bron, "batch");
  assertEquals(r[0].antwoord?.toolCall.function.name, "doe");
  assertEquals(r[0].antwoord?.type, "tools");
});

test("indienen faalt: alles via callAi", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet((o) =>
    o.url === BATCH_URL
      ? new Response("stuk", { status: 500 })
      : json(bericht("sync"))
  );
  const r = await callAiBatch([{ id: "a", messages: vraag }], basis("podcast"));
  assertEquals(r[0].bron, "terugval");
  assertStringIncludes(r[0].reden!, "indienen faalde");
  assertEquals(oproepen.filter((o) => o.url === SYNC).length, 1);
});

test("ongeldige invoer gooit een RangeError en roept niets aan", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi());
  await assertRejects(
    () => callAiBatch([{ id: "a b", messages: vraag }], basis("podcast")),
    RangeError,
  );
  await assertRejects(
    () =>
      callAiBatch(
        [{ id: "a", messages: vraag }, { id: "a", messages: vraag }],
        basis("podcast"),
      ),
    RangeError,
  );
  await assertRejects(
    () =>
      callAiBatch([{ id: "x".repeat(65), messages: vraag }], basis("podcast")),
    RangeError,
  );
  assertEquals(oproepen.length, 0);
});

// --- DELETE-plicht ---------------------------------------------------------

test("DELETE mislukt: gelogd, in de wiswachtrij, volgende run probeert opnieuw", async ({ oproepen, zet, log }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi({ wis: 500 }));
  const r = await callAiBatch(
    [{ id: "a", messages: vraag }],
    basis("vacatures"),
  );
  assertEquals(r[0].bron, "batch"); // het resultaat is er toch
  assertEquals(batchWisWachtrij(), ["msgbatch_1"]);
  assert(log.some((l) => l.includes("NIET gewist")));
  assert(!log.some((l) => l.includes("sleutel-gewoon")), "sleutel in de log");
  // volgende run: de DELETE lukt nu, eerst opruimen en dan pas de nieuwe batch
  oproepen.length = 0;
  zet(nepApi());
  await callAiBatch([{ id: "b", messages: vraag }], basis("vacatures"));
  assertEquals(acties(oproepen)[0], "GET /msgbatch_1");
  assertEquals(acties(oproepen)[1], "DELETE /msgbatch_1");
  assertEquals(batchWisWachtrij(), []);
});

test("wisOpenBatches gebruikt de sleutel van toen", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi({ wis: 500 }));
  await callAiBatch([{ id: "a", messages: vraag }], basis("vacatures"));
  oproepen.length = 0;
  zet(nepApi());
  const uit = await wisOpenBatches({
    label: "t",
    sleutels: { anthropic: "andere" },
  });
  assertEquals(uit, { gewist: 1, mislukt: 0 });
  assert(batchOproepen(oproepen).every((o) => o.key === "sleutel-gewoon"));
});

test("DELETE enkel na ended: een lopende batch wordt eerst geannuleerd en afgewacht", async ({ oproepen, zet }) => {
  zet(nepApi({ status: ["in_progress", "canceling", "canceling", "ended"] }));
  const uit = await wisBatch("msgbatch_1", {
    label: "t",
    sleutels: SLEUTELS,
    pollMs: 1,
  });
  assertEquals(uit, "gewist");
  assertEquals(acties(oproepen), [
    "GET /msgbatch_1",
    "POST /msgbatch_1/cancel",
    "GET /msgbatch_1",
    "GET /msgbatch_1",
    "GET /msgbatch_1",
    "DELETE /msgbatch_1",
  ]);
});

test("wisBatch: nooit DELETE zolang de batch niet ended is", async ({ oproepen, zet }) => {
  zet(nepApi({ status: ["canceling"] }));
  const uit = await wisBatch("msgbatch_1", {
    label: "t",
    sleutels: SLEUTELS,
    pollMs: 1,
  }, 20);
  assertEquals(uit, "mislukt");
  assert(!oproepen.some((o) => o.method === "DELETE"));
  assertEquals(batchWisWachtrij(), ["msgbatch_1"]);
});

test("wisBatch: een 404 telt als gewist", async ({ zet }) => {
  zet((o) => o.url === ID ? new Response("weg", { status: 404 }) : json({}));
  assertEquals(
    await wisBatch("msgbatch_1", { label: "t", sleutels: SLEUTELS }),
    "gewist",
  );
  assertEquals(batchWisWachtrij(), []);
});

test("bijResultaten gooit: geen DELETE, batch blijft staan", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi());
  const r = await callAiBatch(
    [{ id: "a", messages: vraag }],
    basis("vacatures", {
      bijResultaten: () => {
        throw new Error("schrijven mislukt");
      },
    }),
  );
  assertEquals(r[0].bron, "batch");
  assert(!oproepen.some((o) => o.method === "DELETE"));
});

test("bijResultaten loopt vóór de DELETE; wis:false wist niet", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi());
  let nogGeenDelete = false;
  await callAiBatch(
    [{ id: "a", messages: vraag }],
    basis("vacatures", {
      bijResultaten: () => {
        nogGeenDelete = !oproepen.some((o) => o.method === "DELETE");
      },
    }),
  );
  assert(nogGeenDelete);
  assert(oproepen.some((o) => o.method === "DELETE"));
  oproepen.length = 0;
  // publiek (geen DELETE-plicht): wis:false mag, en wist niet
  await callAiBatch(
    [{ id: "a", messages: vraag }],
    basis("podcast", { wis: false }),
  );
  assert(!oproepen.some((o) => o.method === "DELETE"));
});

test("wis:false in callAiBatch wordt geweigerd bij een DELETE-plicht, zonder oproepen", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi());
  await assertRejects(
    () =>
      callAiBatch(
        [{ id: "a", messages: vraag }],
        basis("vacatures", { wis: false }),
      ),
    RangeError,
    "DELETE-plicht",
  );
  assertEquals(oproepen.length, 0);
  // in de twee-fase-API blijft het kunnen
  const o = basis("vacatures", { wis: false });
  const v = [{ id: "a", messages: vraag }];
  const h = await indienBatch(v, o);
  const r = await ophalenBatch(h, v, o);
  assert(r.klaar && r.wissen === "overgeslagen");
});

test("bijResultaten gooit bij DELETE-plicht: batch in de wiswachtrij en op de teller", async ({ oproepen, zet }) => {
  stelAiBeleidIn({
    momentopname: AI_BELEID,
    project: "vacatures",
    verbruik: NEP,
  });
  zet(nepApi());
  const r = await callAiBatch(
    [{ id: "a", messages: vraag }],
    basis("vacatures", {
      bijResultaten: () => {
        throw new Error("schrijven mislukt");
      },
    }),
  );
  assertEquals(r[0].bron, "batch");
  assert(!oproepen.some((o) => o.method === "DELETE"));
  assertEquals(batchWisWachtrij(), ["msgbatch_1"]);
  assertEquals(aiVerbruikWachtrij()[0].batch_wis_mislukt, 1);
  // volgende run wist hem alsnog
  oproepen.length = 0;
  zet(nepApi());
  await callAiBatch([{ id: "b", messages: vraag }], basis("vacatures"));
  assert(oproepen.some((o) => o.method === "DELETE"));
  assertEquals(batchWisWachtrij(), []);
});

// --- onderbreking, abort, time-outs ---------------------------------------

/** Een nep-API waarvan de statusvraag volgens een script faalt (`fout`) of een status geeft. */
function metStatusScript(
  script: ("503" | "net" | "in_progress" | "ended" | "canceling")[],
  uit: Parameters<typeof nepApi>[0] = {},
  bijGet?: () => void,
): Handler {
  const echt = nepApi({ ...uit, status: ["ended"] });
  const stappen = [...script];
  return (o) => {
    if (o.url === ID && o.method === "GET") {
      bijGet?.();
      const st = stappen.length > 1 ? stappen.shift()! : stappen[0];
      if (st === "503") return new Response("stuk", { status: 503 });
      if (st === "net") throw new TypeError("netwerk");
      if (st === "in_progress" || st === "canceling") {
        return json({ id: "msgbatch_1", processing_status: st });
      }
    }
    return echt(o);
  };
}

test("een voorbijgaande pollfout wordt herkanst: de batch loopt door, geen terugval", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(metStatusScript(["in_progress", "503", "net", "429" as "503", "ended"]));
  const r = await callAiBatch(
    [{ id: "a", messages: vraag }],
    basis("vacatures"),
  );
  assertEquals(r[0].bron, "batch");
  assertEquals(oproepen.filter((o) => o.url === SYNC).length, 0);
  assert(!oproepen.some((o) => o.url.endsWith("/cancel")));
});

test("pollfouten blijven aanhouden: annuleren, tot ended wachten, gelukte verzoeken houden", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  let gets = 0;
  zet(metStatusScript(
    ["503", "503", "503", "ended"],
    {
      resultaten: () => [
        {
          custom_id: "a",
          result: { type: "succeeded", message: bericht("a") },
        },
        { custom_id: "b", result: { type: "canceled" } },
      ],
    },
    () => gets++,
  ));
  const r = await callAiBatch(
    [{ id: "a", messages: vraag }, { id: "b", messages: vraag }],
    basis("vacatures", { maxPollFouten: 2 }),
  );
  assertEquals(r.map((x) => [x.id, x.bron]), [["a", "batch"], [
    "b",
    "terugval",
  ]]);
  assertEquals(r[0].antwoord?.content, "a");
  assert(oproepen.some((o) => o.url.endsWith("/cancel")));
  assertEquals(oproepen.filter((o) => o.url === SYNC).length, 1);
  assert(oproepen.some((o) => o.method === "DELETE"));
});

test("maxWachtMs overschreden: annuleren, wachten op ended, daarna ophalen; enkel canceled naar terugval", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(metStatusScript(
    ["in_progress", "canceling", "canceling", "ended"],
    {
      resultaten: () => [
        {
          custom_id: "a",
          result: { type: "succeeded", message: bericht("a") },
        },
        { custom_id: "b", result: { type: "canceled" } },
        { custom_id: "c", result: { type: "expired" } },
      ],
    },
  ));
  const r = await callAiBatch(
    ["a", "b", "c"].map((id) => ({ id, messages: vraag })),
    basis("vacatures", { maxWachtMs: 0 }),
  );
  assertEquals(r.map((x) => x.bron), ["batch", "terugval", "terugval"]);
  assertEquals(r[0].antwoord?.content, "a");
  assertEquals(oproepen.filter((o) => o.url === SYNC).length, 2);
  assertEquals(
    oproepen.filter((o) => o.url.endsWith("/cancel")).length,
    1,
  );
  assert(oproepen.some((o) => o.method === "DELETE"));
});

test("niet op ended te krijgen na annuleren: wiswachtrij, teller en terugval", async ({ oproepen, zet }) => {
  stelAiBeleidIn({
    momentopname: AI_BELEID,
    project: "vacatures",
    verbruik: NEP,
  });
  zet(metStatusScript(["canceling"]));
  const r = await callAiBatch(
    [{ id: "a", messages: vraag }],
    basis("vacatures", { maxWachtMs: 0, annuleerWachtMs: 5 }),
  );
  assertEquals(r[0].bron, "terugval");
  assertEquals(batchWisWachtrij(), ["msgbatch_1"]);
  assert(!oproepen.some((o) => o.method === "DELETE"));
  assertEquals(
    aiVerbruikWachtrij().find((x) => x.batch_wis_mislukt)?.batch_wis_mislukt,
    1,
  );
});

test("abort: de batch wordt geannuleerd, gelukte verzoeken blijven, de rest krijgt een fout zonder callAi", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  const ac = new AbortController();
  zet(metStatusScript(
    ["in_progress", "ended"],
    {
      resultaten: () => [
        {
          custom_id: "a",
          result: { type: "succeeded", message: bericht("a") },
        },
        { custom_id: "b", result: { type: "canceled" } },
      ],
    },
    () => ac.abort(),
  ));
  const r = await callAiBatch(
    [{ id: "a", messages: vraag }, { id: "b", messages: vraag }],
    basis("vacatures", { signal: ac.signal }),
  );
  assertEquals(r[0].antwoord?.content, "a");
  assertEquals(r[1].antwoord, undefined);
  assert(r[1].fout);
  assert(oproepen.some((o) => o.url.endsWith("/cancel")));
  assertEquals(oproepen.filter((o) => o.url === SYNC).length, 0);
  // de opruiming liep zonder het afgebroken signal
  const na = oproepen.filter((o) => o.url.endsWith("/cancel"))[0];
  assert(!na.signal?.aborted);
});

test("timeoutMs (voor callAi) bepaalt de batch-time-outs niet; batchTimeoutMs wel", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  const api = nepApi();
  zet(async (o) => {
    if (o.url.startsWith(BATCH_URL)) {
      await new Promise((r) => setTimeout(r, 30));
      if (o.signal?.aborted) throw new DOMException("t", "TimeoutError");
    }
    return api(o);
  });
  const r = await callAiBatch(
    [{ id: "a", messages: vraag }],
    basis("podcast", { timeoutMs: 5 }),
  );
  assertEquals(r[0].bron, "batch");
  assertEquals(oproepen.filter((o) => o.url === SYNC).length, 0);
  // een eigen, korte batch-time-out telt wel
  oproepen.length = 0;
  const r2 = await callAiBatch(
    [{ id: "a", messages: vraag }],
    basis("podcast", { batchTimeoutMs: 5 }),
  );
  assertEquals(r2[0].bron, "terugval");
});

// --- ruimBatchesOp ---------------------------------------------------------

test("ruimBatchesOp wist enkel ended batches ouder dan de grens, over meerdere pagina's", async ({ oproepen, zet }) => {
  const oud = new Date(Date.now() - 5 * 3600_000).toISOString();
  const nieuw = new Date().toISOString();
  zet((o) => {
    if (o.url.startsWith(`${BATCH_URL}?`)) {
      return o.url.includes("after_id=b3")
        ? json({
          data: [{ id: "b4", processing_status: "ended", created_at: oud }],
          has_more: false,
        })
        : json({
          data: [
            { id: "b1", processing_status: "ended", created_at: oud },
            { id: "b2", processing_status: "in_progress", created_at: oud },
            { id: "b3", processing_status: "ended", created_at: nieuw },
          ],
          has_more: true,
          last_id: "b3",
        });
    }
    if (o.method === "GET") {
      return json({ processing_status: "ended" });
    }
    return json({ type: "message_batch_deleted" });
  });
  const uit = await ruimBatchesOp({
    label: "t",
    sleutels: SLEUTELS,
    ouderDanMs: 3 * 3600_000,
  });
  assertEquals(uit, { gewist: 2, mislukt: 0, gezien: 4 });
  const wissen = oproepen.filter((o) => o.method === "DELETE").map((o) =>
    o.url.split("/").pop()
  );
  assertEquals(wissen, ["b1", "b4"]);
});

test("ruimBatchesOp zonder sleutel of bij een fout: gooit niet", async ({ zet }) => {
  assertEquals(
    await ruimBatchesOp({ label: "t", ouderDanMs: 1 }),
    { gewist: 0, mislukt: 0, gezien: 0 },
  );
  zet(() => new Response("stuk", { status: 500 }));
  assertEquals(
    await ruimBatchesOp({ label: "t", sleutels: SLEUTELS, ouderDanMs: 1 }),
    { gewist: 0, mislukt: 0, gezien: 0 },
  );
});

// --- poort: type en toestemming -------------------------------------------

test("poort: projectverboden per type tellen mee, ook met tools per verzoek", async () => {
  const b = structuredClone(AI_BELEID) as AiBeleid;
  b.projecten.podcast.verboden = [{
    provider: "anthropic",
    types: ["tools"],
    reden: "test",
    wie: "test",
    datum: "2026-11-11",
  }];
  stelAiBeleidIn({ momentopname: b });
  const tool = [{ type: "function", function: { name: "x", parameters: {} } }];
  assertEquals((await batchToegestaan(basis("podcast"))).toegestaan, true);
  assertEquals(
    (await batchToegestaan(basis("podcast"), [{ id: "a", messages: vraag }]))
      .toegestaan,
    true,
  );
  assertEquals(
    (await batchToegestaan(basis("podcast", { tools: tool }))).toegestaan,
    false,
  );
  assertEquals(
    (await batchToegestaan(basis("podcast"), [
      { id: "a", messages: vraag, tools: tool },
    ])).toegestaan,
    false,
  );
});

test("poort: toestemming_vereist op een anthropic-batch-toelating wordt gehandhaafd", async () => {
  const regel = {
    ...batchRegel("persoon", "onderbouwd"),
    toestemming_vereist: true,
  };
  stelAiBeleidIn({ momentopname: metToelatingen([regel]) });
  const zonder = await batchToegestaan(basis("billara"));
  assertEquals(zonder.toegestaan, false);
  assertStringIncludes(zonder.reden, "toestemming");
  const met = await batchToegestaan(
    basis("billara", { toestemming: [BATCH_BELEIDSNAAM] }),
  );
  assertEquals(met.toegestaan, true);
});

// --- teller: regels splitsen, body ----------------------------------------

test("teller: een regel die de grens van de Worker haalt, wordt gesplitst", async () => {
  await Promise.resolve();
  stelAiBeleidIn({
    momentopname: AI_BELEID,
    project: "podcast",
    verbruik: NEP,
  });
  for (let i = 0; i < 10_001; i++) {
    meldAiVerbruik({ provider: "anthropic", type: "tekst", batch: true });
  }
  const a = aiVerbruikWachtrij();
  assertEquals(a.length, 2);
  assertEquals(a.map((r) => r.aanroepen).sort(), [1, 10_000]);
  assertEquals(a.reduce((n, r) => n + (r.batch_aanroepen ?? 0), 0), 10_001);
  wisAiVerbruik();
  for (let i = 0; i < 3; i++) {
    meldAiVerbruik({ provider: "deepseek", type: "tekst", usd: 30 });
  }
  const b = aiVerbruikWachtrij();
  assertEquals(b.length, 3);
  assert(b.every((r) => r.usd <= 50));
});

Deno.test("tools zonder vast system maar met systemVariabel: breakpoint op de laatste tool", () => {
  const body = bouwAnthropicBody({
    model: "claude-haiku-5-5",
    messages: vraag,
    systemVariabel: "VAR",
    tools: [
      { type: "function", function: { name: "a", parameters: {} } },
      { type: "function", function: { name: "b", parameters: {} } },
    ],
  }) as { tools: { cache_control?: unknown }[]; system: unknown };
  assertEquals(body.tools[0].cache_control, undefined);
  assertEquals(body.tools[1].cache_control, { type: "ephemeral" });
  assertEquals(body.system as unknown, [{ type: "text", text: "VAR" }]);
});

test("twee fases: ophalenBatch geeft klaar:false zolang de batch loopt", async ({ zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi({ status: ["in_progress", "ended"] }));
  const opties = basis("podcast");
  const v = [{ id: "a", messages: vraag }];
  const h = await indienBatch(v, opties);
  assertEquals([h.batchId, h.gegevens, h.wisPlicht], [
    "msgbatch_1",
    "publiek",
    false,
  ]);
  assertEquals(await ophalenBatch(h, v, opties), {
    klaar: false,
    status: "in_progress",
  });
  const r = await ophalenBatch(h, v, opties);
  assert(r.klaar);
  if (r.klaar) {
    assertEquals(r.wissen, "gewist");
    assertEquals(r.resultaten[0].antwoord?.content, "batch a");
  }
});

// --- sleutel ---------------------------------------------------------------

test("aparte batchsleutel via een env-naam, met terugval op de gewone sleutel", async ({ oproepen, zet }) => {
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet(nepApi());
  Deno.env.set("ANTHROPIC_BATCH_API_KEY", "batch-sleutel");
  await callAiBatch([{ id: "a", messages: vraag }], basis("podcast"));
  assert(batchOproepen(oproepen).every((o) => o.key === "batch-sleutel"));
  oproepen.length = 0;
  Deno.env.delete("ANTHROPIC_BATCH_API_KEY");
  Deno.env.set("ANDERE_BATCH_SLEUTEL", "eigen-naam");
  await callAiBatch(
    [{ id: "a", messages: vraag }],
    basis("podcast", { batchSleutelEnv: "ANDERE_BATCH_SLEUTEL" }),
  );
  assert(batchOproepen(oproepen).every((o) => o.key === "eigen-naam"));
  oproepen.length = 0;
  Deno.env.delete("ANDERE_BATCH_SLEUTEL");
  await callAiBatch([{ id: "a", messages: vraag }], basis("podcast"));
  assert(batchOproepen(oproepen).every((o) => o.key === "sleutel-gewoon"));
});

// --- teller ----------------------------------------------------------------

test("teller: halve tarief, cache-tokens, batch_aanroepen en DELETE-stand", async ({ zet }) => {
  stelAiBeleidIn({
    momentopname: AI_BELEID,
    project: "vacatures",
    verbruik: NEP,
  });
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_input_tokens: 2_000,
    cache_creation_input_tokens: 3_000,
    cache_creation: { ephemeral_1h_input_tokens: 3_000 },
  };
  zet(nepApi({
    resultaten: (ids) =>
      ids.map((id) => ({
        custom_id: id,
        result: { type: "succeeded", message: bericht("x", {}, usage) },
      })),
  }));
  await callAiBatch(
    [{ id: "a", messages: vraag }, { id: "b", messages: vraag }],
    { ...basis("vacatures"), gegevens: "prive-peter" },
  );
  const regels = aiVerbruikWachtrij();
  assertEquals(regels.length, 1);
  const r = regels[0];
  assertEquals([r.provider, r.aanroepen, r.fouten], ["anthropic", 2, 0]);
  assertEquals(r.batch_aanroepen, 2);
  assertEquals(r.batch_gewist, 1);
  assertEquals(r.batch_wis_mislukt, undefined);
  assertEquals(r.cache_lees, 4_000);
  assertEquals(r.cache_schrijf_1u, 6_000);
  // per verzoek: (1M x 0,10 + 2.000 x 0,10 x 0,1 + 3.000 x 0,10 x 2) / 2 = 0,05 + ...
  const per = (1_000_000 * 0.1 + 2_000 * 0.1 * 0.1 + 3_000 * 0.1 * 2) / 1e6 / 2;
  assert(Math.abs(r.usd - 2 * per) < 1e-9, `${r.usd} vs ${2 * per}`);
});

test("teller: mislukte DELETE telt als batch_wis_mislukt", async ({ zet }) => {
  stelAiBeleidIn({
    momentopname: AI_BELEID,
    project: "vacatures",
    verbruik: NEP,
  });
  zet(nepApi({ wis: 500 }));
  await callAiBatch([{ id: "a", messages: vraag }], basis("vacatures"));
  const [r] = aiVerbruikWachtrij();
  assertEquals(r.batch_wis_mislukt, 1);
  assertEquals(r.batch_gewist, undefined);
});
