import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertRejects,
} from "@std/assert";
import {
  AiOnbeschikbaar,
  type AiPoging,
  AiQuotumFout,
  AUDIO_FORMATEN,
  BeeldGeweigerd,
  bouwAnthropicBody,
  bouwDeepseekBody,
  callAi,
  foutTekst,
  genereerBeeld,
  heeftBeeldInSysteem,
  leesJson,
  schatUsd,
  STANDAARD_MODELLEN,
  taalnaam,
  TARIEVEN,
  transcribeerAudio,
  VIDEO_FORMATEN,
} from "./ai.ts";

/** De omgevingsvariabelen waarop `ai.ts` terugvalt als `sleutels` een provider mist. */
const AI_VARS = [
  "GEMINI_API_KEY",
  "LOVABLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "META_MODEL_API_KEY",
];

/**
 * `Deno.test`, maar los van de machine: de AI-sleutels uit de omgeving zijn weg
 * tijdens de test en komen daarna terug, en een `fetch` die geen test vervangt,
 * faalt meteen. Zo is de uitkomst dezelfde op een laptop met echte sleutels als
 * in CI, en gaat er nooit een echte call naar een provider.
 *
 * Bewust `test` en geen Nederlandse naam: `deno fmt` houdt de kop van een test
 * enkel op één regel voor namen die het als testaanroep kent.
 */
function test(naam: string, fn: () => void | Promise<void>) {
  Deno.test(naam, async () => {
    const bewaard = AI_VARS.map((v) => [v, Deno.env.get(v)] as const);
    for (const v of AI_VARS) Deno.env.delete(v);
    const echteFetch = globalThis.fetch;
    globalThis.fetch = ((url: string) =>
      Promise.reject(
        new Error(`echte fetch in een test: ${url}`),
      )) as typeof fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = echteFetch;
      for (const [v, w] of bewaard) {
        if (w !== undefined) Deno.env.set(v, w);
      }
    }
  });
}

type Antwoord = {
  status?: number;
  content?: string;
  finish?: string;
  toolCall?: unknown;
};

const sleutels = {
  gemini: "test-gem",
  lovable: "test-lov",
  deepseek: "test-ds",
};
/** Zonder gratis sleutel: toetst dat de betalende terugval blijft werken. */
const sleutelsZonderGemini = { lovable: "test-lov", deepseek: "test-ds" };
const vraag = [{ role: "user", content: "hoi" }];

function metAntwoorden(...antwoorden: Antwoord[]) {
  const aanroepen: { url: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const origineel = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    aanroepen.push({ url, body: JSON.parse(String(init.body)) });
    const a = antwoorden[Math.min(i++, antwoorden.length - 1)];
    const message = a.toolCall
      ? { tool_calls: [a.toolCall] }
      : { content: a.content ?? "" };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message, finish_reason: a.finish ?? "stop" }],
          usage: { completion_tokens: 5 },
        }),
        { status: a.status ?? 200 },
      ),
    );
  }) as typeof fetch;
  return { aanroepen, herstel: () => (globalThis.fetch = origineel) };
}

test("probeert standaard DeepSeek, dan gratis gemini, dan Lovable", async () => {
  // Sinds 19-09-2026 staat de standaardvolgorde op goedkoop-eerst: DeepSeek is
  // spotgoedkoop en heeft geen dagplafond, gemini is gratis maar wel geplafonneerd,
  // Lovable is het betalende vangnet.
  const f = metAntwoorden({ content: "ok" });
  try {
    const r = await callAi(vraag, { label: "t", sleutels });
    assertEquals(r.provider, "deepseek");
    assert(f.aanroepen[0].url.includes("api.deepseek.com"));
  } finally {
    f.herstel();
  }
});

test("gemini staat tussen DeepSeek en Lovable in", async () => {
  const f = metAntwoorden(
    { status: 500, content: "" },
    { content: "van gemini" },
  );
  try {
    const r = await callAi(vraag, { label: "t", sleutels });
    assertEquals(r.provider, "gemini");
    assertEquals(r.model, STANDAARD_MODELLEN.gemini);
    assert(f.aanroepen[1].url.includes("generativelanguage.googleapis.com"));
  } finally {
    f.herstel();
  }
});

test("stuurt het DeepSeek-only thinking-veld nooit naar gemini", async () => {
  // ☠️ Google geeft HTTP 400 "Unknown name: thinking" en dat is een 4xx: de keten
  // herkanst niet. Zou dat veld in de gedeelde body staan, dan faalde elke
  // tekst-call op de gratis route. Gemeten 19-09-2026.
  const f = metAntwoorden(
    { status: 500, content: "" },
    { content: "ok" },
  );
  try {
    await callAi(vraag, { label: "t", sleutels });
    assert("thinking" in (f.aanroepen[0].body as Record<string, unknown>));
    assert(!("thinking" in (f.aanroepen[1].body as Record<string, unknown>)));
  } finally {
    f.herstel();
  }
});

test("herkanst niet op een 429 van de gratis route", async () => {
  // Een leeg dagquotum is morgen pas over: doorvallen, niet herkansen.
  // Alles faalt behalve de laatste provider: gemini krijgt een 429 en mag die
  // NIET herkansen, ook al staat `pogingen` op 2.
  const f = metAntwoorden(
    { status: 429, content: "" },
    { status: 429, content: "" },
    { content: "van lovable" },
  );
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels,
      pogingen: 2,
      volgorde: ["gemini", "lovable"],
    });
    assertEquals(r.provider, "lovable");
    // gemini x1: de 429 herkanst NIET, anders waren het er hier twee. Lovable
    // krijgt daarna wel zijn twee pogingen (429 is daar wel tijdelijk), dus 3.
    assertEquals(f.aanroepen.length, 3);
    assert(f.aanroepen[0].url.includes("generativelanguage.googleapis.com"));
  } finally {
    f.herstel();
  }
});

test("zet het denkwerk van DeepSeek standaard uit", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    await callAi(vraag, { label: "t", sleutels, volgorde: ["deepseek"] });
    assertEquals(f.aanroepen[0].body.thinking, { type: "disabled" });
    assertEquals(f.aanroepen[0].body.model, "deepseek-v4-flash");
  } finally {
    f.herstel();
  }
});

test("laat DeepSeek nadenken als dat gevraagd wordt", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    await callAi(vraag, {
      label: "t",
      sleutels,
      volgorde: ["deepseek"],
      deepseekDenken: true,
    });
    assertEquals(f.aanroepen[0].body.thinking, { type: "enabled" });
  } finally {
    f.herstel();
  }
});

test("valt door bij een afgekapt antwoord", async () => {
  const f = metAntwoorden({ content: '{"half', finish: "length" }, {
    content: '{"heel":1}',
  });
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels,
      volgorde: ["deepseek", "lovable"],
    });
    assertEquals(r.provider, "lovable");
    assertEquals(r.content, '{"heel":1}');
  } finally {
    f.herstel();
  }
});

