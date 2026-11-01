/**
 * Verbruik melden (0.26.0): `callAi`, `transcribeerAudio` en `genereerBeeld` melden één regel
 * per aanroep aan de dagteller, gebundeld en fire-and-forget. Geen echte POST: `fetch` is nep.
 */
import { assert, assertEquals } from "@std/assert";
import {
  aiVerbruikVersturen,
  aiVerbruikWachtrij,
  brusselseDag,
  callAi,
  genereerBeeld,
  meldAiVerbruik,
  PAKKET_VERSIE,
  stelAiBeleidIn,
  VERBRUIK_BUNDEL_MS,
  wisAiVerbruik,
  wisTegoedCache,
} from "./ai.ts";
import { AI_BELEID } from "./ai-beleid.ts";

const VARS = [
  "GEMINI_API_KEY",
  "LOVABLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "META_MODEL_API_KEY",
  "HOLIE_AI_PROJECT",
  "HOLIE_AI_BELEID_URL",
  "HOLIE_AI_VERBRUIK_URL",
];
const alle = {
  anthropic: "t-a",
  deepseek: "t-d",
  gemini: "t-g",
  lovable: "t-l",
  meta: "t-m",
};
const vraag = [{ role: "user", content: "hoi" }];
const NEP = "https://verbruik.test/verbruik";

type Oproep = { url: string; body?: string };

function test(
  naam: string,
  fn: (
    oproepen: Oproep[],
    zet: (f: (url: string) => Response | Promise<Response>) => void,
  ) => Promise<void>,
) {
  Deno.test(naam, async () => {
    const bewaard = VARS.map((v) => [v, Deno.env.get(v)] as const);
    for (const v of VARS) Deno.env.delete(v);
    Deno.env.set("HOLIE_AI_BELEID_URL", "uit");
    wisTegoedCache();
    wisAiVerbruik();
    stelAiBeleidIn({});
    const echt = globalThis.fetch;
    const oproepen: Oproep[] = [];
    let handler: (url: string) => Response | Promise<Response> = () =>
      new Response("{}", { status: 500 });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      oproepen.push({ url: String(url), body: init?.body as string });
      return await handler(String(url));
    }) as typeof fetch;
    try {
      await fn(oproepen, (f) => {
        handler = f;
      });
    } finally {
      wisAiVerbruik();
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

const claudeOk = () =>
  new Response(
    JSON.stringify({
      content: [{ type: "text", text: "van claude" }],
      stop_reason: "end_turn",
      model: "claude-haiku-5-5",
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    }),
    { status: 200 },
  );
const verbruikOk = () => new Response(null, { status: 204 });

function verbruikPosts(oproepen: Oproep[]) {
  return oproepen.filter((o) => o.url === NEP).map((o) => JSON.parse(o.body!));
}

test("zonder project: niets in de wachtrij", async (_o, zet) => {
  stelAiBeleidIn({ verbruik: NEP });
  zet(() =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    )
  );
  await callAi(vraag, { label: "t", sleutels: alle, volgorde: ["deepseek"] });
  assertEquals(aiVerbruikWachtrij(), []);
});

test(
  "HOLIE_AI_BELEID_URL=uit zonder eigen verbruiksadres: niets melden",
  async (oproepen, zet) => {
    stelAiBeleidIn({ project: "foodie", momentopname: AI_BELEID });
    zet(claudeOk);
    await callAi(vraag, { label: "t", sleutels: alle });
    assertEquals(aiVerbruikWachtrij(), []);
    await aiVerbruikVersturen();
    assertEquals(oproepen.length, 1);
  },
);

test(
  "een eigen beleidsadres (test) meldt niets zonder eigen verbruiksadres",
  async (_o, zet) => {
    Deno.env.delete("HOLIE_AI_BELEID_URL");
    stelAiBeleidIn({
      project: "foodie",
      momentopname: AI_BELEID,
      url: "https://nep.test/ai-beleid.json",
    });
    zet((url) =>
      url.includes("nep.test") ? new Response("x", { status: 500 }) : claudeOk()
    );
    await callAi(vraag, { label: "t", sleutels: alle });
    assertEquals(aiVerbruikWachtrij(), []);
  },
);

test(
  "geslaagde aanroep: één regel met provider, type, usd en zonder label",
  async (oproepen, zet) => {
    stelAiBeleidIn({
      project: "foodie",
      momentopname: AI_BELEID,
      verbruik: NEP,
    });
    zet((url) => (url === NEP ? verbruikOk() : claudeOk()));
    await callAi(vraag, { label: "t", sleutels: alle });
    await callAi(vraag, { label: "t", sleutels: alle, gegevens: "gezondheid" });
    const rij = aiVerbruikWachtrij();
    assertEquals(rij.length, 1);
    assertEquals(rij[0].dag, brusselseDag());
    assertEquals(rij[0].project, "foodie");
    assertEquals(rij[0].provider, "anthropic");
    assertEquals(rij[0].type, "tekst");
    assertEquals(rij[0].aanroepen, 2);
    assertEquals(rij[0].zonder_label, 1);
    assertEquals(rij[0].terugval, 0);
    assertEquals(rij[0].fouten, 0);
    // 1M input-tokens Haiku 5.5 = USD 0,10 per aanroep
    assert(Math.abs(rij[0].usd - 0.2) < 1e-9);
    await aiVerbruikVersturen();
    const posts = verbruikPosts(oproepen);
    assertEquals(posts.length, 1);
    assertEquals(posts[0].v, PAKKET_VERSIE);
    assertEquals(posts[0].regels[0].aanroepen, 2);
    assertEquals(aiVerbruikWachtrij(), []);
  },
);

test(
  "terugval en falen tellen apart; een falende aanroep meldt provider geen",
  async (_o, zet) => {
    stelAiBeleidIn({
      project: "billara",
      momentopname: AI_BELEID,
      verbruik: NEP,
    });
    let n = 0;
    zet((url) => {
      if (url === NEP) return verbruikOk();
      n++;
      return n === 1 ? new Response("{}", { status: 500 }) : new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      );
    });
    await callAi(vraag, { label: "t", sleutels: alle });
    zet((url) =>
      url === NEP ? verbruikOk() : new Response("{}", { status: 500 })
    );
    await callAi(vraag, { label: "t", sleutels: alle }).catch(() => {});
    const rij = aiVerbruikWachtrij();
    const gemini = rij.find((r) => r.provider === "gemini")!;
    assertEquals(gemini.terugval, 1);
    const geen = rij.find((r) => r.provider === "geen")!;
    assertEquals(geen.fouten, 1);
    assertEquals(geen.aanroepen, 1);
  },
);

