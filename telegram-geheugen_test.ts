import { assert, assertEquals } from "@std/assert";
import {
  GEHEUGEN_INSTRUCTIE,
  GEHEUGEN_MAX_TEKST,
  geheugenPrompt,
  geldigeOnafBerichten,
} from "./telegram.ts";

const NU = Date.parse("2026-11-01T12:00:00Z");
const min = (n: number) => NU - n * 60 * 1000;

Deno.test("geheugenPrompt: zonder eerdere berichten blijft het nieuwe bericht ongewijzigd", () => {
  assertEquals(geheugenPrompt([], "bel Jan", { nu: NU }), "bel Jan");
});

Deno.test("geheugenPrompt: het gesprek van 1 nov 2026, nummer en naam vullen het belverzoek aan", () => {
  const p = geheugenPrompt(
    [
      {
        tekst: "Bel mij vertel hoe het weer is",
        antwoord: "Op welk nummer moet ik je bellen?",
        op: min(3),
      },
      {
        tekst: "+32499301563",
        antwoord: "Wat wil je dat Isabel zegt?",
        op: new Date(min(2)),
      },
    ],
    "Ik ben peter",
    { nu: NU },
  );
  const regels = p.split("\n");
  assert(regels[1].startsWith('1. Gebruiker: "Bel mij'));
  assert(regels[1].includes('Jij vroeg: "Op welk nummer'));
  assert(regels[2].startsWith('2. Gebruiker: "+32499301563"'));
  assertEquals(regels.at(-1), "Nieuw bericht: Ik ben peter");
});

Deno.test("geldigeOnafBerichten: te oud, in de toekomst of onleesbaar valt weg; oudste eerst; hoogstens max", () => {
  const b = geldigeOnafBerichten([
    { tekst: "d", op: new Date(min(1)).toISOString() },
    { tekst: "oud", op: min(11) },
    { tekst: "a", op: min(9) },
    { tekst: "toekomst", op: NU + 60_000 },
    { tekst: "kapot", op: "geen datum" },
    { tekst: "c", op: min(4) },
    { tekst: "b", op: min(5) },
  ], { nu: NU });
  assertEquals(b.map((x) => x.tekst), ["b", "c", "d"]);
  assertEquals(
    geldigeOnafBerichten([{ tekst: "x", op: min(20) }], {
      nu: NU,
      geldigMs: 30 * 60_000,
    }).length,
    1,
  );
});

Deno.test("geheugenPrompt: lange tekst wordt afgeknipt, aanhalingstekens blijven ingepakt", () => {
  const p = geheugenPrompt(
    [{ tekst: `zeg "hoi"\n${"x".repeat(900)}`, op: min(1) }],
    "ja",
    { nu: NU },
  );
  assert(p.includes('\\"hoi\\"'));
  assert(!p.includes("x".repeat(GEHEUGEN_MAX_TEKST + 1)));
  assert(p.includes("…"));
});

Deno.test("GEHEUGEN_INSTRUCTIE: zegt dat een volledig nieuw verzoek het oude negeert", () => {
  assert(GEHEUGEN_INSTRUCTIE.includes("negeer dan de eerdere berichten"));
  assert(!GEHEUGEN_INSTRUCTIE.includes("—"));
});