test("geeft een afgekapt antwoord toch terug als er geen volgende provider is", async () => {
  const f = metAntwoorden({ content: "half", finish: "length" });
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels,
      volgorde: ["deepseek"],
    });
    assertEquals(r.content, "half");
    assertEquals(r.finishReason, "length");
  } finally {
    f.herstel();
  }
});

test("valt door bij een afgekeurd antwoord, zonder het te herhalen", async () => {
  const f = metAntwoorden({ content: "Sorry" }, { content: "Kipfilet" });
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels,
      volgorde: ["lovable", "deepseek"],
      pogingen: 2,
      aanvaard: (c) => c !== "Sorry",
    });
    assertEquals(r.provider, "deepseek");
    assertEquals(f.aanroepen.length, 2);
  } finally {
    f.herstel();
  }
});

test("herkanst bij een 5xx, niet bij een andere 4xx", async () => {
  const f = metAntwoorden({ status: 503 }, { content: "ok" });
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels,
      volgorde: ["lovable"],
      pogingen: 2,
    });
    assertEquals(r.content, "ok");
  } finally {
    f.herstel();
  }
  const g = metAntwoorden({ status: 401 });
  try {
    await assertRejects(
      () =>
        callAi(vraag, {
          label: "t",
          sleutels,
          volgorde: ["lovable"],
          pogingen: 2,
        }),
      AiOnbeschikbaar,
    );
    assertEquals(g.aanroepen.length, 1);
  } finally {
    g.herstel();
  }
});

test("stuurt tools enkel naar de gevraagde providers", async () => {
  const f = metAntwoorden({ status: 500 }, { content: "tekst" });
  const tools = [{ type: "function", function: { name: "x" } }];
  try {
    await callAi(vraag, {
      label: "t",
      sleutels,
      volgorde: ["lovable", "deepseek"],
      tools,
      toolChoice: "auto",
      toolsVoor: ["lovable"],
    });
    assertEquals(f.aanroepen[0].body.tools, tools);
    assertEquals(f.aanroepen[1].body.tools, undefined);
  } finally {
    f.herstel();
  }
});

test("geeft tool calls terug", async () => {
  const f = metAntwoorden({
    toolCall: { function: { name: "x", arguments: "{}" } },
  });
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels,
      volgorde: ["lovable", "deepseek"],
      tools: [{}],
    });
    assertEquals(r.toolCall.function.name, "x");
    assertEquals(r.toolCalls?.length, 1);
  } finally {
    f.herstel();
  }
});

test("stopt bij een Lovable-quotum als de aanroeper dat vraagt", async () => {
  const f = metAntwoorden({ status: 402 });
  try {
    const fout = await assertRejects(
      () =>
        callAi(vraag, {
          label: "t",
          sleutels,
          volgorde: ["lovable", "deepseek"],
          opQuotum: "throw",
        }),
      AiQuotumFout,
    );
    assertEquals(fout.message, "CREDITS_402");
    assertEquals(f.aanroepen.length, 1);
  } finally {
    f.herstel();
  }
});

test("roept de hooks aan, en een falende hook breekt niets", async () => {
  const f = metAntwoorden({ status: 500 }, { content: "ok" });
  const fouten: AiPoging[] = [];
  const successen: AiPoging[] = [];
  try {
    await callAi(vraag, {
      label: "t",
      sleutels,
      volgorde: ["lovable", "deepseek"],
      bijFout: (p) => {
        fouten.push(p);
        throw new Error("hook stuk");
      },
      bijSucces: (p) => {
        successen.push(p);
      },
    });
    assertEquals(fouten[0].status, 500);
    assertEquals(successen[0].provider, "deepseek");
    assertEquals(successen[0].usage?.completion_tokens, 5);
  } finally {
    f.herstel();
  }
});

test("slaat DeepSeek over bij een beeld in een system-bericht", async () => {
  const f = metAntwoorden({ content: "ok" });
  const berichten = [{
    role: "system",
    content: [{ type: "image_url", image_url: { url: "data:x" } }],
  }];
  try {
    assert(heeftBeeldInSysteem(berichten));
    await assertRejects(
      () =>
        callAi(berichten, {
          label: "t",
          sleutels,
          volgorde: ["deepseek"],
          beeld: true,
        }),
      AiOnbeschikbaar,
    );
    assertEquals(f.aanroepen.length, 0);
  } finally {
    f.herstel();
  }
});

test("noemt de sleutels en de laatste fout als alles faalt", async () => {
  const f = metAntwoorden({ status: 401 });
  try {
    await assertRejects(
      () =>
        callAi(vraag, {
          label: "t",
          sleutels,
          volgorde: ["lovable", "deepseek"],
        }),
      AiOnbeschikbaar,
      "No AI provider available (sleutels: lovable+deepseek; laatste fout: deepseek gaf 401)",
    );
  } finally {
    f.herstel();
  }
});

// ---- 0.2.0 ----

test("stuurt max_tokens en temperature enkel mee als ze opgegeven zijn", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    await callAi(vraag, { label: "t", sleutels });
    assertEquals("max_tokens" in f.aanroepen[0].body, false);
    assertEquals("temperature" in f.aanroepen[0].body, false);
    await callAi(vraag, {
      label: "t",
      sleutels,
      volgorde: ["lovable", "deepseek"],
      maxTokens: 50,
      temperature: 0,
    });
    assertEquals(f.aanroepen[1].body.max_tokens, 50);
    assertEquals(f.aanroepen[1].body.temperature, 0);
  } finally {
    f.herstel();
  }
  const ds = bouwDeepseekBody({ model: "m", messages: [] });
  assertEquals("max_tokens" in ds, false);
  assertEquals(ds.thinking, { type: "disabled" });
});

test("stuurt response_format mee", async () => {
  const f = metAntwoorden({ content: "{}" });
  try {
    await callAi(vraag, {
      label: "t",
      sleutels,
      volgorde: ["lovable", "deepseek"],
      responseFormat: { type: "json_object" },
    });
    assertEquals(f.aanroepen[0].body.response_format, { type: "json_object" });
  } finally {
    f.herstel();
  }
});

test("herkanst bij een netwerkfout binnen dezelfde provider", async () => {
  const origineel = globalThis.fetch;
  const urls: string[] = [];
  let n = 0;
  globalThis.fetch = ((url: string) => {
    urls.push(url);
    if (n++ === 0) return Promise.reject(new TypeError("connection reset"));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      ),
    );
  }) as typeof fetch;
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels,
      pogingen: 2,
      volgorde: ["lovable", "deepseek"],
    });
    assertEquals(r.provider, "lovable");
    assertEquals(urls.length, 2);
    assertEquals(urls[0], urls[1]);
  } finally {
    globalThis.fetch = origineel;
  }
});

