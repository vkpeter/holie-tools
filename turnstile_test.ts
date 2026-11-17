import { assertEquals } from "@std/assert";
import { turnstileSitekey } from "./turnstile.ts";

const KEY = "0x4AAAAAAF766d64sDmIlxtt";

function zonderLog<T>(f: () => T): { uit: T; meldingen: number } {
  const orig = console.error;
  let meldingen = 0;
  console.error = () => meldingen++;
  try {
    return { uit: f(), meldingen };
  } finally {
    console.error = orig;
  }
}

Deno.test("geldige sleutel blijft ongewijzigd", () => {
  assertEquals(turnstileSitekey(KEY), KEY);
});

Deno.test("witruimte en aanhalingstekens vallen weg", () => {
  for (
    const raw of [
      `'${KEY}'`,
      `"${KEY}"`,
      `  ${KEY}\n`,
      ` "'${KEY}'" `,
      `“${KEY}”`,
    ]
  ) {
    assertEquals(turnstileSitekey(raw), KEY, raw);
  }
});

Deno.test("leeg of ontbrekend: terugval of uit, zonder melding", () => {
  const r = zonderLog(() => [
    turnstileSitekey(undefined),
    turnstileSitekey(""),
    turnstileSitekey("   "),
    turnstileSitekey(undefined, KEY),
    turnstileSitekey("''", KEY),
  ]);
  assertEquals(r.uit, ["", "", "", KEY, KEY]);
  assertEquals(r.meldingen, 0);
});

Deno.test("ongeldige waarde: console.error en widget uit", () => {
  const r = zonderLog(() => turnstileSitekey("niet-een-sleutel"));
  assertEquals(r.uit, "");
  assertEquals(r.meldingen, 1);
  const kort = zonderLog(() => turnstileSitekey("0xabc"));
  assertEquals(kort.uit, "");
  assertEquals(kort.meldingen, 1);
});

Deno.test("ongeldige waarde met geldige terugval: terugval, wel een melding", () => {
  const r = zonderLog(() => turnstileSitekey("kapot", `'${KEY}'`));
  assertEquals(r.uit, KEY);
  assertEquals(r.meldingen, 1);
});

Deno.test("ongeldige terugval wordt genegeerd", () => {
  assertEquals(turnstileSitekey(undefined, "kapot"), "");
});
