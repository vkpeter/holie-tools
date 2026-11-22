import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  besluitUitgave,
  brusselsMoment,
  eersteWoord,
  getallenUit,
  heeftEmoji,
  isoWeek,
  keurNieuwsbrief,
  MAX_HTML_BYTES,
  type NieuwsbriefPoortInvoer,
  politiekGevoelig,
} from "./nieuwsbrief-poort.ts";
import { uitschrijfKoppen } from "./nieuwsbrief.ts";

const URL = "https://api.example.com/functions/v1/uitschrijven?id=1&code=abc";

function goed(): NieuwsbriefPoortInvoer {
  return {
    onderwerp: "60 minuten tuinieren is 3 tot 5,5 km wandelen",
    koppen: ["60 minuten tuinieren is 3 tot 5,5 km wandelen"],
    inhoudTekst: ["Dat kost 140 tot 340 kcal."],
    toegelatenGetallen: [60, 3, "5,5", 140, 340],
    html: `<p>mail</p><a href="${
      URL.replaceAll("&", "&amp;")
    }">Uitschrijven</a>`,
    headers: uitschrijfKoppen(URL),
    uitschrijfUrl: URL,
  };
}

Deno.test("een nette mail komt door de poort", () => {
  const u = keurNieuwsbrief(goed());
  assertEquals(u.fouten, []);
  assert(u.ok);
});

Deno.test("onderwerp: labelwoord, emoji, geen getal, te lang", () => {
  for (
    const o of [
      "Ontdek 60 minuten tuinieren",
      "Geniet van 60 minuten",
      "Even 60 minuten",
      "Lekker 60 minuten",
      "Nieuwe 60 minuten",
    ]
  ) {
    const u = keurNieuwsbrief({
      ...goed(),
      onderwerp: o,
      toegelatenGetallen: [60],
    });
    assertFalse(u.ok, o);
    assert(u.fouten.some((f) => f.includes("labelwoord")), o);
  }
  assert(
    keurNieuwsbrief({ ...goed(), onderwerp: "60 minuten tuinieren 🌿" }).fouten
      .some((f) => f.includes("emoji")),
  );
  assert(
    keurNieuwsbrief({ ...goed(), onderwerp: "Tuinieren is 60 minuten" }).fouten
      .some((f) => f.includes("begint niet met een getal")),
  );
  assertEquals(
    keurNieuwsbrief({
      ...goed(),
      onderwerp: "Tuinieren is 60 minuten",
      onderwerpBegintMetGetal: false,
    }).ok,
    true,
  );
  assert(
    keurNieuwsbrief({ ...goed(), onderwerp: "60 " + "x".repeat(80) }).fouten
      .some((f) => f.includes("langer dan")),
  );
});

Deno.test("lopende tekst: ook daar geen emoji", () => {
  const u = keurNieuwsbrief({
    ...goed(),
    inhoudTekst: ["Dat kost 140 kcal \u{1F33F}"],
  });
  assert(u.fouten.some((f) => f.includes("tekst bevat een emoji")));
});

Deno.test("koppen: labelwoord en emoji", () => {
  const u = keurNieuwsbrief({
    ...goed(),
    koppen: ["Ontdek de tuin", "Rekensom ✅"],
  });
  assert(u.fouten.some((f) => f.includes("labelwoord 'ontdek'")));
  assert(u.fouten.some((f) => f.includes("emoji")));
});

Deno.test("getallen moeten letterlijk uit de bron komen, komma of punt maakt niet uit", () => {
  assert(
    keurNieuwsbrief({ ...goed(), inhoudTekst: ["Dat kost 150 kcal."] }).fouten
      .some((f) => f.includes("getal 150")),
  );
  assertEquals(
    keurNieuwsbrief({ ...goed(), inhoudTekst: ["Dat is 5.5 km."] }).ok,
    true,
  );
  assertEquals(
    keurNieuwsbrief({ ...goed(), inhoudTekst: ["Dat is 5,50 km."] }).ok,
    true,
  );
  assertEquals(
    keurNieuwsbrief({
      ...goed(),
      inhoudTekst: ["Dat is 1.200 kcal."],
      toegelatenGetallen: [60, 3, "5,5", 1200],
    }).ok,
    true,
  );
  // een getal in een kop telt ook
  assertFalse(keurNieuwsbrief({ ...goed(), koppen: ["61 minuten"] }).ok);
});