test(
  "de melding vertraagt niets en een falende POST laat de aanroep niet falen",
  async (_o, zet) => {
    stelAiBeleidIn({
      project: "foodie",
      momentopname: AI_BELEID,
      verbruik: NEP,
    });
    zet((url) => {
      if (url === NEP) throw new Error("Worker plat");
      return claudeOk();
    });
    const r = await callAi(vraag, { label: "t", sleutels: alle });
    assertEquals(r.provider, "anthropic");
    await aiVerbruikVersturen(); // gooit niet
    assertEquals(aiVerbruikWachtrij(), []);
  },
);

test("bundelt: na VERBRUIK_BUNDEL_MS één POST", async (oproepen, zet) => {
  stelAiBeleidIn({ project: "foodie", momentopname: AI_BELEID, verbruik: NEP });
  zet((url) => (url === NEP ? verbruikOk() : claudeOk()));
  await callAi(vraag, { label: "t", sleutels: alle });
  await callAi(vraag, { label: "t", sleutels: alle });
  assertEquals(verbruikPosts(oproepen).length, 0);
  await new Promise((r) => setTimeout(r, VERBRUIK_BUNDEL_MS + 150));
  const posts = verbruikPosts(oproepen);
  assertEquals(posts.length, 1);
  assertEquals(posts[0].regels[0].aanroepen, 2);
});

