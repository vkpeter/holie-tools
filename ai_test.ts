import { assert, assertEquals, assertRejects } from "@std/assert";
import { AiOnbeschikbaar, AiQuotumFout, callAi, heeftBeeldInSysteem, type AiPoging } from "./ai.ts";

type Antwoord = { status?: number; content?: string; finish?: string; toolCall?: unknown };

const sleutels = { lovable: "test-lov", deepseek: "test-ds" };
const vraag = [{ role: "user", content: "hoi" }];

function metAntwoorden(...antwoorden: Antwoord[]) {
  const aanroepen: { url: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const origineel = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    aanroepen.push({ url, body: JSON.parse(String(init.body)) });
    const a = antwoorden[Math.min(i++, antwoorden.length - 1)];
    const message = a.toolCall ? { tool_calls: [a.toolCall] } : { content: a.content ?? "" };
    return Promise.resolve(new Response(
      JSON.stringify({ choices: [{ message, finish_reason: a.finish ?? "stop" }], usage: { completion_tokens: 5 } }),
      { status: a.status ?? 200 },
    ));
  }) as typeof fetch;
  return { aanroepen, herstel: () => (globalThis.fetch = origineel) };
}

Deno.test("probeert standaard eerst Lovable", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    const r = await callAi(vraag, { label: "t", sleutels });
    assertEquals(r.provider, "lovable");
    assert(f.aanroepen[0].url.includes("ai.gateway.lovable.dev"));
  } finally { f.herstel(); }
});

Deno.test("zet het denkwerk van DeepSeek standaard uit", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    await callAi(vraag, { label: "t", sleutels, volgorde: ["deepseek"] });
    assertEquals(f.aanroepen[0].body.thinking, { type: "disabled" });
    assertEquals(f.aanroepen[0].body.model, "deepseek-v4-flash");
  } finally { f.herstel(); }
});

Deno.test("laat DeepSeek nadenken als dat gevraagd wordt", async () => {
  const f = metAntwoorden({ content: "ok" });
  try {
    await callAi(vraag, { label: "t", sleutels, volgorde: ["deepseek"], deepseekDenken: true });
    assertEquals(f.aanroepen[0].body.thinking, { type: "enabled" });
  } finally { f.herstel(); }
});

Deno.test("valt door bij een afgekapt antwoord", async () => {
  const f = metAntwoorden({ content: '{"half', finish: "length" }, { content: '{"heel":1}' });
  try {
    const r = await callAi(vraag, { label: "t", sleutels, volgorde: ["deepseek", "lovable"] });
    assertEquals(r.provider, "lovable");
    assertEquals(r.content, '{"heel":1}');
  } finally { f.herstel(); }
});

Deno.test("geeft een afgekapt antwoord toch terug als er geen volgende provider is", async () => {
  const f = metAntwoorden({ content: "half", finish: "length" });
  try {
    const r = await callAi(vraag, { label: "t", sleutels, volgorde: ["deepseek"] });
    assertEquals(r.content, "half");
    assertEquals(r.finishReason, "length");
  } finally { f.herstel(); }
});

Deno.test("valt door bij een afgekeurd antwoord, zonder het te herhalen", async () => {
  const f = metAntwoorden({ content: "Sorry" }, { content: "Kipfilet" });
  try {
    const r = await callAi(vraag, { label: "t", sleutels, pogingen: 2, aanvaard: (c) => c !== "Sorry" });
    assertEquals(r.provider, "deepseek");
    assertEquals(f.aanroepen.length, 2);
  } finally { f.herstel(); }
});

Deno.test("herkanst bij een 5xx, niet bij een andere 4xx", async () => {
  const f = metAntwoorden({ status: 503 }, { content: "ok" });
  try {
    const r = await callAi(vraag, { label: "t", sleutels, volgorde: ["lovable"], pogingen: 2 });
    assertEquals(r.content, "ok");
  } finally { f.herstel(); }
  const g = metAntwoorden({ status: 401 });
  try {
    await assertRejects(() => callAi(vraag, { label: "t", sleutels, volgorde: ["lovable"], pogingen: 2 }), AiOnbeschikbaar);
    assertEquals(g.aanroepen.length, 1);
  } finally { g.herstel(); }
});

Deno.test("stuurt tools enkel naar de gevraagde providers", async () => {
  const f = metAntwoorden({ status: 500 }, { content: "tekst" });
  const tools = [{ type: "function", function: { name: "x" } }];
  try {
    await callAi(vraag, { label: "t", sleutels, tools, toolChoice: "auto", toolsVoor: ["lovable"] });
    assertEquals(f.aanroepen[0].body.tools, tools);
    assertEquals(f.aanroepen[1].body.tools, undefined);
  } finally { f.herstel(); }
});

Deno.test("geeft tool calls terug", async () => {
  const f = metAntwoorden({ toolCall: { function: { name: "x", arguments: "{}" } } });
  try {
    const r = await callAi(vraag, { label: "t", sleutels, tools: [{}] });
    assertEquals(r.toolCall.function.name, "x");
    assertEquals(r.toolCalls?.length, 1);
  } finally { f.herstel(); }
});

Deno.test("stopt bij een Lovable-quotum als de aanroeper dat vraagt", async () => {
  const f = metAntwoorden({ status: 402 });
  try {
    const fout = await assertRejects(() => callAi(vraag, { label: "t", sleutels, opQuotum: "throw" }), AiQuotumFout);
    assertEquals(fout.message, "CREDITS_402");
    assertEquals(f.aanroepen.length, 1);
  } finally { f.herstel(); }
});

Deno.test("roept de hooks aan, en een falende hook breekt niets", async () => {
  const f = metAntwoorden({ status: 500 }, { content: "ok" });
  const fouten: AiPoging[] = [];
  const successen: AiPoging[] = [];
  try {
    await callAi(vraag, {
      label: "t",
      sleutels,
      bijFout: (p) => { fouten.push(p); throw new Error("hook stuk"); },
      bijSucces: (p) => { successen.push(p); },
    });
    assertEquals(fouten[0].status, 500);
    assertEquals(successen[0].provider, "deepseek");
    assertEquals(successen[0].usage?.completion_tokens, 5);
  } finally { f.herstel(); }
});

Deno.test("slaat DeepSeek over bij een beeld in een system-bericht", async () => {
  const f = metAntwoorden({ content: "ok" });
  const berichten = [{ role: "system", content: [{ type: "image_url", image_url: { url: "data:x" } }] }];
  try {
    assert(heeftBeeldInSysteem(berichten));
    await assertRejects(() => callAi(berichten, { label: "t", sleutels, volgorde: ["deepseek"], beeld: true }), AiOnbeschikbaar);
    assertEquals(f.aanroepen.length, 0);
  } finally { f.herstel(); }
});

Deno.test("noemt de sleutels en de laatste fout als alles faalt", async () => {
  const f = metAntwoorden({ status: 401 });
  try {
    await assertRejects(
      () => callAi(vraag, { label: "t", sleutels }),
      AiOnbeschikbaar,
      "No AI provider available (sleutels: lovable+deepseek; laatste fout: deepseek gaf 401)",
    );
  } finally { f.herstel(); }
});
