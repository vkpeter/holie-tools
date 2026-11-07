import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type AiBeleid,
  BeleidLeeg,
  geldendeToelating,
  kiesProviders,
  NOODBELEID,
  valideerBeleid,
  voorrangActief,
} from "./beleid.ts";
import { AI_BELEID } from "./ai-beleid.ts";
import { schatUsd } from "./ai.ts";

const NU = new Date("2026-11-15T12:00:00Z");
const beslist = { reden: "test", wie: "test", datum: "2026-11-01" };

/** Een klein beleid waarin elke regel apart te toetsen is. */
function beleid(over: Partial<AiBeleid> = {}): AiBeleid {
  const providers = {
    anthropic: { naam: "a", capaciteiten: ["tekst", "tools", "beeld-in"] },
    deepseek: { naam: "d", capaciteiten: ["tekst", "tools", "beeld-in"] },
    gemini: { naam: "g", capaciteiten: ["tekst", "audio-in"] },
    lovable: { naam: "l", capaciteiten: ["tekst", "audio-in", "beeld-uit"] },
    mistral: { naam: "m", capaciteiten: ["tekst"] },
  } as AiBeleid["providers"];
  const toelatingen: AiBeleid["toelatingen"] = [];
  for (const p of Object.keys(providers)) {
    for (const g of ["publiek", "persoon", "gezondheid"] as const) {
      toelatingen.push({
        ...beslist,
        provider: p,
        gegevens: g,
        status: "testfase",
      });
    }
  }
  return {
    schema: 1,
    volgnummer: 1,
    uitgegeven: "2026-11-01T00:00:00Z",
    providers,
    basis: {
      tekst: ["deepseek", "gemini", "anthropic", "lovable"],
      "audio-in": ["gemini", "lovable"],
    },
    voorrang: [],
    toelatingen,
    contexten: {},
    projecten: {},
    ...over,
  };
}

Deno.test("basisvolgorde zonder bijzondere regels", () => {
  const u = kiesProviders(beleid(), {
    type: "tekst",
    gegevens: "publiek",
    nu: NU,
  });
  assertEquals(u.volgorde, ["deepseek", "gemini", "anthropic", "lovable"]);
  assertEquals(u.gegevensBron, "aanroep");
});

Deno.test("voorrang zet een provider vooraan zolang de datum loopt", () => {
  const b = beleid({
    voorrang: [{ ...beslist, provider: "anthropic", tot: "2026-11-30" }],
  });
  assertEquals(
    kiesProviders(b, { type: "tekst", gegevens: "publiek", nu: NU })
      .volgorde[0],
    "anthropic",
  );
  // Na de einddatum: vanzelf terug naar de basis.
  const later = new Date("2026-12-01T12:00:00Z");
  assertEquals(
    kiesProviders(b, { type: "tekst", gegevens: "publiek", nu: later })
      .volgorde[0],
    "deepseek",
  );
});

Deno.test("voorrang geldt enkel voor zijn types", () => {
  const b = beleid({
    voorrang: [{ ...beslist, provider: "lovable", types: ["audio-in"] }],
  });
  assertEquals(
    kiesProviders(b, { type: "tekst", gegevens: "publiek", nu: NU })
      .volgorde[0],
    "deepseek",
  );
  assertEquals(
    kiesProviders(b, { type: "audio-in", gegevens: "publiek", nu: NU })
      .volgorde,
    ["lovable", "gemini"],
  );
});

Deno.test("vast: geen voorrang, maar de uitsluiting blijft", () => {
  const b = beleid({
    voorrang: [{ ...beslist, provider: "anthropic" }],
    toelatingen: beleid().toelatingen.map((t) =>
      t.provider === "deepseek" && t.gegevens === "persoon"
        ? { ...t, status: "uitgesloten" as const }
        : t
    ),
  });
  const u = kiesProviders(b, {
    type: "tekst",
    gegevens: "persoon",
    vast: true,
    volgorde: ["deepseek", "gemini"],
    nu: NU,
  });
  assertEquals(u.volgorde, ["gemini"]);
  assertEquals(u.voorrang, []);
});

