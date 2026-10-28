import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { createHash, createHmac } from "node:crypto";
import {
  CODE_BYTES,
  controleerUitschrijfcode,
  hashCode,
  KORTE_CODE_ALFABET,
  KORTE_CODE_LENGTE,
  leesKorteCode,
  maakCode,
  maakKorteCode,
  maakUitschrijfcode,
  UITSCHRIJFCODE_LENGTE,
} from "./codes.ts";
import { geheimenGelijk } from "./auth.ts";

// Verzonnen geheim: nooit een echt geheim in dit pakket.
const GEHEIM = "test-geheim-niet-echt-0123456789abcdef";

// ───────────── Eenmalige codes ─────────────

Deno.test("maakCode: 43 tekens base64url en de sha256 erbij", async () => {
  const { code, hash } = await maakCode();
  assertEquals(CODE_BYTES, 32);
  assertEquals(code.length, 43);
  assert(/^[A-Za-z0-9_-]{43}$/.test(code));
  assertEquals(hash, createHash("sha256").update(code).digest("hex"));
  assertEquals(hash, await hashCode(code));
});

Deno.test("maakCode: elke code is anders", async () => {
  const gezien = new Set<string>();
  for (let i = 0; i < 200; i++) gezien.add((await maakCode()).code);
  assertEquals(gezien.size, 200);
});

Deno.test("maakCode: grenzen op het aantal bytes", async () => {
  assertEquals((await maakCode({ bytes: 16 })).code.length, 22);
  assertEquals((await maakCode({ bytes: 48 })).code.length, 64);
  for (const n of [0, 8, 15, 49, 1.5, Number.NaN]) {
    await assertRejects(() => maakCode({ bytes: n }), RangeError);
  }
});