test("geeft de lengte van de inhoud mee aan bijSucces", async () => {
  const f = metAntwoorden({ content: "hallo" });
  const gezien: AiPoging[] = [];
  try {
    await callAi(vraag, {
      label: "t",
      sleutels,
      volgorde: ["lovable", "deepseek"],
      bijSucces: (p) => {
        gezien.push(p);
      },
    });
    assertEquals(gezien[0].lengte, 5);
  } finally {
    f.herstel();
  }
});

test("herkanst een afgekeurd antwoord bij dezelfde provider als dat gevraagd wordt", async () => {
  const f = metAntwoorden({ content: "Sorry" }, { content: "goed" });
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels,
      volgorde: ["lovable", "deepseek"],
      pogingen: 2,
      aanvaard: (c) => c !== "Sorry",
      herkansBijAfkeuring: true,
    });
    assertEquals(r.content, "goed");
    assertEquals(r.provider, "lovable");
    assertEquals(f.aanroepen.length, 2);
    assert(f.aanroepen.every((a) => a.url.includes("lovable")));
  } finally {
    f.herstel();
  }
});

test("foutTekst: Error, PostgREST-fout, onbekend object, primitief", () => {
  assertEquals(foutTekst(new Error("stuk")), "stuk");
  assertEquals(
    foutTekst({
      message: "duplicate key",
      code: "23505",
      details: "Key (id)=(1) already exists.",
      hint: "",
    }),
    "duplicate key | 23505 | Key (id)=(1) already exists.",
  );
  // De inhoud van een onbekend object hoort niet in een log.
  assertEquals(
    foutTekst({ email: "iemand@voorbeeld.test" }),
    "onbekende fout (Object)",
  );
  assertEquals(foutTekst("tekst"), "tekst");
  assertEquals(foutTekst(null), "null");
});

test("een hook die een niet-Error gooit, breekt niets", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels,
      bijSucces: () => {
        throw { message: "insert mislukt", code: "42501" };
      },
    });
    assertEquals(r.content, "ok");
  } finally {
    f.herstel();
  }
});

// --- transcribeerAudio -------------------------------------------------------
// Spraak naar tekst kan naar Google's gratis API of naar de betalende
// Lovable-gateway; DeepSeek verwerkt geen audio. Deze tests leggen vast dat de
// providerkeuze op EEN plek staat, dat de gratis route voorgaat, dat een
// opgebruikt gratis quotum doorvalt naar de betalende route, en dat een formaat
// dat het model niet kan lezen hier stukloopt in plaats van stil verzonnen te
// worden.

test("transcribeert via Lovable zonder gemini-sleutel", async () => {
  const f = metAntwoorden({ content: "twee sneden brood" });
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels: sleutelsZonderGemini,
    });
    assertEquals(r.tekst, "twee sneden brood");
    assertEquals(r.provider, "lovable");
    assertEquals(r.model, STANDAARD_MODELLEN.lovableAudio[0]);
    assert(f.aanroepen[0].url.includes("ai.gateway.lovable.dev"));
  } finally {
    f.herstel();
  }
});

test("neemt de gratis Gemini-route vóór de betalende gateway", async () => {
  const f = metAntwoorden({ content: "twee sneden brood" });
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels: { ...sleutels, gemini: "test-gem" },
    });
    assertEquals(r.provider, "gemini");
    // De modelnaam draagt GEEN "google/"-voorvoegsel: dat hoort bij de gateway,
    // niet bij Google's eigen API. Een naam van de ene route geeft op de andere
    // een 404 (gemeten 19-09-2026 met gemini-2.5-flash-lite).
    assertEquals(r.model, STANDAARD_MODELLEN.geminiAudio[0]);
    assert(!r.model.startsWith("google/"));
    assert(f.aanroepen[0].url.includes("generativelanguage.googleapis.com"));
    assertEquals(f.aanroepen.length, 1);
  } finally {
    f.herstel();
  }
});

test("valt bij een opgebruikt gratis quotum door naar Lovable", async () => {
  // Een 429 op de gratis route is een leeg DAGquotum, niet een storing. Het
  // tweede gratis model deelt hetzelfde projectquotum, dus dat overslaan is het
  // punt: er hoort precies EEN gratis poging te zijn, en dan de betalende route.
  const f = metAntwoorden(
    { status: 429, content: "" },
    { content: "twee sneden brood" },
  );
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels: { ...sleutels, gemini: "test-gem" },
    });
    assertEquals(r.tekst, "twee sneden brood");
    assertEquals(r.provider, "lovable");
    assertEquals(f.aanroepen.length, 2);
    assert(f.aanroepen[0].url.includes("generativelanguage.googleapis.com"));
    assert(f.aanroepen[1].url.includes("ai.gateway.lovable.dev"));
  } finally {
    f.herstel();
  }
});

test("probeert bij een ingetrokken gratis model wél het volgende", async () => {
  // Een 404 betekent dat DIT model weg is (zoals gemini-2.5-flash-lite op
  // 19-09-2026), niet dat het quotum op is: de terugval hoort dan gewoon te
  // draaien, nog steeds gratis, zonder naar de betalende route te springen.
  const f = metAntwoorden(
    { status: 404, content: "" },
    { content: "twee sneden brood" },
  );
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels: { ...sleutels, gemini: "test-gem" },
    });
    assertEquals(r.provider, "gemini");
    assertEquals(r.model, STANDAARD_MODELLEN.geminiAudio[1]);
    assertEquals(f.aanroepen.length, 2);
  } finally {
    f.herstel();
  }
});

test("een afgedwongen model geldt voor elke provider", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      model: "eigen-model",
      sleutels: { ...sleutels, gemini: "test-gem" },
    });
    assertEquals(r.model, "eigen-model");
    assertEquals(f.aanroepen[0].body.model, "eigen-model");
  } finally {
    f.herstel();
  }
});

test("stuurt de audio als input_audio in een user-bericht", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "ogg",
      taal: "nl",
      sleutels,
    });
    const msgs = f.aanroepen[0].body.messages as Array<
      { role: string; content: unknown }
    >;
    assertEquals(msgs[0].role, "system");
    assertEquals(msgs[1].role, "user");
    const delen = msgs[1].content as Array<Record<string, unknown>>;
    assertEquals(delen[0], {
      type: "input_audio",
      input_audio: { data: "AAAA", format: "ogg" },
    });
    // De taalhint is op 16-09-2026 van "Taalhint: nl." naar een gewone zin
    // gegaan: een model volgt een instructie in lopende taal beter dan een label.
    assert(
      String(delen[1].text).includes(
        "De spreker spreekt Vlaams (Belgisch Nederlands).",
      ),
    );
  } finally {
    f.herstel();
  }
});

