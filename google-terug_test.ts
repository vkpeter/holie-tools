import { assertEquals } from "@std/assert";
import {
  bewaarGoogleTerug,
  GOOGLE_TERUG_TEKSTEN,
  googleTerugMelding,
  googleTerugUitUrl,
  leesGoogleTerug,
  neemGoogleTerug,
  urlZonderGoogleTerug,
} from "./google-terug.ts";

Deno.test("geen uitnodiging: signup_disabled in de hash", () => {
  assertEquals(
    leesGoogleTerug(
      "",
      "#error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed+for+this+instance",
    ),
    { soort: "niet_uitgenodigd" },
  );
});

Deno.test("geen uitnodiging: enkel de uitleg in de query", () => {
  assertEquals(
    leesGoogleTerug(
      "?error=server_error&error_description=Signups%20not%20allowed%20for%20this%20instance",
    ),
    { soort: "niet_uitgenodigd" },
  );
});

Deno.test("annuleren op het Google-scherm", () => {
  assertEquals(leesGoogleTerug("?error=access_denied"), {
    soort: "geannuleerd",
  });
});

Deno.test("andere fout: uitleg, ingekort tot 160 tekens", () => {
  const lang = "x".repeat(300);
  const t = leesGoogleTerug(
    `?error=server_error&error_description=${lang}`,
  );
  assertEquals(t, { soort: "fout", tekst: "x".repeat(160) });
});

Deno.test("PKCE: code in de query", () => {
  assertEquals(leesGoogleTerug("?code=abc&next=%2Fx"), {
    soort: "code",
    code: "abc",
  });
});

Deno.test("implicit of niets: leeg", () => {
  assertEquals(leesGoogleTerug("", "#access_token=t&type=bearer"), {
    soort: "leeg",
  });
  assertEquals(leesGoogleTerug(""), { soort: "leeg" });
});

Deno.test("volledige URL, en een ongeldige URL is leeg", () => {
  assertEquals(
    googleTerugUitUrl("https://app.test/auth?error=access_denied"),
    { soort: "geannuleerd" },
  );
  assertEquals(googleTerugUitUrl("geen url"), { soort: "leeg" });
});

Deno.test("URL opkuisen laat next staan", () => {
  assertEquals(
    urlZonderGoogleTerug(
      "https://app.test/auth?next=%2Fx&error=access_denied&error_description=y",
    ),
    "https://app.test/auth?next=%2Fx",
  );
  assertEquals(
    urlZonderGoogleTerug(
      "https://app.test/auth#error=access_denied&error_code=signup_disabled",
    ),
    "https://app.test/auth",
  );
  assertEquals(
    urlZonderGoogleTerug("https://app.test/auth#sectie"),
    "https://app.test/auth#sectie",
  );
});

Deno.test("bewaren bij het laden, één keer nemen", () => {
  bewaarGoogleTerug("https://app.test/auth?error=access_denied");
  bewaarGoogleTerug("https://app.test/auth"); // tweede keer: niets
  assertEquals(neemGoogleTerug(), { soort: "geannuleerd" });
  assertEquals(neemGoogleTerug(), { soort: "leeg" });
});

Deno.test("melding: geen uitnodiging en afgebroken zijn info, fout is fout", () => {
  assertEquals(
    googleTerugMelding({ soort: "niet_uitgenodigd" })?.soort,
    "info",
  );
  assertEquals(googleTerugMelding({ soort: "geannuleerd" })?.soort, "info");
  assertEquals(googleTerugMelding({ soort: "fout", tekst: "boem" }), {
    soort: "fout",
    tekst: "Aanmelden met Google lukte niet (boem). Probeer opnieuw.",
  });
  assertEquals(googleTerugMelding({ soort: "leeg" }), null);
  assertEquals(googleTerugMelding({ soort: "code", code: "c" }), null);
});

Deno.test("melding: lege tekst voor afgebroken toont niets", () => {
  assertEquals(
    googleTerugMelding({ soort: "geannuleerd" }, {
      ...GOOGLE_TERUG_TEKSTEN.nl,
      geannuleerd: "",
    }),
    null,
  );
});
