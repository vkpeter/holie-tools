import { assertEquals } from "@std/assert";
import { externeLink, externeLinkUitRij } from "./talen.ts";

// Naar het voorbeeld van Kyone: Engels als standaard, plus NL en DE, geen FR.
// De paden zijn illustratief.
const KYONE = {
  standaard: "https://kyone.com/",
  en: "https://kyone.com/",
  nl: "https://kyone.com/nl/",
  de: "https://kyone.com/de/",
};

Deno.test("externeLink: de taal van de pagina als de site die heeft", () => {
  assertEquals(externeLink(KYONE, "nl"), "https://kyone.com/nl/");
  assertEquals(externeLink(KYONE, "de"), "https://kyone.com/de/");
  assertEquals(externeLink(KYONE, "en"), "https://kyone.com/");
});

Deno.test("externeLink: Frans zonder Franse versie valt terug op Engels", () => {
  const site = {
    standaard: "https://voorbeeld.nl/",
    en: "https://voorbeeld.nl/en/",
  };
  assertEquals(externeLink(site, "fr"), "https://voorbeeld.nl/en/");
  assertEquals(externeLink(KYONE, "fr"), "https://kyone.com/");
});

Deno.test("externeLink: zonder taal en zonder Engels de standaard", () => {
  const site = {
    standaard: "https://voorbeeld.de/",
    nl: "https://voorbeeld.de/nl/",
  };
  assertEquals(externeLink(site, "fr"), "https://voorbeeld.de/");
  assertEquals(externeLink(site, ""), "https://voorbeeld.de/");
  assertEquals(externeLink(site, null), "https://voorbeeld.de/");
});

Deno.test("externeLink: lege strings en null tellen als ontbrekend", () => {
  const site = {
    standaard: "https://voorbeeld.be/",
    fr: "  ",
    en: "",
    de: null,
  };
  assertEquals(externeLink(site, "fr"), "https://voorbeeld.be/");
  assertEquals(externeLink(site, "de"), "https://voorbeeld.be/");
});

Deno.test("externeLink: een regio valt terug op de hoofdtaal", () => {
  assertEquals(externeLink(KYONE, "nl-BE"), "https://kyone.com/nl/");
  assertEquals(externeLink(KYONE, "DE_at"), "https://kyone.com/de/");
  assertEquals(
    externeLink({ ...KYONE, "pt-br": "https://kyone.com/br/" }, "pt-BR"),
    "https://kyone.com/br/",
  );
});

Deno.test("externeLinkUitRij: kolommen website_url plus website_url_<taal>", () => {
  const rij = {
    naam: "Kyone",
    website_url: "https://kyone.com/",
    website_url_nl: "https://kyone.com/nl/",
    website_url_de: "https://kyone.com/de/",
    website_url_fr: null,
  };
  assertEquals(
    externeLinkUitRij(rij, "website_url", "nl"),
    "https://kyone.com/nl/",
  );
  assertEquals(
    externeLinkUitRij(rij, "website_url", "fr"),
    "https://kyone.com/",
  );
  assertEquals(
    externeLinkUitRij(
      { ...rij, website_url_en: "https://kyone.com/en/" },
      "website_url",
      "fr",
    ),
    "https://kyone.com/en/",
  );
});

Deno.test("externeLinkUitRij: geen enkel adres geeft undefined", () => {
  assertEquals(
    externeLinkUitRij({ website_url: "" }, "website_url", "nl"),
    undefined,
  );
  assertEquals(externeLinkUitRij({}, "website_url", "nl"), undefined);
  assertEquals(externeLinkUitRij(null, "website_url", "nl"), undefined);
});