Deno.test("uitsluiting per soort gegevens wint van voorrang", () => {
  const b = beleid({
    voorrang: [{ ...beslist, provider: "deepseek" }],
    toelatingen: beleid().toelatingen.map((t) =>
      t.provider === "deepseek" && t.gegevens === "gezondheid"
        ? { ...t, status: "uitgesloten" as const }
        : t
    ),
  });
  const u = kiesProviders(b, { type: "tekst", gegevens: "gezondheid", nu: NU });
  assert(!u.volgorde.includes("deepseek"));
});

Deno.test("een projecttoelating gaat voor de algemene, tot geldig_tot", () => {
  const algemeen = beleid().toelatingen.map((t) =>
    t.provider === "deepseek" && t.gegevens === "gezondheid"
      ? { ...t, status: "uitgesloten" as const }
      : t
  );
  const b = beleid({
    toelatingen: [
      ...algemeen,
      {
        ...beslist,
        provider: "deepseek",
        gegevens: "gezondheid",
        project: "foodie",
        status: "testfase",
        geldig_tot: "2026-12-31",
      },
    ],
  });
  assertEquals(
    geldendeToelating(b, "deepseek", "gezondheid", "foodie", NU).status,
    "testfase",
  );
  assertEquals(
    geldendeToelating(b, "deepseek", "gezondheid", "eendje", NU).status,
    "uitgesloten",
  );
  const na = geldendeToelating(
    b,
    "deepseek",
    "gezondheid",
    "foodie",
    new Date("2027-01-02"),
  );
  assertEquals(na.status, "uitgesloten");
  assert(na.verlopen);
});

Deno.test("geen toelating = uitgesloten", () => {
  const b = beleid({ toelatingen: [] });
  const e = assertThrows(
    () => kiesProviders(b, { type: "tekst", gegevens: "publiek", nu: NU }),
    BeleidLeeg,
  );
  assertEquals(e.stap, "uitsluiting");
});

Deno.test("toestemming_vereist: enkel als de aanroep toestemming meegeeft", () => {
  const b = beleid({
    toelatingen: beleid().toelatingen.map((t) =>
      t.provider === "deepseek" && t.gegevens === "gezondheid"
        ? { ...t, toestemming_vereist: true }
        : t
    ),
  });
  assert(
    !kiesProviders(b, { type: "tekst", gegevens: "gezondheid", nu: NU })
      .volgorde
      .includes("deepseek"),
  );
  assert(
    kiesProviders(b, {
      type: "tekst",
      gegevens: "gezondheid",
      toestemming: ["deepseek"],
      nu: NU,
    }).volgorde.includes("deepseek"),
  );
});

Deno.test("verwerkerscontext: enkel aan de klant gemelde providers", () => {
  const b = beleid({
    contexten: {
      roundbook: {
        omschrijving: "t",
        providers: [
          { provider: "gemini", gemeld_aan_klant: "2026-10-28" },
          { provider: "lovable", gemeld_aan_klant: "2026-10-28" },
        ],
      },
    },
    voorrang: [{ ...beslist, provider: "anthropic" }],
  });
  const u = kiesProviders(b, {
    type: "tekst",
    gegevens: "persoon",
    context: "roundbook",
    nu: NU,
  });
  assertEquals(u.volgorde, ["gemini", "lovable"]);
  // Een onbekende context sluit alles uit in plaats van stil door te laten.
  const e = assertThrows(
    () =>
      kiesProviders(b, {
        type: "tekst",
        gegevens: "persoon",
        context: "tikfout",
        nu: NU,
      }),
    BeleidLeeg,
  );
  assertEquals(e.stap, "verwerkerscontext");
});

Deno.test("projectcontext geldt als standaard", () => {
  const b = beleid({
    contexten: {
      rb: {
        omschrijving: "t",
        providers: [{ provider: "lovable", gemeld_aan_klant: "x" }],
      },
    },
    projecten: { rb: { gegevens: "persoon", context: "rb" } },
  });
  assertEquals(
    kiesProviders(b, { type: "tekst", project: "rb", nu: NU }).volgorde,
    ["lovable"],
  );
});

Deno.test("projectverbod: nooit, ook niet als terugval", () => {
  const b = beleid({
    projecten: {
      foodie: {
        gegevens: "gezondheid",
        verboden: [{ ...beslist, provider: "deepseek" }],
      },
    },
  });
  const u = kiesProviders(b, { type: "tekst", project: "foodie", nu: NU });
  assertEquals(u.volgorde, ["gemini", "anthropic", "lovable"]);
  assertEquals(u.gegevens, "gezondheid");
  assertEquals(u.gegevensBron, "project");
});