Deno.test("uitschrijflink: in de mail, in List-Unsubscribe en one-click", () => {
  assert(
    keurNieuwsbrief({ ...goed(), html: "<p>mail</p>" }).fouten.some((f) =>
      f.includes("niet in de mail")
    ),
  );
  assert(
    keurNieuwsbrief({ ...goed(), headers: {} }).fouten.some((f) =>
      f.includes("List-Unsubscribe-header ontbreekt")
    ),
  );
  assert(
    keurNieuwsbrief({
      ...goed(),
      headers: {
        "list-unsubscribe": "<https://x.test/a>",
        "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      },
    }).fouten.some((f) => f.includes("wijst niet")),
  );
  const zonderPost = { "List-Unsubscribe": `<${URL}>` };
  assert(
    keurNieuwsbrief({ ...goed(), headers: zonderPost }).fouten.some((f) =>
      f.includes("one-click")
    ),
  );
  assert(
    keurNieuwsbrief({ ...goed(), uitschrijfUrl: "" }).fouten.some((f) =>
      f.includes("uitschrijflink ontbreekt")
    ),
  );
  // hoofdletters in de headernaam maken niet uit
  assertEquals(
    keurNieuwsbrief({
      ...goed(),
      headers: {
        "LIST-UNSUBSCRIBE": `<${URL}>`,
        "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      },
    }).ok,
    true,
  );
});

Deno.test("headerUrl: een eigen one-click-eindpunt naast de zichtbare link", () => {
  const eindpunt =
    "https://api.example.com/functions/v1/newsletter/unsubscribe?id=1&code=abc";
  const invoer = {
    ...goed(),
    headers: uitschrijfKoppen(eindpunt),
    headerUrl: eindpunt,
  };
  assertEquals(keurNieuwsbrief(invoer).fouten, []);
  // zonder headerUrl moet de header de zichtbare link bevatten
  assert(
    keurNieuwsbrief({ ...invoer, headerUrl: undefined }).fouten.some((f) =>
      f.includes("wijst niet")
    ),
  );
});

Deno.test("HTML boven de grens en sjabloonresten worden geweigerd", () => {
  const groot = goed().html + "x".repeat(MAX_HTML_BYTES);
  assert(
    keurNieuwsbrief({ ...goed(), html: groot }).fouten.some((f) =>
      f.includes("bytes")
    ),
  );
  for (
    const rest of [
      "${merk.kleur}",
      "{{naam}}",
      "undefined",
      "[object Object]",
      "NaN",
    ]
  ) {
    const u = keurNieuwsbrief({ ...goed(), html: goed().html + rest });
    assert(u.fouten.some((f) => f.includes("sjabloonrest")), rest);
  }
  // meetellen in bytes, niet in tekens: een eigen grens
  assertFalse(keurNieuwsbrief({ ...goed(), maxHtmlBytes: 10 }).ok);
});

Deno.test("politiek geladen termen worden geweigerd", () => {
  for (
    const t of [
      "Gaza",
      "Oekraïne",
      "Rusland",
      "Taiwan",
      "Krim",
      "Tibet",
      "Kasjmir",
    ]
  ) {
    assert(politiekGevoelig(`Een wandeling in ${t}`) !== null, t);
  }
  assertEquals(politiekGevoelig("Een wandeling door Quedlinburg"), null);
  assertEquals(politiekGevoelig("kievit"), null);
  const u = keurNieuwsbrief({
    ...goed(),
    inhoudTekst: ["Dat is 3 km in Gaza."],
  });
  assert(u.fouten.some((f) => f.includes("politiek")));
});

Deno.test("emoji en eerste woord", () => {
  assert(heeftEmoji("hoi 🌿"));
  assert(heeftEmoji("🇧🇪"));
  assert(heeftEmoji("ok ✅"));
  assertFalse(heeftEmoji("60 minuten, 5,5 km - klaar."));
  assertEquals(eersteWoord("  «Ontdek» de tuin"), "ontdek");
  assertEquals(eersteWoord("60 minuten"), "minuten");
  assertEquals(getallenUit("1.200 kcal en 5,5 km, 60 min"), [
    "1.200",
    "5,5",
    "60",
  ]);
});

Deno.test("besluit: overslaan is een goede uitkomst", () => {
  const ok = { ok: true, fouten: [] };
  assertEquals(
    besluitUitgave({ heeftInhoud: false, poort: null, bevestigd: 99 }).actie,
    "overslaan",
  );
  assertEquals(
    besluitUitgave({ heeftInhoud: true, poort: null, bevestigd: 99 }).actie,
    "overslaan",
  );
  const geweigerd = besluitUitgave({
    heeftInhoud: true,
    poort: { ok: false, fouten: ["emoji"] },
    bevestigd: 99,
  });
  assertEquals(geweigerd.actie, "overslaan");
  assert(geweigerd.reden.includes("emoji"));
  assertEquals(
    besluitUitgave({ heeftInhoud: true, poort: ok, bevestigd: 99 }).actie,
    "verzenden",
  );
});

Deno.test("besluit: onder de drempel enkel droog, de drempel is instelbaar", () => {
  const ok = { ok: true, fouten: [] };
  assertEquals(
    besluitUitgave({ heeftInhoud: true, poort: ok, bevestigd: 24 }).actie,
    "droog",
  );
  assertEquals(
    besluitUitgave({ heeftInhoud: true, poort: ok, bevestigd: 25 }).actie,
    "verzenden",
  );
  assertEquals(
    besluitUitgave({ heeftInhoud: true, poort: ok, bevestigd: 3 }).actie,
    "droog",
  );
  assertEquals(
    besluitUitgave({ heeftInhoud: true, poort: ok, bevestigd: 3, drempel: 3 })
      .actie,
    "verzenden",
  );
  // een kapotte drempel valt dicht
  assertEquals(
    besluitUitgave({ heeftInhoud: true, poort: ok, bevestigd: 500, drempel: 0 })
      .actie,
    "droog",
  );
  assertEquals(
    besluitUitgave({
      heeftInhoud: true,
      poort: ok,
      bevestigd: 500,
      drempel: Number.NaN,
    }).actie,
    "droog",
  );
});

Deno.test("brusselsMoment houdt rekening met zomer- en wintertijd", () => {
  // woensdag 25 nov 2026, 16:00 UTC = 17:00 Brussel (winter)
  assertEquals(brusselsMoment(new Date("2026-11-25T16:00:00Z")), {
    weekdag: 3,
    uur: 17,
    datum: "2026-11-25",
  });
  // woensdag 17 jun 2026, 15:00 UTC = 17:00 Brussel (zomer)
  assertEquals(brusselsMoment(new Date("2026-06-17T15:00:00Z")), {
    weekdag: 3,
    uur: 17,
    datum: "2026-06-17",
  });
  // dinsdagavond 23:30 UTC is al woensdag 00:30 in Brussel
  assertEquals(brusselsMoment(new Date("2026-11-24T23:30:00Z")).weekdag, 3);
});

Deno.test("isoWeek", () => {
  assertEquals(isoWeek("2026-11-25"), "2026-W48");
  assertEquals(isoWeek("2026-01-01"), "2026-W01");
  assertEquals(isoWeek("2027-01-01"), "2026-W53");
});