// ⚠️ Dit is de belangrijkste test van de drie. De gateway WEIGERT een formaat als
// webm of mp4 niet netjes: ze verzint dan een plausibel klinkende transcriptie.
// Een verzonnen boodschappenlijstje dat als echt doorgaat is erger dan een fout,
// dus de weigering hoort hier te gebeuren, voor er een verzoek uitgaat.
// ⚠️ 17-09-2026: video werd toegevoegd (mp4, mov), maar webm NIET - juist omdat
// deze test bestaat. De meting hieronder ging over webm als `input_audio`; of webm
// als video-deel wel deugt is nooit gemeten, dus blijft het geweigerd.
test("weigert een formaat dat het model niet kan lezen", async () => {
  const f = metAntwoorden({ content: "verzonnen lijstje" });
  try {
    await assertRejects(
      () =>
        transcribeerAudio({
          label: "t",
          base64: "AAAA",
          formaat: "webm" as never,
          sleutels,
        }),
      TypeError,
    );
    assertEquals(f.aanroepen.length, 0);
  } finally {
    f.herstel();
  }
});

test("meldt AiOnbeschikbaar als de gateway blijft falen", async () => {
  const f = metAntwoorden({ status: 500 });
  try {
    await assertRejects(
      () =>
        transcribeerAudio({
          label: "t",
          base64: "AAAA",
          formaat: "wav",
          sleutels,
        }),
      AiOnbeschikbaar,
      "No audio provider available",
    );
  } finally {
    f.herstel();
  }
});

test("slaat een provider zonder sleutel over", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    await assertRejects(
      () =>
        transcribeerAudio({
          label: "t",
          base64: "AAAA",
          formaat: "wav",
          sleutels: {},
        }),
      AiOnbeschikbaar,
      "sleutels: geen",
    );
    assertEquals(f.aanroepen.length, 0);
  } finally {
    f.herstel();
  }
});

// --- audio: de modellenketen ------------------------------------------------
// Er is maar EEN provider die audio kan, dus de terugval is een ander MODEL bij
// dezelfde gateway. Peter, 16-09-2026: 2.5-flash-lite als standaard (goedkoopst,
// $0,30/M audio-in) met 3.1-flash-lite ($0,50) eronder.

test("gebruikt standaard het goedkoopste audiomodel", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels: sleutelsZonderGemini,
    });
    assertEquals(r.model, "google/gemini-3.1-flash-lite");
    assertEquals(f.aanroepen[0].body.model, "google/gemini-3.1-flash-lite");
  } finally {
    f.herstel();
  }
});

// ☠️ De reden dat er een keten is: 2.5-flash-lite verloopt op 28-01-2027. Valt het
// weg met een 4xx, dan moet spraak blijven werken op het volgende model.
test("valt bij een 4xx door naar het volgende audiomodel", async () => {
  const f = metAntwoorden({ status: 404 }, { content: "twee sneden brood" });
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels: sleutelsZonderGemini,
    });
    assertEquals(r.tekst, "twee sneden brood");
    assertEquals(r.model, "google/gemini-2.5-flash");
    assertEquals(f.aanroepen.length, 2);
    assertEquals(f.aanroepen[0].body.model, "google/gemini-3.1-flash-lite");
    assertEquals(f.aanroepen[1].body.model, "google/gemini-2.5-flash");
  } finally {
    f.herstel();
  }
});

test("valt ook bij een 5xx door naar het volgende audiomodel", async () => {
  const f = metAntwoorden({ status: 500 }, { content: "ok" });
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels: sleutelsZonderGemini,
    });
    assertEquals(r.model, "google/gemini-2.5-flash");
  } finally {
    f.herstel();
  }
});

test("een enkele model-string blijft werken", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      model: "google/gemini-3-flash-preview",
      sleutels,
    });
    assertEquals(r.model, "google/gemini-3-flash-preview");
    assertEquals(f.aanroepen.length, 1);
  } finally {
    f.herstel();
  }
});

test("geeft op als elk audiomodel faalt", async () => {
  const f = metAntwoorden({ status: 500 });
  try {
    await assertRejects(
      () =>
        transcribeerAudio({
          label: "t",
          base64: "AAAA",
          formaat: "wav",
          sleutels: sleutelsZonderGemini,
        }),
      AiOnbeschikbaar,
      "No audio provider available",
    );
    // Beide modellen geprobeerd, niet blijven hangen op het eerste.
    assertEquals(f.aanroepen.length, 2);
  } finally {
    f.herstel();
  }
});

// --- genereerBeeld -----------------------------------------------------------
// Beeld kan alleen naar Lovable: DeepSeek genereert geen beelden. Deze tests
// leggen de drie regels vast die geld of een stille storing gekost hebben, en die
// elke herschrijving moeten overleven.

/** Mock die beeld-antwoorden teruggeeft, of tekst wanneer `content` gezet is. */
function metBeeld(
  ...antwoorden: {
    dataUrl?: string;
    content?: string;
    status?: number;
    gooi?: unknown;
    /** Antwoord in het images-formaat van Meta: kale base64, geen data-URL. */
    metaB64?: string;
    /** Een 200 in Meta-formaat zonder beeld erin. */
    metaLeeg?: boolean;
  }[]
) {
  const aanroepen: { url: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const origineel = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    aanroepen.push({ url, body: JSON.parse(String(init.body)) });
    const a = antwoorden[Math.min(i++, antwoorden.length - 1)];
    if (a.gooi) return Promise.reject(a.gooi);
    if (a.metaB64 || a.metaLeeg) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            created: 1,
            data: a.metaB64 ? [{ b64_json: a.metaB64 }] : [],
            output_format: "png",
            usage: { input_tokens: 9831, output_tokens: 749 },
          }),
          { status: a.status ?? 200 },
        ),
      );
    }
    const message = a.dataUrl
      ? { images: [{ image_url: { url: a.dataUrl } }] }
      : { content: a.content ?? "" };
    return Promise.resolve(
      new Response(
        JSON.stringify({ choices: [{ message }], usage: { total_tokens: 9 } }),
        { status: a.status ?? 200 },
      ),
    );
  }) as typeof fetch;
  return { aanroepen, herstel: () => (globalThis.fetch = origineel) };
}

/** Een geldige 1x1 PNG als data-URL. */
const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("genereert een beeld via Lovable met het beeldmodel", async () => {
  const f = metBeeld({ dataUrl: PNG_1X1 });
  try {
    const r = await genereerBeeld({ label: "t", prompt: "een eend", sleutels });
    assertEquals(r.provider, "lovable");
    assertEquals(r.model, STANDAARD_MODELLEN.lovableBeeld[0]);
    assertEquals(r.mimeType, "image/png");
    assert(r.bytes.length > 0);
    assert(f.aanroepen[0].url.includes("ai.gateway.lovable.dev"));
    assertEquals(f.aanroepen[0].body.modalities, ["image", "text"]);
  } finally {
    f.herstel();
  }
});