Deno.test("projectverbod per type laat andere types met rust", () => {
  const b = beleid({
    projecten: {
      x: {
        gegevens: "publiek",
        verboden: [{ ...beslist, provider: "gemini", types: ["audio-in"] }],
      },
    },
  });
  assert(
    kiesProviders(b, { type: "tekst", project: "x", nu: NU }).volgorde.includes(
      "gemini",
    ),
  );
  assertEquals(
    kiesProviders(b, { type: "audio-in", project: "x", nu: NU }).volgorde,
    ["lovable"],
  );
});

Deno.test("witte lijst zacht: zo ver als mogelijk", () => {
  const b = beleid({
    projecten: {
      x: {
        gegevens: "publiek",
        wittelijst: {
          ...beslist,
          providers: ["mistral", "anthropic"],
          modus: "zacht",
        },
      },
    },
  });
  // Tekst: enkel wat op de lijst staat en het type kan.
  assertEquals(
    kiesProviders(b, { type: "tekst", project: "x", nu: NU }).volgorde,
    ["anthropic"],
  );
  // Audio kan niemand van de lijst: de gewone kandidaten, met een waarschuwing.
  const u = kiesProviders(b, { type: "audio-in", project: "x", nu: NU });
  assertEquals(u.volgorde, ["gemini", "lovable"]);
  assert(u.waarschuwingen.some((w) => w.includes("witte lijst")));
});

Deno.test("witte lijst strikt: faalt als niemand van de lijst het kan", () => {
  const b = beleid({
    projecten: {
      x: {
        gegevens: "publiek",
        wittelijst: { ...beslist, providers: ["anthropic"], modus: "strikt" },
      },
    },
  });
  const e = assertThrows(
    () => kiesProviders(b, { type: "audio-in", project: "x", nu: NU }),
    BeleidLeeg,
  );
  assertEquals(e.stap, "witte lijst");
  assert(e.message.includes("witte lijst"));
});

Deno.test("projectvoorrang gaat voor globale voorrang", () => {
  const b = beleid({
    voorrang: [
      { ...beslist, provider: "anthropic" },
      { ...beslist, provider: "lovable", project: "x" },
    ],
    projecten: { x: { gegevens: "publiek" } },
  });
  assertEquals(
    kiesProviders(b, { type: "tekst", project: "x", nu: NU }).volgorde.slice(
      0,
      2,
    ),
    ["lovable", "anthropic"],
  );
});

Deno.test("provider uit: overal weg, ook bij vast", () => {
  const b = beleid();
  b.providers.anthropic.uit = { ...beslist, reden: "account geblokt" };
  const u = kiesProviders(b, {
    type: "tekst",
    gegevens: "publiek",
    vast: true,
    volgorde: ["anthropic", "deepseek"],
    nu: NU,
  });
  assertEquals(u.volgorde, ["deepseek"]);
});

Deno.test("capaciteit en pakket filteren eerst", () => {
  const u = kiesProviders(beleid(), {
    type: "tekst",
    gegevens: "publiek",
    volgorde: ["mistral", "deepseek"],
    pakket: ["deepseek", "anthropic"],
    nu: NU,
  });
  assertEquals(u.volgorde, ["deepseek"]);
  assertEquals(u.stappen[0].weg[0].provider, "mistral");
});

Deno.test("de fout zegt welke stap de lijst leegmaakte", () => {
  const e = assertThrows(
    () =>
      kiesProviders(beleid(), {
        type: "tekst",
        gegevens: "publiek",
        heeftSleutel: () => false,
        nu: NU,
      }),
    BeleidLeeg,
  );
  assertEquals(e.stap, "sleutel");
  assert(e.message.includes('stap "sleutel"'));
});

Deno.test("tegoed op komt na de sleutel", () => {
  const e = assertThrows(
    () =>
      kiesProviders(beleid(), {
        type: "tekst",
        gegevens: "publiek",
        volgorde: ["anthropic"],
        tegoedOp: (p) => p === "anthropic",
        nu: NU,
      }),
    BeleidLeeg,
  );
  assertEquals(e.stap, "tegoed op");
});

