import { assertEquals } from "@std/assert";
import {
  elisie,
  hoofdletter,
  openPlaceholders,
  slugify,
  telLinks,
  vul,
  woordenGevonden,
  zonderUrls,
} from "./tekst.ts";

Deno.test("vul en openPlaceholders", () => {
  const t = vul("Onze collega's van {eendje} schreven over {onderwerp}.", {
    eendje: "[Eendje](https://eendje.be)",
  });
  assertEquals(
    t,
    "Onze collega's van [Eendje](https://eendje.be) schreven over {onderwerp}.",
  );
  assertEquals(openPlaceholders(t), ["onderwerp"]);
});

Deno.test("slugify: accenten weg, knippen op een woordgrens", () => {
  assertEquals(
    slugify("Bitterballen zelf maken: wat zit erin & hoeveel?"),
    "bitterballen-zelf-maken-wat-zit-erin-en-hoeveel",
  );
  assertEquals(
    slugify("Bitterballen maison : ce qu'il y a dedans et en quelle quantité"),
    "bitterballen-maison-ce-qu-il-y-a-dedans-et-en-quelle",
  );
  assertEquals(slugify("x".repeat(80)).length, 60);
});

Deno.test("zonderUrls, hoofdletter, elisie, telLinks", () => {
  assertEquals(
    zonderUrls("Zie [Nilou]({NILOU_URL}) en https://a.be/x."),
    "Zie [Nilou] en ",
  );
  assertEquals(
    hoofdletter("bitterballen per portie?"),
    "Bitterballen per portie?",
  );
  assertEquals(
    elisie("du même ordre que une portion", "fr"),
    "du même ordre qu'une portion",
  );
  assertEquals(elisie("que une", "nl"), "que une");
  assertEquals(
    telLinks("[a](https://x.be/1) [b](https://x.be/1)", "https://x.be/1"),
    2,
  );
});

Deno.test("woordenGevonden: hele woorden, hoofdletterongevoelig", () => {
  assertEquals(
    woordenGevonden("Geen Dieet, wel verbranden-loos", [
      "dieet",
      "verbranden",
      "expert",
    ]),
    ["dieet", "verbranden"],
  );
  assertEquals(woordenGevonden("dieetwoorden", ["dieet"]), []);
});