test("valt bij een foutstatus door naar het volgende model", async () => {
  // Een foutstatus betekent dat de gateway niets gerenderd en dus niets
  // aangerekend heeft: het volgende model mag het proberen.
  const f = metBeeld({ status: 500 }, { dataUrl: PNG_1X1 });
  try {
    const r = await genereerBeeld({ label: "t", prompt: "x", sleutels });
    assertEquals(r.model, STANDAARD_MODELLEN.lovableBeeld[1]);
    assertEquals(f.aanroepen.length, 2);
    assertEquals(f.aanroepen[0].body.model, STANDAARD_MODELLEN.lovableBeeld[0]);
  } finally {
    f.herstel();
  }
});

test("REGEL 1: herkanst NIET na een netwerkfout of timeout", async () => {
  // Een beeld dat server-side al gerenderd is, is al aangerekend, ook als het
  // antwoord ons nooit bereikt. Een tweede poging betekent twee keer betalen.
  const f = metBeeld({ gooi: new Error("socket hang up") }, {
    dataUrl: PNG_1X1,
  });
  try {
    await assertRejects(
      () => genereerBeeld({ label: "t", prompt: "x", sleutels }),
      AiOnbeschikbaar,
    );
    assertEquals(f.aanroepen.length, 1, "er mag maar EEN aanroep gedaan zijn");
  } finally {
    f.herstel();
  }
});

// --- Meta (Muse Image) als eerste beeldprovider, sinds 0.14.0 ---------------

const PNG_B64 = PNG_1X1.slice(PNG_1X1.indexOf(",") + 1);
const sleutelsMetMeta = { ...sleutels, meta: "test-meta" };

test("beeld: met een Meta-sleutel gaat Meta eerst, in het images-formaat", async () => {
  const f = metBeeld({ metaB64: PNG_B64 });
  try {
    const r = await genereerBeeld({
      label: "t",
      prompt: "een eend",
      formaat: "1792x1024",
      sleutels: sleutelsMetMeta,
    });
    assertEquals(r.provider, "meta");
    assertEquals(r.model, "muse-image-1.0");
    assertEquals(r.mimeType, "image/png");
    assert(r.bytes.length > 0);
    assertEquals(f.aanroepen.length, 1);
    assert(f.aanroepen[0].url.includes("api.meta.ai/v1/images/generations"));
    assertEquals(f.aanroepen[0].body, {
      model: "muse-image-1.0",
      prompt: "een eend",
      n: 1,
      response_format: "b64_json",
      output_format: "png",
      size: "1792x1024",
    });
  } finally {
    f.herstel();
  }
});

test("beeld: zonder Meta-sleutel loopt alles zoals voorheen over Lovable", async () => {
  const f = metBeeld({ dataUrl: PNG_1X1 });
  try {
    const r = await genereerBeeld({
      label: "t",
      prompt: "x",
      formaat: "1792x1024",
      sleutels,
    });
    assertEquals(r.provider, "lovable");
    // De Gemini-modellen negeren een maatvraag: het veld gaat niet mee.
    assertEquals("size" in f.aanroepen[0].body, false);
  } finally {
    f.herstel();
  }
});

test("beeld: een foutstatus bij Meta valt door naar Lovable", async () => {
  const f = metBeeld({ status: 500 }, { dataUrl: PNG_1X1 });
  try {
    const r = await genereerBeeld({
      label: "t",
      prompt: "x",
      sleutels: sleutelsMetMeta,
    });
    assertEquals(r.provider, "lovable");
    assertEquals(r.model, STANDAARD_MODELLEN.lovableBeeld[0]);
    assertEquals(f.aanroepen.length, 2);
  } finally {
    f.herstel();
  }
});

test("beeld: REGEL 2 geldt per rekening, 402 bij Meta blokkeert Lovable niet", async () => {
  const f = metBeeld({ status: 402 }, { dataUrl: PNG_1X1 });
  try {
    const r = await genereerBeeld({
      label: "t",
      prompt: "x",
      sleutels: sleutelsMetMeta,
    });
    assertEquals(r.provider, "lovable");
    assert(f.aanroepen[1].url.includes("ai.gateway.lovable.dev"));
  } finally {
    f.herstel();
  }
});

test("beeld: REGEL 2 bij de laatste provider geeft nog altijd een AiQuotumFout", async () => {
  // Meta 500, daarna Lovable 402: geen tweede Lovable-model proberen.
  const f = metBeeld({ status: 500 }, { status: 402 }, { dataUrl: PNG_1X1 });
  try {
    await assertRejects(
      () =>
        genereerBeeld({ label: "t", prompt: "x", sleutels: sleutelsMetMeta }),
      AiQuotumFout,
    );
    assertEquals(f.aanroepen.length, 2);
  } finally {
    f.herstel();
  }
});

test("beeld: een 200 van Meta zonder beeld valt door naar Lovable", async () => {
  const f = metBeeld({ metaLeeg: true }, { dataUrl: PNG_1X1 });
  try {
    const r = await genereerBeeld({
      label: "t",
      prompt: "x",
      sleutels: sleutelsMetMeta,
    });
    assertEquals(r.provider, "lovable");
  } finally {
    f.herstel();
  }
});

test("beeld: REGEL 1 geldt ook over providers, geen Lovable na een timeout bij Meta", async () => {
  const f = metBeeld({ gooi: new Error("timeout") }, { dataUrl: PNG_1X1 });
  try {
    await assertRejects(
      () =>
        genereerBeeld({ label: "t", prompt: "x", sleutels: sleutelsMetMeta }),
      AiOnbeschikbaar,
    );
    assertEquals(f.aanroepen.length, 1);
  } finally {
    f.herstel();
  }
});

test("schatUsd: Muse Image kost een vast bedrag per beeld", () => {
  const r = schatUsd("muse-image-1.0", {
    input_tokens: 9831,
    output_tokens: 749,
  });
  assertEquals(r.usd, 0.01);
  assertEquals(r.geschat, false);
});

test("REGEL 2: valt bij 402 NIET door naar het volgende model", async () => {
  // 402 gaat over de rekening, niet over het model: doorvallen raakt dezelfde
  // muur nog een keer en maakt de fout onleesbaar.
  const f = metBeeld({ status: 402 }, { dataUrl: PNG_1X1 });
  try {
    await assertRejects(
      () => genereerBeeld({ label: "t", prompt: "x", sleutels }),
      AiQuotumFout,
    );
    assertEquals(f.aanroepen.length, 1);
  } finally {
    f.herstel();
  }
});

test("REGEL 2: doet hetzelfde bij 403 (creditlimiet workspace)", async () => {
  const f = metBeeld({ status: 403 }, { dataUrl: PNG_1X1 });
  try {
    await assertRejects(
      () => genereerBeeld({ label: "t", prompt: "x", sleutels }),
      AiQuotumFout,
    );
    assertEquals(f.aanroepen.length, 1);
  } finally {
    f.herstel();
  }
});