test("EdgeRuntime.waitUntil krijgt de verzending", async (oproepen, zet) => {
  const g = globalThis as { EdgeRuntime?: unknown };
  const beloften: Promise<unknown>[] = [];
  g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => beloften.push(p) };
  try {
    stelAiBeleidIn({
      project: "foodie",
      momentopname: AI_BELEID,
      verbruik: NEP,
    });
    zet((url) => (url === NEP ? verbruikOk() : claudeOk()));
    await callAi(vraag, { label: "t", sleutels: alle });
    assertEquals(beloften.length, 1);
    await beloften[0];
    assertEquals(verbruikPosts(oproepen).length, 1);
  } finally {
    delete g.EdgeRuntime;
  }
});

test(
  "meldAiVerbruik voor een provider buiten het pakket",
  async (oproepen, zet) => {
    stelAiBeleidIn({
      project: "eendje",
      momentopname: AI_BELEID,
      verbruik: NEP,
    });
    zet(verbruikOk);
    meldAiVerbruik({
      provider: "mistral",
      type: "tekst",
      usd: 0.01,
      label: true,
    });
    meldAiVerbruik({ provider: "mistral", type: "tekst", usd: Number.NaN });
    const rij = aiVerbruikWachtrij();
    assertEquals(rij.length, 1);
    assertEquals(rij[0].aanroepen, 2);
    assertEquals(rij[0].usd, 0.01);
    assertEquals(rij[0].zonder_label, 1);
    await aiVerbruikVersturen();
    assertEquals(verbruikPosts(oproepen).length, 1);
  },
);

test("genereerBeeld meldt de vaste prijs van Meta", async (_o, zet) => {
  stelAiBeleidIn({ project: "eendje", momentopname: AI_BELEID, verbruik: NEP });
  zet((url) =>
    url === NEP ? verbruikOk() : new Response(
      JSON.stringify({ data: [{ b64_json: PNG_B64 }] }),
    )
  );
  const r = await genereerBeeld({
    label: "t",
    prompt: "a duck",
    sleutels: alle,
  });
  assertEquals(r.provider, "meta");
  const rij = aiVerbruikWachtrij();
  assertEquals(rij.length, 1);
  assertEquals(rij[0].provider, "meta");
  assertEquals(rij[0].type, "beeld-uit");
  assertEquals(rij[0].usd, 0.01);
});

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test(
  "HOLIE_AI_VERBRUIK_URL=uit wint van het standaardadres",
  async (_o, zet) => {
    Deno.env.delete("HOLIE_AI_BELEID_URL");
    Deno.env.set("HOLIE_AI_VERBRUIK_URL", "uit");
    // geen ophaling: het beleidsadres faalt meteen en de momentopname geldt
    stelAiBeleidIn({ project: "foodie", momentopname: AI_BELEID });
    zet((url) =>
      url.includes("beleid.holie.be")
        ? new Response("x", { status: 500 })
        : claudeOk()
    );
    await callAi(vraag, { label: "t", sleutels: alle });
    assertEquals(aiVerbruikWachtrij(), []);
  },
);

test(
  "Worker: aiVerbruikVersturen wacht op de POST die al onderweg is",
  async (oproepen, zet) => {
    const echt = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "Cloudflare-Workers" },
      configurable: true,
    });
    try {
      stelAiBeleidIn({
        project: "ese",
        momentopname: AI_BELEID,
        verbruik: NEP,
      });
      let losLaten: () => void = () => {};
      let klaar = false;
      zet((url) => {
        if (url !== NEP) return claudeOk();
        return new Promise<Response>((r) => {
          losLaten = () => {
            klaar = true;
            r(verbruikOk());
          };
        });
      });
      await callAi(vraag, { label: "t", sleutels: alle, gegevens: "publiek" });
      await Promise.resolve();
      assertEquals(aiVerbruikWachtrij(), []); // al onderweg
      const wacht = aiVerbruikVersturen();
      setTimeout(() => losLaten(), 20);
      await wacht;
      assert(klaar, "aiVerbruikVersturen keerde terug vóór de POST klaar was");
      assertEquals(verbruikPosts(oproepen).length, 1);
    } finally {
      if (echt) Object.defineProperty(globalThis, "navigator", echt);
    }
  },
);
