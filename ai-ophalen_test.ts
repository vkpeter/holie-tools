/**
 * Het ondertekende beleid ophalen: vers, verouderd, vervalst, te traag, te oud.
 * Een eigen sleutelpaar per test; geen echte netwerkcalls.
 */
import { assert, assertEquals } from "@std/assert";
import {
  aiBeleidStatus,
  callAi,
  huidigAiBeleid,
  ondertekenBeleid,
  stelAiBeleidIn,
  wisTegoedCache,
} from "./ai.ts";
import { AI_BELEID } from "./ai-beleid.ts";
import type { AiBeleid } from "./beleid.ts";

const ADRES = "https://beleid.test/ai-beleid.json";
const b64 = (b: ArrayBuffer) => {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s);
};

async function sleutelpaar() {
  const paar = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  return {
    prive: b64(await crypto.subtle.exportKey("pkcs8", paar.privateKey)),
    publiek: b64(await crypto.subtle.exportKey("raw", paar.publicKey)),
  };
}

function metVolgnummer(n: number, over: Partial<AiBeleid> = {}): AiBeleid {
  return { ...structuredClone(AI_BELEID), volgnummer: n, ...over };
}

function test(
  naam: string,
  fn: (
    urls: string[],
    zet: (f: (url: string) => Promise<Response>) => void,
  ) => Promise<void>,
) {
  Deno.test(naam, async () => {
    const echt = globalThis.fetch;
    const urls: string[] = [];
    let handler: (url: string) => Promise<Response> = () =>
      Promise.reject(new Error("geen handler"));
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      urls.push(url);
      if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
      return new Promise<Response>((ok, nok) => {
        init?.signal?.addEventListener("abort", () => nok(init.signal!.reason));
        handler(url).then(ok, nok);
      });
    }) as typeof fetch;
    wisTegoedCache();
    try {
      await fn(urls, (f) => (handler = f));
    } finally {
      globalThis.fetch = echt;
      stelAiBeleidIn({});
    }
  });
}

test(
  "haalt het ondertekende beleid op en meldt project en versie",
  async (urls, zet) => {
    const k = await sleutelpaar();
    const env = await ondertekenBeleid(metVolgnummer(5), k.prive);
    zet(() => Promise.resolve(new Response(JSON.stringify(env))));
    stelAiBeleidIn({
      project: "foodie",
      momentopname: AI_BELEID,
      url: ADRES,
      publiekeSleutel: k.publiek,
    });
    const r = await huidigAiBeleid();
    assertEquals(r.bron, "beleidsadres");
    assertEquals(r.beleid.volgnummer, 5);
    assert(urls[0].startsWith(`${ADRES}?project=foodie&v=0.`));
    // Binnen 5 minuten: geen tweede ophaling.
    await huidigAiBeleid();
    assertEquals(urls.length, 1);
    assertEquals(aiBeleidStatus().opgehaald?.volgnummer, 5);
  },
);

test("vervalste handtekening: momentopname", async (_urls, zet) => {
  const k = await sleutelpaar();
  const ander = await sleutelpaar();
  const env = await ondertekenBeleid(metVolgnummer(5), ander.prive);
  zet(() => Promise.resolve(new Response(JSON.stringify(env))));
  stelAiBeleidIn({
    project: "foodie",
    momentopname: AI_BELEID,
    url: ADRES,
    publiekeSleutel: k.publiek,
  });
  const r = await huidigAiBeleid();
  assertEquals(r.bron, "momentopname");
  assertEquals(r.beleid.volgnummer, AI_BELEID.volgnummer);
});

test(
  "gewijzigde inhoud met de oude handtekening: momentopname",
  async (_urls, zet) => {
    const k = await sleutelpaar();
    const env = await ondertekenBeleid(metVolgnummer(5), k.prive);
    env.inhoud = env.inhoud.replace('"volgnummer":5', '"volgnummer":6');
    zet(() => Promise.resolve(new Response(JSON.stringify(env))));
    stelAiBeleidIn({
      project: "foodie",
      momentopname: AI_BELEID,
      url: ADRES,
      publiekeSleutel: k.publiek,
    });
    assertEquals((await huidigAiBeleid()).bron, "momentopname");
  },
);

test(
  "te traag: na de harde timeout de momentopname, en een minuut niet opnieuw wachten",
  async (urls, zet) => {
    const k = await sleutelpaar();
    zet(() => new Promise(() => {})); // antwoordt nooit
    stelAiBeleidIn({
      project: "foodie",
      momentopname: AI_BELEID,
      url: ADRES,
      publiekeSleutel: k.publiek,
    });
    const start = Date.now();
    const r = await huidigAiBeleid();
    const duur = Date.now() - start;
    assertEquals(r.bron, "momentopname");
    assert(duur < 1500, `duurde ${duur} ms`);
    await huidigAiBeleid();
    assertEquals(urls.length, 1);
  },
);

test(
  "een ouder volgnummer dan de momentopname wordt geweigerd",
  async (_urls, zet) => {
    const k = await sleutelpaar();
    const env = await ondertekenBeleid(metVolgnummer(0), k.prive);
    zet(() => Promise.resolve(new Response(JSON.stringify(env))));
    stelAiBeleidIn({
      project: "foodie",
      momentopname: metVolgnummer(3),
      url: ADRES,
      publiekeSleutel: k.publiek,
    });
    const r = await huidigAiBeleid();
    assertEquals(r.bron, "momentopname");
    assertEquals(r.beleid.volgnummer, 3);
  },
);

test("zonder momentopname en zonder adres: noodbeleid", async (_urls, zet) => {
  zet(() => Promise.resolve(new Response("stuk", { status: 500 })));
  stelAiBeleidIn({ project: "foodie", url: ADRES });
  assertEquals((await huidigAiBeleid()).bron, "noodbeleid");
});

test(
  "callAi volgt het opgehaalde beleid: Claude uit = meteen DeepSeek",
  async (urls, zet) => {
    const k = await sleutelpaar();
    const b = metVolgnummer(7);
    b.providers.anthropic.uit = {
      reden: "account geblokt",
      wie: "test",
      datum: "2026-11-01",
    };
    const env = await ondertekenBeleid(b, k.prive);
    zet((url) =>
      Promise.resolve(
        url.startsWith(ADRES)
          ? new Response(JSON.stringify(env))
          : new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            }),
          ),
      )
    );
    stelAiBeleidIn({
      project: "eendje",
      momentopname: AI_BELEID,
      url: ADRES,
      publiekeSleutel: k.publiek,
    });
    const r = await callAi([{ role: "user", content: "hoi" }], {
      label: "t",
      sleutels: { anthropic: "a", deepseek: "d" },
    });
    assertEquals(r.provider, "deepseek");
    assert(urls[1].includes("deepseek"));
  },
);

test("zonder project wordt niets opgehaald", async (urls) => {
  const bewaard = Deno.env.get("HOLIE_AI_PROJECT");
  Deno.env.delete("HOLIE_AI_PROJECT");
  stelAiBeleidIn({ url: ADRES });
  await callAi([{ role: "user", content: "x" }], { label: "t", sleutels: {} })
    .catch(() => {});
  if (bewaard) Deno.env.set("HOLIE_AI_PROJECT", bewaard);
  assertEquals(urls.filter((u) => u.startsWith(ADRES)).length, 0);
});
