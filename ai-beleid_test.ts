/**
 * De koppeling tussen het beleid en `callAi`, `transcribeerAudio` en `genereerBeeld`.
 * Geen echte calls: `fetch` wordt per test vervangen.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  AiBeleidFout,
  AiOnbeschikbaar,
  type AiPoging,
  callAi,
  genereerBeeld,
  isTegoedFout,
  stelAiBeleidIn,
  transcribeerAudio,
  wisTegoedCache,
} from "./ai.ts";
import { AI_BELEID } from "./ai-beleid.ts";

const AI_VARS = [
  "GEMINI_API_KEY",
  "LOVABLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "META_MODEL_API_KEY",
  "HOLIE_AI_PROJECT",
];
const alle = {
  anthropic: "t-a",
  deepseek: "t-d",
  gemini: "t-g",
  lovable: "t-l",
  meta: "t-m",
};
const vraag = [{ role: "user", content: "hoi" }];

type Antwoord = { status: number; body: unknown };

/** Vervangt fetch; elke aanroep krijgt het volgende antwoord en wordt opgeschreven. */
function test(
  naam: string,
  fn: (urls: string[], zet: (...a: Antwoord[]) => void) => Promise<void>,
) {
  Deno.test(naam, async () => {
    const bewaard = AI_VARS.map((v) => [v, Deno.env.get(v)] as const);
    for (const v of AI_VARS) Deno.env.delete(v);
    wisTegoedCache();
    stelAiBeleidIn({});
    const echt = globalThis.fetch;
    const urls: string[] = [];
    let antwoorden: Antwoord[] = [];
    let i = 0;
    globalThis.fetch = ((url: string) => {
      urls.push(url);
      const a = antwoorden[Math.min(i++, antwoorden.length - 1)];
      return Promise.resolve(
        new Response(JSON.stringify(a.body), { status: a.status }),
      );
    }) as typeof fetch;
    try {
      await fn(urls, (...a) => {
        antwoorden = a;
        i = 0;
      });
    } finally {
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

const chatOk = (tekst = "ok") => ({
  status: 200,
  body: { choices: [{ message: { content: tekst }, finish_reason: "stop" }] },
});
const claudeOk = {
  status: 200,
  body: {
    content: [{ type: "text", text: "van claude" }],
    stop_reason: "end_turn",
  },
};

test("zonder project: oude werking, geen beleid", async (urls, zet) => {
  zet(chatOk());
  const r = await callAi(vraag, {
    label: "t",
    sleutels: alle,
    volgorde: ["deepseek"],
  });
  assertEquals(r.provider, "deepseek");
  assertEquals(r.gegevens, undefined);
  assert(urls[0].includes("deepseek"));
});

test(
  "onder beleid: Foodie-gezondheid begint bij Claude (voorrang)",
  async (urls, zet) => {
    stelAiBeleidIn({ project: "foodie", momentopname: AI_BELEID });
    zet(claudeOk);
    const r = await callAi(vraag, { label: "t", sleutels: alle });
    assertEquals(r.provider, "anthropic");
    assertEquals(r.gegevens, "gezondheid");
    assertEquals(r.type, "tekst");
    assertEquals(r.terugval, false);
    assert(urls[0].includes("anthropic"));
  },
);

test("HOLIE_AI_PROJECT zet een project onder beleid", async (_urls, zet) => {
  Deno.env.set("HOLIE_AI_PROJECT", "billara");
  stelAiBeleidIn({ momentopname: AI_BELEID });
  zet({ status: 500, body: {} }, chatOk("van gemini"));
  const pogingen: AiPoging[] = [];
  const r = await callAi(vraag, {
    label: "t",
    sleutels: alle,
    bijFout: (p) => {
      pogingen.push(p);
    },
  });
  // Billara = persoon: Claude faalt, DeepSeek is uitgesloten, dus gemini.
  assertEquals(r.provider, "gemini");
  assertEquals(r.terugval, true);
  assertEquals(pogingen[0].provider, "anthropic");
  assertEquals(pogingen[0].gegevens, "persoon");
});

test(
  "een eigen volgorde van de aanroeper wordt gefilterd door de uitsluiting",
  async (urls, zet) => {
    stelAiBeleidIn({ project: "shintaka", momentopname: AI_BELEID });
    zet(chatOk());
    await callAi(vraag, {
      label: "t",
      sleutels: alle,
      volgorde: ["deepseek", "anthropic", "gemini", "lovable"],
      gegevens: "persoon",
      context: "roundbook",
      vast: true,
    });
    assert(urls[0].includes("generativelanguage"));
  },
);

test("geen kandidaat over: AiBeleidFout, ook een AiOnbeschikbaar, zonder call", async (urls) => {
  stelAiBeleidIn({ project: "billara", momentopname: AI_BELEID });
  const e = await assertRejects(
    () =>
      callAi(vraag, {
        label: "t",
        sleutels: { deepseek: "t-d" },
        volgorde: ["deepseek"],
      }),
    AiBeleidFout,
  );
  assert(e instanceof AiOnbeschikbaar);
  assertEquals(e.stap, "uitsluiting");
  assertEquals(urls.length, 0);
});

test(
  "tegoed op: Claude 10 minuten overgeslagen na een 400 over credit",
  async (urls, zet) => {
    stelAiBeleidIn({ project: "eendje", momentopname: AI_BELEID });
    zet(
      {
        status: 400,
        body: { error: { message: "Your credit balance is too low" } },
      },
      chatOk("van deepseek"),
    );
    const r1 = await callAi(vraag, { label: "t", sleutels: alle });
    assertEquals(r1.provider, "deepseek");
    assertEquals(urls.length, 2);
    zet(chatOk("weer deepseek"));
    const r2 = await callAi(vraag, { label: "t", sleutels: alle });
    assertEquals(r2.provider, "deepseek");
    // De tweede aanroep sloeg Claude over: één call extra, naar DeepSeek.
    assertEquals(urls.length, 3);
    assert(urls[2].includes("deepseek"));
  },
);

test("een gewone 400 komt niet in de negatieve cache", async (urls, zet) => {
  stelAiBeleidIn({ project: "eendje", momentopname: AI_BELEID });
  zet({ status: 400, body: { error: "bad request" } }, chatOk());
  await callAi(vraag, { label: "t", sleutels: alle });
  zet(claudeOk);
  const r = await callAi(vraag, { label: "t", sleutels: alle });
  assertEquals(r.provider, "anthropic");
  assertEquals(urls.length, 3);
});

test("isTegoedFout herkent de bekende teksten", () => {
  assert(isTegoedFout(400, "Your credit balance is too low"));
  assert(isTegoedFout(402, "Insufficient Balance"));
  assert(!isTegoedFout(500, "credit"));
  assert(!isTegoedFout(400, "invalid model"));
  return Promise.resolve();
});

test(
  "spraak onder beleid: Roundbook-context laat gemini en Lovable toe",
  async (urls, zet) => {
    stelAiBeleidIn({ project: "billara", momentopname: AI_BELEID });
    zet(chatOk("hallo"));
    const r = await transcribeerAudio({
      label: "t",
      base64: "AAAA",
      formaat: "wav",
      sleutels: alle,
      context: "roundbook",
    });
    assertEquals(r.provider, "gemini");
    assertEquals(r.gegevens, "persoon");
    assertEquals(r.type, "audio-in");
    assert(urls[0].includes("generativelanguage"));
  },
);

test(
  "beeld onder beleid: persoonsgegevens mogen niet naar Meta",
  async (urls, zet) => {
    stelAiBeleidIn({ project: "billara", momentopname: AI_BELEID });
    zet({
      status: 200,
      body: {
        choices: [{
          message: {
            images: [{
              image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
            }],
          },
        }],
      },
    });
    const r = await genereerBeeld({ label: "t", prompt: "x", sleutels: alle });
    assertEquals(r.provider, "lovable");
    assert(urls[0].includes("lovable"));
  },
);

test("beeld onder beleid: publiek begint bij Meta", async (urls, zet) => {
  stelAiBeleidIn({ project: "eendje", momentopname: AI_BELEID });
  zet({ status: 200, body: { data: [{ b64_json: "iVBORw0KGgo=" }] } });
  const r = await genereerBeeld({ label: "t", prompt: "x", sleutels: alle });
  assertEquals(r.provider, "meta");
  assertEquals(r.gegevens, "publiek");
  assert(urls[0].includes("meta"));
});

test(
  "zonder momentopname geldt het noodbeleid: gezondheid enkel naar Claude",
  async (urls, zet) => {
    stelAiBeleidIn({ project: "foodie" });
    zet({ status: 500, body: {} });
    const e = await assertRejects(
      () =>
        callAi(vraag, { label: "t", sleutels: alle, gegevens: "gezondheid" }),
      AiOnbeschikbaar,
    );
    assert(!(e instanceof AiBeleidFout));
    assertEquals(urls.length, 1);
    assert(urls[0].includes("anthropic"));
  },
);