test("REGEL 3: tekst in plaats van beeld is een weigering", async () => {
  // Die poging IS aangerekend, en het is een inhoudelijke weigering: herkansen
  // bij hetzelfde model heeft geen zin.
  const f = metBeeld(
    { content: "I cannot generate that image." },
    { dataUrl: PNG_1X1 },
  );
  try {
    const err = await assertRejects(
      () => genereerBeeld({ label: "t", prompt: "x", sleutels }),
      BeeldGeweigerd,
    );
    assert(err.message.includes("cannot generate"));
    assertEquals(f.aanroepen.length, 1);
  } finally {
    f.herstel();
  }
});

test("weigert een beeld dat boven maxBytes uitkomt", async () => {
  const f = metBeeld({ dataUrl: PNG_1X1 });
  try {
    await assertRejects(
      () => genereerBeeld({ label: "t", prompt: "x", maxBytes: 10, sleutels }),
      AiOnbeschikbaar,
    );
  } finally {
    f.herstel();
  }
});

test("de terugval kost evenveel als het eerste model", () => {
  // Springt de terugval in omdat het eerste model wegvalt, dan mag dat de kost
  // niet verdubbelen. Dit legt de afspraak vast, niet de prijs zelf: die staat
  // in het commentaar bij STANDAARD_MODELLEN met de meetdatum erbij.
  assertEquals(STANDAARD_MODELLEN.lovableBeeld.length, 2);
  assertEquals(
    STANDAARD_MODELLEN.lovableBeeld[0],
    "google/gemini-3.1-flash-lite-image",
  );
  assertEquals(
    STANDAARD_MODELLEN.lovableBeeld[1],
    "google/gemini-2.5-flash-image",
  );
  // Geen OpenAI-modellen (Peter, 16-09-2026).
  assert(
    STANDAARD_MODELLEN.lovableBeeld.every((m) => m.startsWith("google/")),
    "geen OpenAI-modellen in de beeldlijst",
  );
});

test("domein stuurt de SYSTEEMPROMPT, niet de staart van de opdracht", async () => {
  // Zonder domeinhint kiest het model bij een kort los woord het akoestisch
  // dichtstbijzijnde: "draai" in plaats van "druiven" (gemeten 16-09-2026 in
  // Foodie, door Peter in de app getest). De hint hoort in de systeemrol, want
  // die stuurt hoe het model LUISTERT; een zin achteraan de opdracht komt te
  // laat. En hij mag geen vrijbrief worden om iets te verzinnen.
  const f = metAntwoorden({ content: "druiven" });
  try {
    await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      domein: "voeding: wat iemand at of dronk",
      sleutels,
    });
    const berichten = f.aanroepen[0].body.messages as Array<
      { role: string; content: unknown }
    >;
    const systeem = String(berichten[0].content);
    assert(
      systeem.includes("voeding: wat iemand at of dronk"),
      "domein niet in de systeemprompt",
    );
    assert(
      systeem.includes("bestaand woord"),
      "de afweging bij twijfel ontbreekt",
    );
    // Het verbod staat ACHTERAAN: dat is de laatste instructie die telt.
    assert(systeem.includes("vul NOOIT iets aan"), "verzin-verbod ontbreekt");
    assert(
      systeem.indexOf("vul NOOIT iets aan") > systeem.indexOf("voeding:"),
      "het verbod hoort NA het domein te staan",
    );
    assert(systeem.includes("luisterkader"), "de nuance ontbreekt");
  } finally {
    f.herstel();
  }
});

test("de opdracht zegt wat te doen bij half verstaan en bij stilte", async () => {
  // Concreet in plaats van verbiedend: een model dat alleen hoort wat het NIET
  // mag, kiest bij twijfel alsnog iets plausibels.
  const f = metAntwoorden({ content: "ok" });
  try {
    await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      taal: "nl",
      sleutels,
    });
    const berichten = f.aanroepen[0].body.messages as Array<
      { role: string; content: unknown }
    >;
    const tekst =
      (berichten[1].content as Array<{ type: string; text?: string }>)
        .find((d) => d.type === "text")?.text ?? "";
    assert(
      tekst.includes("gok niet naar iets langers"),
      "half-verstaan-regel ontbreekt",
    );
    assert(tekst.includes("NIETS_VERSTAAN"), "stilte-regel ontbreekt");
    assert(
      tekst.includes("De spreker spreekt Vlaams (Belgisch Nederlands)."),
      "taalhint ontbreekt",
    );
  } finally {
    f.herstel();
  }
});

test("zonder domein blijft de standaard-systeemprompt staan", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels,
    });
    const berichten = f.aanroepen[0].body.messages as Array<
      { role: string; content: unknown }
    >;
    const systeem = String(berichten[0].content);
    assert(
      !systeem.includes("korte gesproken notities over"),
      "domeinvorm hoort er niet te staan",
    );
    assert(
      systeem.includes("transcriptie-assistent"),
      "standaardprompt ontbreekt",
    );
  } finally {
    f.herstel();
  }
});

test("taalcode wordt een taalnaam, en nl is Vlaams", () => {
  // Een ISO-code is geen instructie. En bij Nederlands is "Vlaams" preciezer dan
  // "Nederlands": de sprekers van deze apps zijn Vlaams, wat zowel de woordkeuze
  // (pistolet, frigo, croque) als de klankherkenning stuurt.
  assertEquals(taalnaam("nl"), "Vlaams (Belgisch Nederlands)");
  assertEquals(taalnaam("NL"), "Vlaams (Belgisch Nederlands)");
  assertEquals(taalnaam("nl-BE"), "Vlaams (Belgisch Nederlands)");
  assertEquals(taalnaam("fr"), "Frans");
  // Onbekend gaat ongewijzigd mee: een ruwe hint is beter dan geen.
  assertEquals(taalnaam("xx"), "xx");
});

// --- video in transcribeerAudio ----------------------------------------------
// Toegevoegd 17-09-2026. Een mp4 mag NIET als `input_audio` vertrekken: de gateway
// verwacht daar een apart video-deel. Billara deed dit tot vandaag met een eigen
// fetch omdat dit pakket het niet kon.

test("stuurt video als een video-deel, niet als input_audio", async () => {
  const f = metAntwoorden({ content: "hallo uit de video" });
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "BBBB",
      formaat: "mp4",
      sleutels,
    });
    assertEquals(r.tekst, "hallo uit de video");
    const msgs = f.aanroepen[0].body.messages as Array<
      { role: string; content: unknown }
    >;
    const delen = msgs[1].content as Array<Record<string, unknown>>;
    assertEquals(delen[0].type, "video");
    assertEquals(
      (delen[0].video as Record<string, unknown>).format,
      "mp4",
    );
    assertEquals(
      (delen[0].video as Record<string, unknown>).data,
      "BBBB",
    );
    // De tegentoets: er mag NERGENS een input_audio-deel in zitten.
    assert(!delen.some((d) => d.type === "input_audio"));
  } finally {
    f.herstel();
  }
});

test("audio blijft input_audio, ook nu video bestaat", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "mp3",
      sleutels,
    });
    const msgs = f.aanroepen[0].body.messages as Array<
      { role: string; content: unknown }
    >;
    const delen = msgs[1].content as Array<Record<string, unknown>>;
    assertEquals(delen[0].type, "input_audio");
    assert(!delen.some((d) => d.type === "video"));
  } finally {
    f.herstel();
  }
});