Deno.test("hashCode: exact over de tekst, zonder normalisatie", async () => {
  assertEquals(
    await hashCode("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertNotEquals(await hashCode("abc"), await hashCode("ABC"));
  assertNotEquals(await hashCode("abc"), await hashCode(" abc"));
});

Deno.test("maakKorteCode: 8 tekens uit het alfabet, zonder 0/O/1/I", async () => {
  assertEquals(KORTE_CODE_ALFABET.length, 32);
  for (const verboden of ["0", "O", "1", "I"]) {
    assert(!KORTE_CODE_ALFABET.includes(verboden));
  }
  for (let i = 0; i < 100; i++) {
    const { code, hash } = await maakKorteCode();
    assertEquals(code.length, KORTE_CODE_LENGTE);
    assertEquals(leesKorteCode(code), code);
    assertEquals(hash, await hashCode(code));
  }
  await assertRejects(() => maakKorteCode({ lengte: 5 }), RangeError);
  await assertRejects(() => maakKorteCode({ lengte: 33 }), RangeError);
});

Deno.test("leesKorteCode: getypte invoer", () => {
  assertEquals(leesKorteCode("abcd-2345"), "ABCD2345");
  assertEquals(leesKorteCode(" abcd 2345 "), "ABCD2345");
  assertEquals(leesKorteCode("ABCD234"), null);
  assertEquals(leesKorteCode("ABCD23456"), null);
  assertEquals(leesKorteCode("ABCD0345"), null);
  assertEquals(leesKorteCode("ABCDI345"), null);
  assertEquals(leesKorteCode("ABCD234É"), null);
  assertEquals(leesKorteCode(12345678), null);
  assertEquals(leesKorteCode("A".repeat(65)), null);
  assertEquals(leesKorteCode("ABCDEF", 6), "ABCDEF");
});

// ───────────── Uitschrijfcode ─────────────

Deno.test("maakUitschrijfcode: HMAC-SHA256 over lijst:adres, 43 tekens", async () => {
  const code = await maakUitschrijfcode(
    GEHEIM,
    "nieuwsbrief",
    "jan@example.be",
  );
  assertEquals(code.length, UITSCHRIJFCODE_LENGTE);
  assertEquals(
    code,
    createHmac("sha256", GEHEIM).update("nieuwsbrief:jan@example.be").digest(
      "base64url",
    ),
  );
});

Deno.test("maakUitschrijfcode: adres zonder hoofdletters en spaties", async () => {
  assertEquals(
    await maakUitschrijfcode(GEHEIM, "nieuwsbrief", " Jan@Example.BE "),
    await maakUitschrijfcode(GEHEIM, "nieuwsbrief", "jan@example.be"),
  );
});

Deno.test("maakUitschrijfcode: gooit bij een zwak geheim of rare lijst", async () => {
  for (const geheim of ["", "kort", "a".repeat(31)]) {
    await assertRejects(() =>
      maakUitschrijfcode(geheim, "nieuwsbrief", "a@b.be")
    );
  }
  for (
    const lijst of [
      "",
      "Nieuwsbrief",
      "nieuws:brief",
      "a".repeat(33),
      "lijst met spatie",
    ]
  ) {
    await assertRejects(() => maakUitschrijfcode(GEHEIM, lijst, "a@b.be"));
  }
});

Deno.test("controleerUitschrijfcode: klopt voor dezelfde lijst en hetzelfde adres", async () => {
  const code = await maakUitschrijfcode(
    GEHEIM,
    "herinneringen",
    "jan@example.be",
  );
  assert(
    await controleerUitschrijfcode(
      GEHEIM,
      "herinneringen",
      "JAN@example.be",
      code,
    ),
  );
});

Deno.test("controleerUitschrijfcode: een andere lijst, een ander adres of geheim telt niet", async () => {
  const code = await maakUitschrijfcode(
    GEHEIM,
    "herinneringen",
    "jan@example.be",
  );
  assertEquals(
    await controleerUitschrijfcode(
      GEHEIM,
      "nieuwsbrief",
      "jan@example.be",
      code,
    ),
    false,
  );
  assertEquals(
    await controleerUitschrijfcode(
      GEHEIM,
      "herinneringen",
      "piet@example.be",
      code,
    ),
    false,
  );
  assertEquals(
    await controleerUitschrijfcode(
      GEHEIM + "x",
      "herinneringen",
      "jan@example.be",
      code,
    ),
    false,
  );
});

Deno.test("controleerUitschrijfcode: vaste lengte, afgeknipt of verlengd telt niet", async () => {
  const code = await maakUitschrijfcode(
    GEHEIM,
    "nieuwsbrief",
    "jan@example.be",
  );
  const ok = (c: unknown) =>
    controleerUitschrijfcode(GEHEIM, "nieuwsbrief", "jan@example.be", c);
  for (
    const fout of [
      code.slice(0, 10),
      code.slice(0, 20),
      code.slice(0, 42),
      code + "A",
      code + "=",
      code.slice(0, 42) + "+",
      "",
      null,
      undefined,
      43,
    ]
  ) {
    assertEquals(await ok(fout), false, String(fout));
  }
  // Eén teken anders, vooraan of achteraan.
  const wissel = (c: string, i: number) =>
    c.slice(0, i) + (c[i] === "A" ? "B" : "A") + c.slice(i + 1);
  assertEquals(await ok(wissel(code, 0)), false);
  assertEquals(await ok(wissel(code, 42)), false);
});

Deno.test("controleerUitschrijfcode: valt dicht zonder geheim", async () => {
  const code = await maakUitschrijfcode(
    GEHEIM,
    "nieuwsbrief",
    "jan@example.be",
  );
  for (const geheim of [undefined, null, "", "kort"]) {
    assertEquals(
      await controleerUitschrijfcode(
        geheim,
        "nieuwsbrief",
        "jan@example.be",
        code,
      ),
      false,
    );
  }
  assertEquals(
    await controleerUitschrijfcode(GEHEIM, "nieuwsbrief", "  ", code),
    false,
  );
  assertEquals(
    await controleerUitschrijfcode(
      GEHEIM,
      "nieuws:brief",
      "jan@example.be",
      code,
    ),
    false,
  );
});

// Geen tijdmeting: in de review van 0.18.0 faalde die 1 op 25 keer, en een
// vergelijking die vroeg stopt slaagde er evengoed voor (TextEncoder overheerst
// de tijd). Wat hier wel vast te leggen is: elke plek van een verschil, en een
// verschil in lengte, geeft false, en controleerUitschrijfcode gebruikt
// geheimenGelijk (een code met het verschil vooraan of achteraan faalt hierboven).
Deno.test("constante-tijdvergelijking: geheimenGelijk kijkt naar elke byte", () => {
  const a = "x".repeat(64);
  for (let i = 0; i < a.length; i++) {
    const b = a.slice(0, i) + "y" + a.slice(i + 1);
    assertEquals(geheimenGelijk(a, b), false, `verschil op ${i}`);
  }
  assertEquals(geheimenGelijk(a, a.slice(0, 63)), false);
  assertEquals(geheimenGelijk(a, a + "x"), false);
  assertEquals(geheimenGelijk(a, a), true);
  assertEquals(geheimenGelijk("", ""), true);
  // Meerbytetekens vergelijken op bytes, niet op UTF-16-eenheden.
  assertEquals(geheimenGelijk("é", "e\u0301"), false);
});

// ───────────── Peper ─────────────

const PEPER = "test-peper-niet-echt-0123456789abcdef";

Deno.test("hashCode met peper: HMAC-SHA256 over code:<code>", async () => {
  assertEquals(
    await hashCode("ABCD2345", PEPER),
    createHmac("sha256", PEPER).update("code:ABCD2345").digest("hex"),
  );
  assertNotEquals(
    await hashCode("ABCD2345", PEPER),
    await hashCode("ABCD2345"),
  );
  assertNotEquals(
    await hashCode("ABCD2345", PEPER),
    await hashCode("ABCD2345", PEPER + "x"),
  );
  await assertRejects(() => hashCode("ABCD2345", "kort"));
  await assertRejects(() => hashCode("ABCD2345", ""));
});

Deno.test("maakKorteCode en maakCode met peper", async () => {
  const kort = await maakKorteCode({ peper: PEPER });
  assertEquals(kort.hash, await hashCode(kort.code, PEPER));
  const lang = await maakCode({ peper: PEPER });
  assertEquals(lang.hash, await hashCode(lang.code, PEPER));
  await assertRejects(() => maakKorteCode({ peper: "kort" }));
});

Deno.test("leesKorteCode: enkel ASCII", () => {
  assertEquals(leesKorteCode("ABCDEFß"), null);
  assertEquals(leesKorteCode("ＡＢＣＤ２３４５"), null);
});
