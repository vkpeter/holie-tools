import { assertEquals } from "@std/assert";
import { doelTalen, normaliseerInstelling, vervangTaal } from "./talen.ts";

const STANDAARD = {
  beschikbaar: ["nl", "en", "fr", "de", "es"],
  actief: ["nl", "en", "fr", "de"],
  bron: "nl",
  terugval: "en",
};

Deno.test("kapotte of lege invoer geeft de standaard", () => {
  assertEquals(normaliseerInstelling("{kapot", STANDAARD), STANDAARD);
  assertEquals(normaliseerInstelling(null, STANDAARD), STANDAARD);
});

Deno.test("actief blijft binnen beschikbaar, bron altijd erbij, onbekende codes weg", () => {
  const inst = normaliseerInstelling(
    JSON.stringify({
      beschikbaar: ["en", "xx"],
      actief: ["en", "es"],
      bron: "nl",
      terugval: "es",
    }),
    STANDAARD,
  );
  assertEquals(inst, {
    beschikbaar: ["nl", "en"],
    actief: ["nl", "en"],
    bron: "nl",
    terugval: "nl",
  });
});

Deno.test("doelTalen laat uitgeschakelde talen weg, ook als ze gevraagd worden", () => {
  assertEquals(doelTalen(STANDAARD), ["en", "fr", "de"]);
  assertEquals(doelTalen(STANDAARD, ["es", "fr", "ja"]), ["fr"]);
  assertEquals(doelTalen(STANDAARD, []), ["en", "fr", "de"]);
});

Deno.test("vervangTaal stuurt een niet-actieve taal naar de terugval", () => {
  assertEquals(vervangTaal(STANDAARD, "es"), "en");
  assertEquals(vervangTaal(STANDAARD, "fr"), "fr");
});