test("de standaardopdracht zegt videobericht bij video", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    await transcribeerAudio({
      label: "t",
      base64: "BBBB",
      formaat: "mov",
      sleutels,
    });
    const msgs = f.aanroepen[0].body.messages as Array<
      { role: string; content: unknown }
    >;
    const delen = msgs[1].content as Array<Record<string, unknown>>;
    const tekst = String(delen[delen.length - 1].text);
    assert(tekst.includes("videobericht"), tekst);
    assert(!tekst.includes("audiobericht"), tekst);
  } finally {
    f.herstel();
  }
});

test("een onbekend formaat noemt beide lijsten", async () => {
  await assertRejects(
    () =>
      transcribeerAudio({
        label: "t",
        base64: "AAAA",
        // deno-lint-ignore no-explicit-any
        formaat: "avi" as any,
        sleutels,
      }),
    TypeError,
    "video:",
  );
});

test("VIDEO_FORMATEN en AUDIO_FORMATEN overlappen niet", () => {
  for (const v of VIDEO_FORMATEN) {
    assert(
      !(AUDIO_FORMATEN as readonly string[]).includes(v),
      `${v} staat in beide lijsten, dan is de keuze tussen video en input_audio willekeurig`,
    );
  }
});

test("leesJson: kaal antwoord, het gewone geval", () => {
  assertEquals(leesJson('{"a":1}'), { a: 1 });
  assertEquals(leesJson('  {"a":1}\n'), { a: 1 });
});

test("leesJson: uit een codeblok, met en zonder taalaanduiding", () => {
  assertEquals(leesJson('```json\n{"a":1}\n```'), { a: 1 });
  assertEquals(leesJson('```\n{"a":1}\n```'), { a: 1 });
});

test(
  "leesJson: KEUZE - een fence MIDDENIN de tekst telt ook mee",
  () => {
    // Dit is het gedragsverschil tussen de twee implementaties die dit pakket
    // vervangt: Billara's `parseAIJson` zocht de eerste fence overal, de
    // podcast-variant streepte alleen fences aan begin en eind weg. Hier staat
    // de eerste variant, en deze test legt dat vast.
    const ruw = 'Hier is het antwoord:\n\n```json\n{"a":1}\n```\n\n' +
      "Laat me weten of dit klopt {of niet}.";
    assertEquals(leesJson(ruw), { a: 1 });
  },
);

test("leesJson: JSON met tekst eromheen, zonder fence", () => {
  assertEquals(leesJson('Zeker! {"a":1} Groeten.'), { a: 1 });
});

test("leesJson: lege string en tekst zonder JSON geven null", () => {
  assertEquals(leesJson(""), null);
  assertEquals(leesJson("   \n  "), null);
  assertEquals(leesJson("Sorry, dat kan ik niet."), null);
  assertEquals(leesJson("{ dit is geen json }"), null);
});

test("leesJson: een niet-afgesloten fence valt terug op de tekststap", () => {
  assertEquals(leesJson('```json\n{"a":1}'), { a: 1 });
});

test("leesJson: een fence zonder geldige JSON valt terug op de tekststap", () => {
  // De stappen zijn een keten, geen keuze: mist de fence, dan mag stap (c) nog.
  const ruw = 'Voorbeeld:\n```sql\nSELECT 1;\n```\nAntwoord: {"a":1}';
  assertEquals(leesJson(ruw), { a: 1 });
});

test("leesJson: vorm array zoekt vierkante haken", () => {
  assertEquals(leesJson("Hier komt ie: [1,2] klaar.", { vorm: "array" }), [
    1,
    2,
  ]);
  // Zonder `vorm` zoekt stap (c) accolades, dus deze array blijft onvindbaar.
  assertEquals(leesJson("Hier komt ie: [1,2] klaar."), null);
});

test("leesJson: een kale array komt terug, ook als je een object vroeg", () => {
  // Bewust: stap (a) is een kale JSON.parse en doet GEEN vormcontrole. `vorm`
  // stuurt alleen welke haken stap (c) zoekt. Schemavalidatie blijft bij de
  // aanroeper, dus een array die geldige JSON is komt gewoon terug.
  assertEquals(leesJson("[1,2]"), [1, 2]);
});

test("leesJson: fence-inhoud hoeft geen object of array te zijn", () => {
  // De strip-variant kon dit niet: die zoekt haken en vindt er geen.
  assertEquals(leesJson('```json\n"hallo"\n```'), "hallo");
  assertEquals(leesJson("```\n42\n```"), 42);
});

test("schatUsd: bekend tekstmodel, met de hand nagerekend", () => {
  // 1000 x $0,0000005 = $0,0005 input, 500 x $0,000003 = $0,0015 output.
  const r = schatUsd("google/gemini-3-flash-preview", {
    prompt_tokens: 1000,
    completion_tokens: 500,
  });
  assertEquals(r.usd, 0.002);
  assertEquals(r.input, 1000);
  assertEquals(r.output, 500);
  assertEquals(r.geschat, false);
});

test("schatUsd: DeepSeek rekent per token, niet per miljoen", () => {
  // 1M x $0,27/M = $0,27 en 500k x $1,10/M = $0,55, samen $0,82.
  const r = schatUsd("deepseek-v4-flash", {
    prompt_tokens: 1_000_000,
    completion_tokens: 500_000,
  });
  assertAlmostEquals(r.usd, 0.82);
  assertEquals(r.geschat, false);
});

test("schatUsd: onbekend model geeft 0 en geschat", () => {
  // Bewust: liever een zichtbaar ontbrekend bedrag dan een verzonnen bedrag.
  const r = schatUsd("google/gemini-3.1-flash-lite-image", {
    prompt_tokens: 100,
    completion_tokens: 100,
  });
  assertEquals(r, { usd: 0, input: 0, output: 0, geschat: true });
});

test("schatUsd: zonder usage is een tekstmodel gewoon 0, niet geschat", () => {
  const r = schatUsd("google/gemini-2.5-flash");
  assertEquals(r, { usd: 0, input: 0, output: 0, geschat: false });
});

test("schatUsd: zonder usage valt beeld terug op het vaste tokenaantal", () => {
  // 1290 beeldtokens x $0,00003 = $0,0387.
  const r = schatUsd("google/gemini-2.5-flash-image");
  assertEquals(r.output, 1290);
  assertEquals(r.usd, 0.0387);
  assertEquals(r.geschat, true);
});

test("TARIEVEN staan per token, niet per miljoen", () => {
  // Een tarief per miljoen zou hier ordes van grootte te hoog uitkomen; deze
  // grens (1 dollarcent per token) betrapt zo'n eenheidsfout meteen.
  for (const [model, t] of Object.entries(TARIEVEN)) {
    assert(t.input < 0.01, `${model} input lijkt per miljoen`);
    assert(t.output < 0.01, `${model} output lijkt per miljoen`);
  }
});