Deno.test("zonder gegevens-label: projectstandaard, anders persoon met waarschuwing", () => {
  const u = kiesProviders(beleid(), { type: "tekst", nu: NU });
  assertEquals(u.gegevens, "persoon");
  assertEquals(u.gegevensBron, "standaard");
  assert(u.waarschuwingen.length > 0);
});

Deno.test("voorrangActief: een kale datum telt de hele dag", () => {
  const v = { ...beslist, provider: "x", van: "2026-11-01", tot: "2026-11-30" };
  assert(voorrangActief(v, new Date("2026-11-30T22:00:00Z")));
  assert(!voorrangActief(v, new Date("2026-12-01T00:30:00Z")));
  assert(!voorrangActief(v, new Date("2026-10-31T23:00:00Z")));
});

Deno.test("valideerBeleid weigert een kapot bestand", () => {
  assertThrows(() => valideerBeleid({}), TypeError);
  assertThrows(() => valideerBeleid({ ...beleid(), schema: 2 }), TypeError);
  const kapot = beleid();
  kapot.toelatingen = [{
    ...beslist,
    provider: "x",
    gegevens: "geheim" as never,
    status: "testfase",
  }];
  assertThrows(() => valideerBeleid(kapot), TypeError);
});

Deno.test("momentopname is gelijk aan het beleidsbestand", async () => {
  const json = JSON.parse(
    await Deno.readTextFile(
      new URL("./beleid/ai-beleid.json", import.meta.url),
    ),
  );
  assertEquals(AI_BELEID, json);
  valideerBeleid(AI_BELEID);
});

// --- Het echte startbeleid: de beslissingen van 1 nov 2026 ------------------------------

Deno.test("startbeleid: Claude vooraan voor tekst, tot het einde van de voorrang", () => {
  const u = kiesProviders(AI_BELEID, {
    type: "tekst",
    project: "eendje",
    nu: NU,
  });
  assertEquals(u.volgorde, ["anthropic", "gemini", "lovable", "deepseek"]);
});

Deno.test("startbeleid: Foodie mag DeepSeek (testfase), Eendje-gezondheid niet", () => {
  assert(
    kiesProviders(AI_BELEID, { type: "tekst", project: "foodie", nu: NU })
      .volgorde
      .includes("deepseek"),
  );
  assert(
    !kiesProviders(AI_BELEID, {
      type: "tekst",
      project: "eendje",
      gegevens: "gezondheid",
      nu: NU,
    }).volgorde.includes("deepseek"),
  );
});

Deno.test("startbeleid: Foodie-DeepSeek slaat om na geldig_tot", () => {
  const u = kiesProviders(AI_BELEID, {
    type: "tekst",
    project: "foodie",
    nu: new Date("2027-05-02T12:00:00Z"),
  });
  assert(!u.volgorde.includes("deepseek"));
});

Deno.test("startbeleid: Roundbook-context = enkel gemini en Lovable, nooit Claude of DeepSeek", () => {
  const u = kiesProviders(AI_BELEID, {
    type: "tekst",
    project: "shintaka",
    gegevens: "persoon",
    context: "roundbook",
    nu: NU,
  });
  assertEquals(u.volgorde, ["gemini", "lovable"]);
});

Deno.test("startbeleid: persoonsgegevens nooit naar DeepSeek", () => {
  const u = kiesProviders(AI_BELEID, {
    type: "tekst",
    project: "billara",
    nu: NU,
  });
  assert(!u.volgorde.includes("deepseek"));
});

Deno.test("noodbeleid: gezondheid enkel naar Claude, spraak faalt liever", () => {
  assertEquals(
    kiesProviders(NOODBELEID, { type: "tekst", gegevens: "gezondheid", nu: NU })
      .volgorde,
    ["anthropic"],
  );
  assertThrows(
    () =>
      kiesProviders(NOODBELEID, {
        type: "audio-in",
        gegevens: "gezondheid",
        nu: NU,
      }),
    BeleidLeeg,
  );
});

Deno.test("TARIEVEN kent Sonnet en Opus, ook in de ruwe Anthropic-vorm", () => {
  const s = schatUsd("claude-sonnet-5-5", {
    input_tokens: 1_000_000,
    output_tokens: 100_000,
  });
  assertEquals(s.geschat, false);
  assertEquals(Math.round(s.usd * 100) / 100, 3);
  assertEquals(
    schatUsd("claude-opus-5-5", { prompt_tokens: 1_000_000 }).usd,
    4,
  );
});
