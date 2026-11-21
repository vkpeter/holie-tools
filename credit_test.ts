import { assertEquals } from "@std/assert";
import {
  CREDIT_TEKSTEN,
  creditTaal,
  HOLIE_URL,
  holieCredit,
} from "./credit.ts";

Deno.test("credit: eigen product in vier talen", () => {
  assertEquals(holieCredit("eigen", "nl").tekst, "Gemaakt door holie.be");
  assertEquals(holieCredit("eigen", "fr").tekst, "Réalisé par holie.be");
  assertEquals(holieCredit("eigen", "de").tekst, "Entwickelt von holie.be");
  assertEquals(holieCredit("eigen", "en").tekst, "Built by holie.be");
});

Deno.test("credit: klantsite in vier talen", () => {
  assertEquals(holieCredit("klant", "nl").tekst, "Website door holie.be");
  assertEquals(holieCredit("klant", "fr").tekst, "Site réalisé par holie.be");
  assertEquals(holieCredit("klant", "de").tekst, "Website von holie.be");
  assertEquals(holieCredit("klant", "en").tekst, "Website by holie.be");
});

Deno.test("credit: link is altijd holie.be", () => {
  assertEquals(HOLIE_URL, "https://holie.be");
  for (const soort of ["eigen", "klant"] as const) {
    for (const taal of Object.keys(CREDIT_TEKSTEN[soort])) {
      assertEquals(holieCredit(soort, taal).href, "https://holie.be");
    }
  }
});

Deno.test("credit: taalcode wordt genormaliseerd, onbekend wordt en", () => {
  assertEquals(creditTaal("nl-BE"), "nl");
  assertEquals(creditTaal("FR_fr"), "fr");
  assertEquals(creditTaal(" de "), "de");
  assertEquals(creditTaal("zz"), "en");
  assertEquals(creditTaal(undefined), "en");
  assertEquals(holieCredit("eigen").tekst, "Built by holie.be");
});

Deno.test("credit: extra talen enkel voor eigen product, klantsite valt terug op en", () => {
  assertEquals(holieCredit("eigen", "es").tekst, "Creado por holie.be");
  assertEquals(holieCredit("eigen", "tr").tekst, "holie.be tarafından yapıldı");
  assertEquals(holieCredit("eigen", "ja").tekst, "holie.be 制作");
  assertEquals(holieCredit("klant", "es").tekst, "Website by holie.be");
});