// --- Claude (Anthropic Messages API) als schakel vóór Lovable, sinds 0.15.0 ---

/** Fetch-mock die per URL een OpenAI- of een Anthropic-antwoord geeft. */
function metAnthropic(
  anthropic: { status?: number; body?: Record<string, unknown> },
  overige: { status?: number; content?: string } = { status: 500 },
) {
  const aanroepen: {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }[] = [];
  const origineel = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    aanroepen.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    if (url.includes("api.anthropic.com")) {
      return Promise.resolve(
        new Response(JSON.stringify(anthropic.body ?? {}), {
          status: anthropic.status ?? 200,
        }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{
            message: { content: overige.content ?? "" },
            finish_reason: "stop",
          }],
        }),
        { status: overige.status ?? 200 },
      ),
    );
  }) as typeof fetch;
  return { aanroepen, herstel: () => (globalThis.fetch = origineel) };
}

const metClaude = { ...sleutels, anthropic: "test-ant" };

test("Claude staat vooraan in de standaardvolgorde (sinds 0.19.0)", async () => {
  const f = metAnthropic({
    body: {
      content: [{ type: "text", text: "van claude" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 3 },
    },
  });
  try {
    const r = await callAi(vraag, { label: "t", sleutels: metClaude });
    assertEquals(r.provider, "anthropic");
    assertEquals(r.model, "claude-haiku-5-5");
    assertEquals(r.content, "van claude");
    assertEquals(r.finishReason, "stop");
    assertEquals(r.usage?.prompt_tokens, 7);
    assertEquals(r.usage?.completion_tokens, 3);
    assertEquals(
      f.aanroepen.map((a) => new URL(a.url).host),
      ["api.anthropic.com"],
    );
    const ant = f.aanroepen[0];
    assertEquals(ant.headers["x-api-key"], "test-ant");
    assertEquals(ant.headers["anthropic-version"], "2023-06-01");
    assert(!("Authorization" in ant.headers));
  } finally {
    f.herstel();
  }
});

test("zonder Anthropic-sleutel loopt de keten zoals voorheen", async () => {
  const f = metAnthropic({ status: 500 });
  try {
    await assertRejects(() => callAi(vraag, { label: "t", sleutels }));
    assert(!f.aanroepen.some((a) => a.url.includes("api.anthropic.com")));
  } finally {
    f.herstel();
  }
});

test("een 400 van Claude (tegoed op) valt door naar Lovable", async () => {
  // Het maandtegoed op geeft een 400 "credit balance too low". Geen herkansing,
  // wel de volgende provider: daar is Lovable precies voor.
  let n = 0;
  const origineel = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    n++;
    if (url.includes("api.anthropic.com")) {
      return Promise.resolve(new Response("credit balance", { status: 400 }));
    }
    if (url.includes("lovable.dev")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "lov" }, finish_reason: "stop" }],
          }),
        ),
      );
    }
    return Promise.resolve(new Response("", { status: 500 }));
  }) as typeof fetch;
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels: metClaude,
      volgorde: ["anthropic", "lovable"],
      pogingen: 2,
    });
    assertEquals(r.provider, "lovable");
    assertEquals(n, 2);
  } finally {
    globalThis.fetch = origineel;
  }
});

test("Claude: system, beeld en toolgeschiedenis in Messages-vorm", () => {
  const body = bouwAnthropicBody({
    model: "claude-haiku-5-5",
    messages: [
      { role: "system", content: "Je bent kort." },
      {
        role: "user",
        content: [
          { type: "text", text: "wat zie je" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,QUJD" },
          },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "c1",
          type: "function",
          function: { name: "zoek", arguments: '{"q":"x"}' },
        }],
      },
      { role: "tool", tool_call_id: "c1", content: "gevonden" },
    ],
  });
  assertEquals(body.system, "Je bent kort.");
  assertEquals(body.max_tokens, 16000);
  const m = body.messages as {
    role: string;
    content: Record<string, unknown>[];
  }[];
  assertEquals(m.map((x) => x.role), ["user", "assistant", "user"]);
  assertEquals(m[0].content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJD" },
  });
  assertEquals(m[1].content, [
    { type: "tool_use", id: "c1", name: "zoek", input: { q: "x" } },
  ]);
  assertEquals(m[2].content, [
    { type: "tool_result", tool_use_id: "c1", content: "gevonden" },
  ]);
});

test("Claude: nooit temperature, nooit een afgedwongen tool", () => {
  // ☠️ Haiku 5.5 geeft een 400 op een niet-standaard temperature en weigert een
  // afgedwongen tool met denkwerk aan. Een 400 herkanst de keten niet.
  const body = bouwAnthropicBody({
    model: "claude-haiku-5-5",
    messages: vraag,
    maxTokens: 200,
    tools: [{
      type: "function",
      function: {
        name: "zoek",
        description: "d",
        parameters: { type: "object" },
      },
    }],
    toolChoice: { type: "function", function: { name: "zoek" } },
    responseFormat: { type: "json_object" },
  });
  assert(!("temperature" in body));
  assert(!("tool_choice" in body));
  assert(!("response_format" in body));
  assertEquals(body.max_tokens, 200);
  assertEquals(body.tools, [{
    name: "zoek",
    description: "d",
    input_schema: { type: "object" },
  }]);
  assert(String(body.system).includes("zoek"));
  assert(String(body.system).includes("JSON"));
});

test("Claude: geeft tool calls terug in OpenAI-vorm", async () => {
  const f = metAnthropic({
    body: {
      content: [{ type: "tool_use", id: "t1", name: "zoek", input: { q: 1 } }],
      stop_reason: "tool_use",
    },
  });
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels: metClaude,
      volgorde: ["anthropic"],
      temperature: 0.2,
      tools: [{ type: "function", function: { name: "zoek", parameters: {} } }],
    });
    assertEquals(r.toolCall, {
      id: "t1",
      type: "function",
      function: { name: "zoek", arguments: '{"q":1}' },
    });
    assertEquals(r.finishReason, "tool_calls");
    assert(!("temperature" in f.aanroepen[0].body));
  } finally {
    f.herstel();
  }
});

test("Claude: een weigering zonder tekst valt door", async () => {
  const f = metAnthropic(
    { body: { content: [], stop_reason: "refusal" } },
    { content: "lov" },
  );
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels: metClaude,
      volgorde: ["anthropic", "lovable"],
    });
    assertEquals(r.provider, "lovable");
  } finally {
    f.herstel();
  }
});

test("schatUsd kent Claude Haiku 5.5", () => {
  const r = schatUsd("claude-haiku-5-5", {
    prompt_tokens: 1_000_000,
    completion_tokens: 1_000_000,
  });
  assertAlmostEquals(r.usd, 0.6);
  assertEquals(r.geschat, false);
});
