import { assertEquals } from "@std/assert";
import {
  kiesTaal,
  leesCookie,
  normaliseerTaal,
  ontleedAcceptLanguage,
  pasTaal,
} from "./talen.ts";

const TALEN = ["en", "nl", "de", "fr"] as const;
type Lang = typeof TALEN[number];
const kies = (acceptLanguage: string, standaard: Lang = "en") =>
  kiesTaal({ talen: TALEN, standaard, acceptLanguage });

Deno.test("kiesTaal: Accept-Language met q-gewichten", () => {
  assertEquals(kies("nl-BE,nl;q=0.9,en;q=0.8"), "nl");
  assertEquals(kies("de-DE"), "de");
  assertEquals(kies("fr-CH"), "fr");
  assertEquals(kies("es-ES,es"), "en");
  assertEquals(kies("es-ES,es", "nl"), "nl");
  assertEquals(kies(""), "en");
  assertEquals(kies("en-GB,nl;q=0.5", "nl"), "en");
  assertEquals(kies("es;q=1,nl;q=0.4"), "nl");
});

Deno.test("kiesTaal: het gewicht beslist, niet de volgorde", () => {
  assertEquals(kies("de;q=0.3,fr;q=0.9"), "fr");
  // De oude kopieën lazen enkel de eerste ingang en gaven hier de standaard.
  assertEquals(kies("es-ES,nl;q=0.8", "fr"), "nl");
  // Gelijk gewicht: de volgorde van de header.
  assertEquals(kies("de,fr"), "de");
  // q=0 betekent "liever niet".
  assertEquals(kies("nl;q=0,de;q=0.1"), "de");
});

Deno.test("kiesTaal: ruis en hoofdletters", () => {
  assertEquals(kies("  NL-be ; q=0.9 , xx;q=1"), "nl");
  assertEquals(kies("nl;q=abc,de;q=0.5"), "de");
  assertEquals(kies(";;,,"), "en");
  assertEquals(kies("*", "de"), "de");
  assertEquals(kies("es,*;q=0.1,fr;q=0.5"), "fr");
});

Deno.test("kiesTaal: cookie gaat voor, een onbekende cookie valt door", () => {
  const basis = {
    talen: TALEN,
    standaard: "en" as Lang,
    cookieNaam: "ese.lang",
    acceptLanguage: "de-DE,de;q=0.9",
  };
  assertEquals(kiesTaal({ ...basis, cookie: "x=1; ese.lang=fr" }), "fr");
  assertEquals(kiesTaal({ ...basis, cookie: "ese.lang=nl-BE" }), "nl");
  assertEquals(kiesTaal({ ...basis, cookie: "ese.lang=es" }), "de");
  assertEquals(kiesTaal({ ...basis, cookie: "" }), "de");
  assertEquals(kiesTaal({ ...basis, cookie: null }), "de");
  // Een cookie van een andere site telt niet.
  assertEquals(kiesTaal({ ...basis, cookie: "shintaka.lang=fr" }), "de");
  // Zonder cookieNaam wordt de cookie niet gelezen.
  assertEquals(
    kiesTaal({ ...basis, cookieNaam: undefined, cookie: "ese.lang=fr" }),
    "de",
  );
});

Deno.test("kiesTaal: navigator.languages als rij", () => {
  assertEquals(
    kiesTaal({
      talen: TALEN,
      standaard: "en",
      acceptLanguage: ["es-ES", "fr-BE", "nl"],
    }),
    "fr",
  );
  assertEquals(
    kiesTaal({ talen: TALEN, standaard: "nl", acceptLanguage: [] }),
    "nl",
  );
});

Deno.test("ontleedAcceptLanguage sorteert stabiel op gewicht", () => {
  assertEquals(ontleedAcceptLanguage("en;q=0.5, nl-BE, de;q=0.5, fr;q=0"), [
    { tag: "nl-be", q: 1 },
    { tag: "en", q: 0.5 },
    { tag: "de", q: 0.5 },
  ]);
  assertEquals(ontleedAcceptLanguage(undefined), []);
  assertEquals(ontleedAcceptLanguage("nl;q=7"), [{ tag: "nl", q: 1 }]);
});

Deno.test("pasTaal en normaliseerTaal", () => {
  assertEquals(pasTaal("nl-BE", TALEN), "nl");
  assertEquals(pasTaal("nl_BE", TALEN), "nl");
  assertEquals(pasTaal("es", TALEN), undefined);
  assertEquals(pasTaal("", TALEN), undefined);
  // Exacte regiomatch gaat voor, en een hoofdtaal wordt geen regio.
  assertEquals(pasTaal("PT-br", ["pt-BR", "en"]), "pt-BR");
  assertEquals(pasTaal("pt", ["pt-BR", "en"]), undefined);
  // Een 2-letterknip zou "nld" als "nl" lezen; dit niet.
  assertEquals(normaliseerTaal("nld", TALEN, "en"), "en");
  assertEquals(normaliseerTaal("de-AT", TALEN, "en"), "de");
  assertEquals(normaliseerTaal(null, TALEN, "fr"), "fr");
});

Deno.test("leesCookie", () => {
  assertEquals(leesCookie("a=1; ese.lang=nl; b=2", "ese.lang"), "nl");
  assertEquals(leesCookie("ese.lang=nl", "lang"), undefined);
  assertEquals(leesCookie("x.ese.lang=fr; ese.lang=de", "ese.lang"), "de");
  assertEquals(leesCookie('t="fr%2DBE"', "t"), "fr-BE");
  assertEquals(leesCookie("t=%E0%A4%A", "t"), "%E0%A4%A");
  assertEquals(leesCookie(undefined, "t"), undefined);
});
