import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  AiOnbeschikbaar,
  type AiPoging,
  AiQuotumFout,
  AUDIO_FORMATEN,
  BeeldGeweigerd,
  bouwDeepseekBody,
  callAi,
  foutTekst,
  genereerBeeld,
  heeftBeeldInSysteem,
  STANDAARD_MODELLEN,
  taalnaam,
  transcribeerAudio,
  VIDEO_FORMATEN,
} from "./ai.ts";

type Antwoord = {
  status?: number;
  content?: string;
  finish?: string;
  toolCall?: unknown;
};

const sleutels = { lovable: "test-lov", deepseek: "test-ds" };
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

Deno.test("probeert standaard eerst Lovable", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    const r = await callAi(vraag, { label: "t", sleutels });
    assertEquals(r.provider, "lovable");
    assert(f.aanroepen[0].url.includes("ai.gateway.lovable.dev"));
  } finally {
    f.herstel();
  }
});

Deno.test("zet het denkwerk van DeepSeek standaard uit", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    await callAi(vraag, { label: "t", sleutels, volgorde: ["deepseek"] });
    assertEquals(f.aanroepen[0].body.thinking, { type: "disabled" });
    assertEquals(f.aanroepen[0].body.model, "deepseek-v4-flash");
  } finally {
    f.herstel();
  }
});

Deno.test("laat DeepSeek nadenken als dat gevraagd wordt", async () => {
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

Deno.test("valt door bij een afgekapt antwoord", async () => {
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

Deno.test("geeft een afgekapt antwoord toch terug als er geen volgende provider is", async () => {
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

Deno.test("valt door bij een afgekeurd antwoord, zonder het te herhalen", async () => {
  const f = metAntwoorden({ content: "Sorry" }, { content: "Kipfilet" });
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels,
      pogingen: 2,
      aanvaard: (c) => c !== "Sorry",
    });
    assertEquals(r.provider, "deepseek");
    assertEquals(f.aanroepen.length, 2);
  } finally {
    f.herstel();
  }
});

Deno.test("herkanst bij een 5xx, niet bij een andere 4xx", async () => {
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

Deno.test("stuurt tools enkel naar de gevraagde providers", async () => {
  const f = metAntwoorden({ status: 500 }, { content: "tekst" });
  const tools = [{ type: "function", function: { name: "x" } }];
  try {
    await callAi(vraag, {
      label: "t",
      sleutels,
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

Deno.test("geeft tool calls terug", async () => {
  const f = metAntwoorden({
    toolCall: { function: { name: "x", arguments: "{}" } },
  });
  try {
    const r = await callAi(vraag, { label: "t", sleutels, tools: [{}] });
    assertEquals(r.toolCall.function.name, "x");
    assertEquals(r.toolCalls?.length, 1);
  } finally {
    f.herstel();
  }
});

Deno.test("stopt bij een Lovable-quotum als de aanroeper dat vraagt", async () => {
  const f = metAntwoorden({ status: 402 });
  try {
    const fout = await assertRejects(
      () => callAi(vraag, { label: "t", sleutels, opQuotum: "throw" }),
      AiQuotumFout,
    );
    assertEquals(fout.message, "CREDITS_402");
    assertEquals(f.aanroepen.length, 1);
  } finally {
    f.herstel();
  }
});

Deno.test("roept de hooks aan, en een falende hook breekt niets", async () => {
  const f = metAntwoorden({ status: 500 }, { content: "ok" });
  const fouten: AiPoging[] = [];
  const successen: AiPoging[] = [];
  try {
    await callAi(vraag, {
      label: "t",
      sleutels,
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

Deno.test("slaat DeepSeek over bij een beeld in een system-bericht", async () => {
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

Deno.test("noemt de sleutels en de laatste fout als alles faalt", async () => {
  const f = metAntwoorden({ status: 401 });
  try {
    await assertRejects(
      () => callAi(vraag, { label: "t", sleutels }),
      AiOnbeschikbaar,
      "No AI provider available (sleutels: lovable+deepseek; laatste fout: deepseek gaf 401)",
    );
  } finally {
    f.herstel();
  }
});

// ---- 0.2.0 ----

Deno.test("stuurt max_tokens en temperature enkel mee als ze opgegeven zijn", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    await callAi(vraag, { label: "t", sleutels });
    assertEquals("max_tokens" in f.aanroepen[0].body, false);
    assertEquals("temperature" in f.aanroepen[0].body, false);
    await callAi(vraag, {
      label: "t",
      sleutels,
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

Deno.test("stuurt response_format mee", async () => {
  const f = metAntwoorden({ content: "{}" });
  try {
    await callAi(vraag, {
      label: "t",
      sleutels,
      responseFormat: { type: "json_object" },
    });
    assertEquals(f.aanroepen[0].body.response_format, { type: "json_object" });
  } finally {
    f.herstel();
  }
});

Deno.test("herkanst bij een netwerkfout binnen dezelfde provider", async () => {
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
    const r = await callAi(vraag, { label: "t", sleutels, pogingen: 2 });
    assertEquals(r.provider, "lovable");
    assertEquals(urls.length, 2);
    assertEquals(urls[0], urls[1]);
  } finally {
    globalThis.fetch = origineel;
  }
});

Deno.test("geeft de lengte van de inhoud mee aan bijSucces", async () => {
  const f = metAntwoorden({ content: "hallo" });
  const gezien: AiPoging[] = [];
  try {
    await callAi(vraag, {
      label: "t",
      sleutels,
      bijSucces: (p) => {
        gezien.push(p);
      },
    });
    assertEquals(gezien[0].lengte, 5);
  } finally {
    f.herstel();
  }
});

Deno.test("herkanst een afgekeurd antwoord bij dezelfde provider als dat gevraagd wordt", async () => {
  const f = metAntwoorden({ content: "Sorry" }, { content: "goed" });
  try {
    const r = await callAi(vraag, {
      label: "t",
      sleutels,
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

Deno.test("foutTekst: Error, PostgREST-fout, onbekend object, primitief", () => {
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

Deno.test("een hook die een niet-Error gooit, breekt niets", async () => {
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
// Spraak naar tekst kan alleen naar Lovable: DeepSeek verwerkt geen audio. Deze
// tests leggen vast dat de providerkeuze op EEN plek staat en dat een formaat dat
// het model niet kan lezen hier stukloopt, niet stilletjes verzonnen wordt.

Deno.test("transcribeert via Lovable met het audiomodel", async () => {
  const f = metAntwoorden({ content: "twee sneden brood" });
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels,
    });
    assertEquals(r.tekst, "twee sneden brood");
    assertEquals(r.provider, "lovable");
    assertEquals(r.model, STANDAARD_MODELLEN.lovableAudio[0]);
    assert(f.aanroepen[0].url.includes("ai.gateway.lovable.dev"));
  } finally {
    f.herstel();
  }
});

Deno.test("stuurt de audio als input_audio in een user-bericht", async () => {
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
Deno.test("weigert een formaat dat het model niet kan lezen", async () => {
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

Deno.test("meldt AiOnbeschikbaar als de gateway blijft falen", async () => {
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

Deno.test("slaat een provider zonder sleutel over", async () => {
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

Deno.test("gebruikt standaard het goedkoopste audiomodel", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels,
    });
    assertEquals(r.model, "google/gemini-2.5-flash-lite");
    assertEquals(f.aanroepen[0].body.model, "google/gemini-2.5-flash-lite");
  } finally {
    f.herstel();
  }
});

// ☠️ De reden dat er een keten is: 2.5-flash-lite verloopt op 28-01-2027. Valt het
// weg met een 4xx, dan moet spraak blijven werken op het volgende model.
Deno.test("valt bij een 4xx door naar het volgende audiomodel", async () => {
  const f = metAntwoorden({ status: 404 }, { content: "twee sneden brood" });
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels,
    });
    assertEquals(r.tekst, "twee sneden brood");
    assertEquals(r.model, "google/gemini-3.1-flash-lite");
    assertEquals(f.aanroepen.length, 2);
    assertEquals(f.aanroepen[0].body.model, "google/gemini-2.5-flash-lite");
    assertEquals(f.aanroepen[1].body.model, "google/gemini-3.1-flash-lite");
  } finally {
    f.herstel();
  }
});

Deno.test("valt ook bij een 5xx door naar het volgende audiomodel", async () => {
  const f = metAntwoorden({ status: 500 }, { content: "ok" });
  try {
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels,
    });
    assertEquals(r.model, "google/gemini-3.1-flash-lite");
  } finally {
    f.herstel();
  }
});

Deno.test("een enkele model-string blijft werken", async () => {
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

Deno.test("geeft op als elk audiomodel faalt", async () => {
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
  }[]
) {
  const aanroepen: { url: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const origineel = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    aanroepen.push({ url, body: JSON.parse(String(init.body)) });
    const a = antwoorden[Math.min(i++, antwoorden.length - 1)];
    if (a.gooi) return Promise.reject(a.gooi);
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

Deno.test("genereert een beeld via Lovable met het beeldmodel", async () => {
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

Deno.test("valt bij een foutstatus door naar het volgende model", async () => {
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

Deno.test("REGEL 1: herkanst NIET na een netwerkfout of timeout", async () => {
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

Deno.test("REGEL 2: valt bij 402 NIET door naar het volgende model", async () => {
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

Deno.test("REGEL 2: doet hetzelfde bij 403 (creditlimiet workspace)", async () => {
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

Deno.test("REGEL 3: tekst in plaats van beeld is een weigering", async () => {
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

Deno.test("weigert een beeld dat boven maxBytes uitkomt", async () => {
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

Deno.test("de terugval kost evenveel als het eerste model", () => {
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

Deno.test("domein stuurt de SYSTEEMPROMPT, niet de staart van de opdracht", async () => {
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

Deno.test("de opdracht zegt wat te doen bij half verstaan en bij stilte", async () => {
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

Deno.test("zonder domein blijft de standaard-systeemprompt staan", async () => {
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

Deno.test("taalcode wordt een taalnaam, en nl is Vlaams", () => {
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

Deno.test("stuurt video als een video-deel, niet als input_audio", async () => {
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

Deno.test("audio blijft input_audio, ook nu video bestaat", async () => {
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

Deno.test("de standaardopdracht zegt videobericht bij video", async () => {
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

Deno.test("een onbekend formaat noemt beide lijsten", async () => {
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

Deno.test("VIDEO_FORMATEN en AUDIO_FORMATEN overlappen niet", () => {
  for (const v of VIDEO_FORMATEN) {
    assert(
      !(AUDIO_FORMATEN as readonly string[]).includes(v),
      `${v} staat in beide lijsten, dan is de keuze tussen video en input_audio willekeurig`,
    );
  }
});
