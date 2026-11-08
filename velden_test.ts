import { assert, assertEquals } from "@std/assert";
import {
  CF_TEKENS,
  EMAIL_PATROON,
  IBAN_LENGTES,
  isGeldigBtw,
  isGeldigEmail,
  isGeldigIban,
  isGeldigLand,
  isGeldigOndernemingsnummer,
  isGeldigPostcode,
  isGeldigTelefoon,
  isGeldigUrl,
  normaliseerBtw,
  normaliseerEmail,
  normaliseerIban,
  normaliseerLand,
  normaliseerOndernemingsnummer,
  normaliseerPostcode,
  normaliseerTelefoon,
  normaliseerUrl,
  schoonRegel,
  schoonTekst,
  UNICODE_SPATIES,
  VELDEN_SQL,
  weergaveIban,
  weergaveOndernemingsnummer,
  weergaveTelefoon,
} from "./velden.ts";
import * as formulier from "./formulier.ts";

// ───────────── schoonRegel en schoonTekst ─────────────

Deno.test("schoonRegel: Cf weg, spaties samengevoegd, rand af", () => {
  assertEquals(schoonRegel("\u200E Jan\u00A0  Peeters\n"), "Jan Peeters");
  assertEquals(schoonRegel("\u202Aa\u202C\u202Fb\u3000c\td"), "a b c d");
  assertEquals(schoonRegel("a\r\n\r\nb"), "a b");
  assertEquals(schoonRegel("\uFEFF\u200B"), "");
  assertEquals(schoonRegel("a\u2028b\u2029c\u0085d"), "a b c d");
  assertEquals(schoonRegel("  "), "");
});

Deno.test("schoonRegel: geen tekst geeft lege tekst", () => {
  for (const x of [null, undefined, 5, {}, []]) {
    assertEquals(schoonRegel(x), "");
    assertEquals(schoonTekst(x), "");
  }
});

Deno.test("schoonTekst: regels blijven, NBSP wordt spatie, enkel de rand trimt", () => {
  assertEquals(
    schoonTekst("\uFEFF Dag\u00A0Jan,\r\n\r\nGroet \n"),
    "Dag Jan,\n\nGroet",
  );
  assertEquals(schoonTekst("a\rb"), "a\nb");
  assertEquals(schoonTekst("a  b\n  c"), "a  b\n  c");
  assertEquals(schoonTekst("\u200Bx\u200E"), "x");
  assertEquals(schoonTekst("\u202F\u00A0x\u00A0"), "x");
});

Deno.test("CF_TEKENS en UNICODE_SPATIES: zonder g-vlag, herbruikbaar", () => {
  for (
    const c of "\u200B\u200C\u200D\u200E\u200F\u202A\u202E\u2060\u2064\uFEFF"
  ) {
    assert(CF_TEKENS.test(c), c.charCodeAt(0).toString(16));
    assert(CF_TEKENS.test(c), "tweede keer: geen lastIndex-valkuil");
  }
  assert(!CF_TEKENS.test("abc 123"));
  for (const c of " \u00A0\u202F\u2003\u3000\t\n") {
    assert(UNICODE_SPATIES.test(c));
  }
  assert(!UNICODE_SPATIES.test("x"));
});

// ───────────── E-mail ─────────────

Deno.test("normaliseerEmail (velden): strippen, dan valideren", () => {
  assertEquals(
    normaliseerEmail("\u200E Jan@Example.BE\u00A0"),
    "jan@example.be",
  );
  assertEquals(normaliseerEmail("\u202Fa@b.be\u202F"), "a@b.be");
  assertEquals(normaliseerEmail("a b@c.de"), null);
  assertEquals(normaliseerEmail("a@b.de\r\nBcc: x@y.z"), null);
  assertEquals(normaliseerEmail("a\u0085@x.com"), null);
  assertEquals(isGeldigEmail("a\u200B@x.com"), true);
  assertEquals(normaliseerEmail(42), null);
});

Deno.test("formulier.ts en velden.ts delen dezelfde e-mailfuncties", () => {
  assert(formulier.normaliseerEmail === normaliseerEmail);
  assert(formulier.isGeldigEmail === isGeldigEmail);
  assert(formulier.EMAIL_PATROON === EMAIL_PATROON);
  assertEquals(formulier.EMAIL_MAX_LENGTE, 254);
});

// ───────────── Land ─────────────

Deno.test("normaliseerLand: codes en namen in vier talen", () => {
  const gevallen: Record<string, string> = {
    be: "BE",
    BEL: "BE",
    "België": "BE",
    belgium: "BE",
    Belgique: "BE",
    Belgien: "BE",
    "  \u200EBELGIË\u00A0": "BE",
    Nederland: "NL",
    Netherlands: "NL",
    "The Netherlands": "NL",
    "Pays-Bas": "NL",
    "pays bas": "NL",
    Niederlande: "NL",
    Holland: "NL",
    NLD: "NL",
    Luxemburg: "LU",
    Luxembourg: "LU",
    Frankrijk: "FR",
    France: "FR",
    Frankreich: "FR",
    Duitsland: "DE",
    Germany: "DE",
    Allemagne: "DE",
    Deutschland: "DE",
    DEU: "DE",
    Oostenrijk: "AT",
    "Österreich": "AT",
    Osterreich: "AT",
    Spanje: "ES",
    Italie: "IT",
    "Italië": "IT",
    Zwitserland: "CH",
    Schweiz: "CH",
    Suisse: "CH",
    Zweden: "SE",
    Polen: "PL",
    "Tsjechië": "CZ",
    "Czech Republic": "CZ",
    "République tchèque": "CZ",
    Griekenland: "GR",
    EL: "GR",
    "Verenigd Koninkrijk": "GB",
    "United Kingdom": "GB",
    UK: "GB",
    GBR: "GB",
    "Großbritannien": "GB",
    Grossbritannien: "GB",
    "Verenigde Staten": "US",
    "États-Unis": "US",
    "etats unis": "US",
    USA: "US",
    Marokko: "MA",
    Maroc: "MA",
    MAR: "MA",
    Turkije: "TR",
    "Türkiye": "TR",
    Turquie: "TR",
    TUR: "TR",
    IJsland: "IS",
    Noorwegen: "NO",
    Liechtenstein: "LI",
  };
  for (const [invoer, verwacht] of Object.entries(gevallen)) {
    assertEquals(normaliseerLand(invoer), verwacht, invoer);
  }
});

Deno.test("normaliseerLand: alle EU-landen kennen hun code en alpha-3", () => {
  const eu = [
    "AT",
    "BE",
    "BG",
    "HR",
    "CY",
    "CZ",
    "DK",
    "EE",
    "FI",
    "FR",
    "DE",
    "GR",
    "HU",
    "IE",
    "IT",
    "LV",
    "LT",
    "LU",
    "MT",
    "NL",
    "PL",
    "PT",
    "RO",
    "SK",
    "SI",
    "ES",
    "SE",
  ];
  for (const c of eu) assertEquals(normaliseerLand(c.toLowerCase()), c);
  assertEquals(eu.length, 27);
  assertEquals(normaliseerLand("PRT"), "PT");
  assertEquals(normaliseerLand("SVN"), "SI");
});

Deno.test("normaliseerLand: onbekend, leeg en geen tekst is null", () => {
  for (
    const x of ["", " ", "Atlantis", "B", "BELX", "12", null, undefined, 3]
  ) {
    assertEquals(normaliseerLand(x), null, String(x));
  }
  assertEquals(isGeldigLand("be"), true);
  assertEquals(isGeldigLand("xx"), false);
  assertEquals(normaliseerLand("x".repeat(500)), null);
});

// ───────────── Telefoon ─────────────

Deno.test("normaliseerTelefoon: de gevallen uit de opdracht", () => {
  const gevallen: [unknown, string | undefined, string | null][] = [
    ["\u202A0465 50 40 85\u202C", undefined, "+32465504085"],
    ["0475/12.34.56", undefined, "+32475123456"],
    ["+32 (0)3 480 12 34", undefined, "+3234801234"],
    ["0032475123456", undefined, "+32475123456"],
    ["+31 6 12345678", undefined, "+31612345678"],
    ["06 12345678", "NL", "+31612345678"],
    ["+352 621 123 456", undefined, "+352621123456"],
    ["\u00A00475123456", undefined, "+32475123456"],
    ["garbage", undefined, null],
  ];
  for (const [invoer, land, verwacht] of gevallen) {
    assertEquals(
      land === undefined
        ? normaliseerTelefoon(invoer)
        : normaliseerTelefoon(invoer, land),
      verwacht,
      JSON.stringify(invoer),
    );
  }
});

Deno.test("normaliseerTelefoon: nullen, landnummers en schrijfwijzen", () => {
  assertEquals(normaliseerTelefoon("+32 0475 12 34 56"), "+32475123456");
  assertEquals(normaliseerTelefoon("+32(0)475-12-34-56"), "+32475123456");
  assertEquals(normaliseerTelefoon("0032 (0) 475 12 34 56"), "+32475123456");
  assertEquals(normaliseerTelefoon("+31 (0)6 12345678"), "+31612345678");
  assertEquals(normaliseerTelefoon("+31 06 12345678"), "+31612345678");
  assertEquals(normaliseerTelefoon("03 480 12 34"), "+3234801234");
  assertEquals(normaliseerTelefoon("(03) 480 12 34"), "+3234801234");
  assertEquals(
    normaliseerTelefoon("\u200F+32\u00A0475\u202F12\u202F34 56"),
    "+32475123456",
  );
  assertEquals(normaliseerTelefoon("0033 6 12 34 56 78"), "+33612345678");
  assertEquals(normaliseerTelefoon("06 12 34 56 78", "FR"), "+33612345678");
  assertEquals(normaliseerTelefoon("0151 23456789", "DE"), "+4915123456789");
  assertEquals(normaliseerTelefoon("+49 (0)151 23456789"), "+4915123456789");
  assertEquals(normaliseerTelefoon("+1 212 555 0100"), "+12125550100");
  assertEquals(normaliseerTelefoon("+44 (0)20 7946 0958"), "+442079460958");
  assertEquals(normaliseerTelefoon("+39 06 1234 5678"), "+390612345678");
  assertEquals(normaliseerTelefoon("06 1234 5678", "IT"), "+390612345678");
});

Deno.test("normaliseerTelefoon: Luxemburg kent geen nationale nul", () => {
  assertEquals(normaliseerTelefoon("621 123 456", "LU"), "+352621123456");
  assertEquals(normaliseerTelefoon("0621 123 456", "LU"), null);
  assertEquals(normaliseerTelefoon("+352 621 123 456", "BE"), "+352621123456");
});

Deno.test("normaliseerTelefoon: standaardland als code of naam", () => {
  assertEquals(normaliseerTelefoon("0612345678", "nl"), "+31612345678");
  assertEquals(normaliseerTelefoon("0612345678", "Nederland"), "+31612345678");
  assertEquals(normaliseerTelefoon("0612345678", "Atlantis"), null);
  // VS staat niet in de tabel: een nationaal nummer is dan niet te duiden.
  assertEquals(normaliseerTelefoon("2125550100", "US"), null);
});

Deno.test("normaliseerTelefoon: lengtecontrole BE en NL", () => {
  assertEquals(normaliseerTelefoon("0475 12 34"), null); // 7 cijfers na +32
  assertEquals(normaliseerTelefoon("04 123 45 67"), "+3241234567"); // vast Luik: 8
  assertEquals(normaliseerTelefoon("0475 12 34 567"), null); // 10 cijfers na +32
  assertEquals(normaliseerTelefoon("03 480 12 3"), null); // 7 cijfers
  assertEquals(normaliseerTelefoon("+32 475 12 3"), null);
  assertEquals(normaliseerTelefoon("+32 0 475 12 3"), null);
  assertEquals(normaliseerTelefoon("+31 6 1234567"), null); // 8 cijfers NL
  assertEquals(normaliseerTelefoon("+31 6 123456789"), null); // 10 cijfers NL
  assertEquals(normaliseerTelefoon("06 1234567", "NL"), null);
});

Deno.test("normaliseerTelefoon: rommel is null", () => {
  for (
    const x of [
      "",
      "   ",
      "\u200E\u200F",
      "abc",
      "0475 12 34 5a",
      "0475 12 34 56 ext 3",
      "+",
      "++32475123456",
      "0475+123456",
      "32475123456", // landnummer zonder plus: we raden niet
      "475123456", // BE zonder nul
      "+0475123456",
      "+3",
      "0",
      "0000",
      "+" + "1".repeat(16),
      "1".repeat(100),
      null,
      undefined,
      "0475123456".length,
      {},
    ]
  ) {
    assertEquals(normaliseerTelefoon(x), null, JSON.stringify(x));
    assertEquals(isGeldigTelefoon(x), false);
  }
});

Deno.test("normaliseerTelefoon: de uitkomst is idempotent", () => {
  for (const x of ["0475/12.34.56", "+32 (0)3 480 12 34", "06 12345678"]) {
    const eerst = normaliseerTelefoon(x, x.startsWith("06") ? "NL" : "BE");
    assert(eerst !== null);
    assertEquals(normaliseerTelefoon(eerst), eerst);
  }
});

Deno.test("weergaveTelefoon: BE gsm en vast, andere landen +CC rest", () => {
  assertEquals(weergaveTelefoon("+32475123456"), "+32 475 12 34 56");
  assertEquals(weergaveTelefoon("+32465504085"), "+32 465 50 40 85");
  assertEquals(weergaveTelefoon("+3234801234"), "+32 3 480 12 34");
  assertEquals(weergaveTelefoon("+3224801234"), "+32 2 480 12 34");
  assertEquals(weergaveTelefoon("+3291234567"), "+32 9 123 45 67");
  assertEquals(weergaveTelefoon("+3241234567"), "+32 4 123 45 67");
  assertEquals(weergaveTelefoon("+3214123456"), "+32 14 12 34 56");
  assertEquals(weergaveTelefoon("+31612345678"), "+31 612345678");
  assertEquals(weergaveTelefoon("+352621123456"), "+352 621123456");
  assertEquals(weergaveTelefoon("+12125550100"), "+12125550100");
  // Geen E.164: ongewijzigd terug.
  assertEquals(weergaveTelefoon("0475123456"), "0475123456");
  assertEquals(weergaveTelefoon(""), "");
});

// ───────────── Postcode ─────────────

Deno.test("normaliseerPostcode: BE", () => {
  assertEquals(normaliseerPostcode("2000", "BE"), "2000");
  assertEquals(normaliseerPostcode("\u200E2000\u00A0", "BE"), "2000");
  assertEquals(normaliseerPostcode("B-1000", "BE"), "1000");
  assertEquals(normaliseerPostcode("be 9000", "België"), "9000");
  for (const x of ["0123", "200", "20000", "20A0", "", "abcd", null, 2000]) {
    assertEquals(normaliseerPostcode(x, "BE"), null, String(x));
  }
});

Deno.test("normaliseerPostcode: NL", () => {
  assertEquals(normaliseerPostcode("1234 AB", "NL"), "1234 AB");
  assertEquals(normaliseerPostcode("1234ab", "NL"), "1234 AB");
  assertEquals(normaliseerPostcode("  1234\u00A0\u00A0ab ", "NL"), "1234 AB");
  assertEquals(normaliseerPostcode("NL-1234 AB", "NL"), "1234 AB");
  assertEquals(normaliseerPostcode("1011 SB", "NL"), "1011 SB");
  for (
    const x of [
      "0123 AB",
      "1234 SA",
      "1234 SD",
      "1234 ss",
      "1234",
      "1234 A",
      "AB 1234",
      "1234 ABC",
    ]
  ) {
    assertEquals(normaliseerPostcode(x, "NL"), null, x);
  }
});

Deno.test("normaliseerPostcode: LU, DE, FR", () => {
  assertEquals(normaliseerPostcode("L-1234", "LU"), "1234");
  assertEquals(normaliseerPostcode("l 1234", "LU"), "1234");
  assertEquals(normaliseerPostcode("1234", "Luxemburg"), "1234");
  assertEquals(normaliseerPostcode("12345", "LU"), null);
  assertEquals(normaliseerPostcode("01067", "DE"), "01067");
  assertEquals(normaliseerPostcode("D-10115", "DE"), "10115");
  assertEquals(normaliseerPostcode("1011", "DE"), null);
  assertEquals(normaliseerPostcode("75001", "FR"), "75001");
  assertEquals(normaliseerPostcode("F-75001", "France"), "75001");
  assertEquals(normaliseerPostcode("7500", "FR"), null);
  assertEquals(normaliseerPostcode("750011", "FR"), null);
});

Deno.test("normaliseerPostcode: ander of onbekend land", () => {
  assertEquals(normaliseerPostcode("sw1a  1aa", "GB"), "SW1A 1AA");
  assertEquals(normaliseerPostcode("sw1a 1aa", undefined), "SW1A 1AA");
  assertEquals(normaliseerPostcode("10001", "US"), "10001");
  assertEquals(normaliseerPostcode("1234-567", "Atlantis"), "1234-567");
  assertEquals(normaliseerPostcode("1234-567", null), "1234-567");
  assertEquals(normaliseerPostcode("A".repeat(12), "GB"), "A".repeat(12));
  for (const x of ["A".repeat(13), "12 34!", "-123", "", "   ", "\u200B"]) {
    assertEquals(normaliseerPostcode(x, "GB"), null, x);
  }
  assertEquals(isGeldigPostcode("2000", "BE"), true);
  assertEquals(isGeldigPostcode("2000", "NL"), false);
});

// ───────────── Ondernemingsnummer en btw ─────────────

Deno.test("normaliseerOndernemingsnummer: vormen en controlegetal", () => {
  for (
    const x of [
      "0403019261",
      "0403.019.261",
      "BE 0403 019 261",
      "BE0403.019.261",
      "be0403019261",
      "403019261", // oude vorm van negen cijfers
      "\u200E0403.019.261\u00A0",
      "0403-019-261",
    ]
  ) {
    assertEquals(normaliseerOndernemingsnummer(x), "0403019261", x);
  }
  assertEquals(normaliseerOndernemingsnummer("0417.497.106"), "0417497106");
  assertEquals(normaliseerOndernemingsnummer("1234.567.894"), "1234567894");
  for (
    const x of [
      "0403019262", // controlegetal
      "0123456789", // controlegetal
      "2403019261", // eerste cijfer 2
      "040301926",
      "04030192611",
      "NL0403019261",
      "abc",
      "",
      "0000000000",
      null,
      403019261,
    ]
  ) {
    assertEquals(normaliseerOndernemingsnummer(x), null, String(x));
  }
  assertEquals(isGeldigOndernemingsnummer("0403.019.261"), true);
});

Deno.test("weergaveOndernemingsnummer: 0403.019.261", () => {
  assertEquals(weergaveOndernemingsnummer("0403019261"), "0403.019.261");
  assertEquals(weergaveOndernemingsnummer("BE 0403 019 261"), "0403.019.261");
  assertEquals(weergaveOndernemingsnummer("rommel"), "rommel");
  assertEquals(weergaveOndernemingsnummer(null), "");
});

Deno.test("normaliseerBtw: prefix uit de invoer of uit het land", () => {
  assertEquals(normaliseerBtw("BE 0403.019.261"), "BE0403019261");
  assertEquals(normaliseerBtw("be0403019261"), "BE0403019261");
  assertEquals(normaliseerBtw("BE403019261"), "BE0403019261");
  assertEquals(normaliseerBtw("0403.019.261", "BE"), "BE0403019261");
  assertEquals(normaliseerBtw("0403.019.261", "België"), "BE0403019261");
  assertEquals(normaliseerBtw("\u200ENL 1234.56.789.B01"), "NL123456789B01");
  assertEquals(normaliseerBtw("123456789B01", "nl"), "NL123456789B01");
  assertEquals(normaliseerBtw("LU 1234 5678"), "LU12345678");
  assertEquals(normaliseerBtw("12345678", "Luxemburg"), "LU12345678");
  assertEquals(normaliseerBtw("FR 12 345678901"), "FR12345678901");
  assertEquals(normaliseerBtw("FRAB123456789"), "FRAB123456789");
  assertEquals(normaliseerBtw("AB123456789", "FR"), "FRAB123456789");
  assertEquals(normaliseerBtw("DE 123 456 789"), "DE123456789");
  assertEquals(normaliseerBtw("123456789", "DE"), "DE123456789");
  // De prefix in de invoer wint van het land.
  assertEquals(normaliseerBtw("NL123456789B01", "BE"), "NL123456789B01");
  assertEquals(isGeldigBtw("BE0403019261"), true);
});

Deno.test("normaliseerBtw: ongeldig is null", () => {
  for (
    const [x, land] of [
      ["0403019261", undefined], // welk land?
      ["0403019261", "NL"],
      ["BE0403019262", undefined], // controlegetal
      ["NL123456789", undefined], // B01 ontbreekt
      ["NL123456789B1", undefined],
      ["LU1234567", undefined],
      ["LU123456789", undefined],
      ["DE12345678", undefined],
      ["FR1234567890", undefined],
      ["GB123456789", undefined], // niet ondersteund
      ["", "BE"],
      ["BE", undefined],
      [null, "BE"],
      [12345678, "LU"],
    ] as [unknown, unknown][]
  ) {
    assertEquals(normaliseerBtw(x, land), null, `${x} ${land}`);
  }
});

// ───────────── IBAN ─────────────

Deno.test("normaliseerIban: geldige nummers", () => {
  const gevallen: [string, string][] = [
    ["BE68 5390 0754 7034", "BE68539007547034"],
    ["be68539007547034", "BE68539007547034"],
    ["\u200EBE68\u00A05390\u202F0754 7034 ", "BE68539007547034"],
    ["NL91 ABNA 0417 1643 00", "NL91ABNA0417164300"],
    ["DE89 3704 0044 0532 0130 00", "DE89370400440532013000"],
    ["FR76 3000 6000 0112 3456 7890 189", "FR7630006000011234567890189"],
    ["LU28 0019 4006 4475 0000", "LU280019400644750000"],
    ["GB29 NWBK 6016 1331 9268 19", "GB29NWBK60161331926819"],
    ["ES91 2100 0418 4502 0005 1332", "ES9121000418450200051332"],
    ["IT60 X054 2811 1010 0000 0123 456", "IT60X0542811101000000123456"],
    ["CH93 0076 2011 6238 5295 7", "CH9300762011623852957"],
  ];
  for (const [x, verwacht] of gevallen) {
    assertEquals(normaliseerIban(x), verwacht, x);
    assertEquals(isGeldigIban(x), true);
  }
});

Deno.test("normaliseerIban: ongeldig is null", () => {
  for (
    const x of [
      "BE68 5390 0754 7035", // controlegetal
      "BE68 5390 0754 703", // te kort
      "BE68 5390 0754 70344", // te lang
      "XX68 5390 0754 7034", // onbekend land
      "5390 0754 7034",
      "",
      "BE",
      "BE68 5390 0754 703!",
      null,
      123,
    ]
  ) {
    assertEquals(normaliseerIban(x), null, String(x));
  }
  assertEquals(IBAN_LENGTES.BE, 16);
});

Deno.test("weergaveIban: groepen van vier", () => {
  assertEquals(weergaveIban("BE68539007547034"), "BE68 5390 0754 7034");
  assertEquals(weergaveIban("be68 5390 0754 7034"), "BE68 5390 0754 7034");
  assertEquals(weergaveIban("NL91ABNA0417164300"), "NL91 ABNA 0417 1643 00");
  assertEquals(weergaveIban("rommel"), "rommel");
  assertEquals(weergaveIban(undefined), "");
});

// ───────────── URL ─────────────

Deno.test("normaliseerUrl: schema, host en href", () => {
  assertEquals(
    normaliseerUrl("\u200E www.Example.be "),
    "https://www.example.be/",
  );
  assertEquals(
    normaliseerUrl("example.be/pad?x=1#top"),
    "https://example.be/pad?x=1#top",
  );
  assertEquals(
    normaliseerUrl("http://example.be/a?b=1"),
    "http://example.be/a?b=1",
  );
  assertEquals(normaliseerUrl("HTTPS://Example.BE"), "https://example.be/");
  assertEquals(normaliseerUrl("//example.be/x"), "https://example.be/x");
  assertEquals(
    normaliseerUrl("example.be:8080/x"),
    "https://example.be:8080/x",
  );
  assertEquals(
    normaliseerUrl("\uFEFFhttps://sub.example.co.uk"),
    "https://sub.example.co.uk/",
  );
  assertEquals(normaliseerUrl("1.2.3.4"), "https://1.2.3.4/");
  assertEquals(isGeldigUrl("example.be"), true);
});

Deno.test("normaliseerUrl: onveilige of onbruikbare invoer is null", () => {
  for (
    const x of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<b>x</b>",
      "mailto:a@b.be",
      "file:///etc/passwd",
      "ftp://example.be",
      "tel:+32475123456",
      "localhost",
      "localhost:3000",
      "http://localhost",
      "http://[::1]/",
      "example",
      "example.",
      "a..be",
      ".be",
      "https://user:pw@example.be",
      "https://exa mple.be",
      "example.be/a b",
      "",
      "   ",
      "\u200B",
      "http://",
      "https://",
      "x".repeat(3000) + ".be",
      null,
      5,
    ]
  ) {
    assertEquals(normaliseerUrl(x), null, String(x));
    assertEquals(isGeldigUrl(x), false);
  }
});

// ───────────── SQL ─────────────

Deno.test("VELDEN_SQL is gelijk aan sql/velden.sql", async () => {
  const bestand = await Deno.readTextFile(
    new URL("./sql/velden.sql", import.meta.url),
  );
  assertEquals(bestand.replace(/\r\n/g, "\n"), VELDEN_SQL);
});

Deno.test("VELDEN_SQL: de afspraken staan erin", () => {
  for (
    const naam of [
      "strip_cf",
      "norm_regel",
      "norm_email",
      "email_geldig",
      "norm_telefoon",
      "norm_postcode",
    ]
  ) {
    assert(
      VELDEN_SQL.includes(`create or replace function public.${naam}(`),
      naam,
    );
  }
  assertEquals(
    (VELDEN_SQL.match(/immutable/g) ?? []).length,
    (VELDEN_SQL.match(/create or replace function/g) ?? []).length,
  );
  assertEquals(
    (VELDEN_SQL.match(/parallel safe/g) ?? []).length,
    (VELDEN_SQL.match(/create or replace function/g) ?? []).length,
  );
  assertEquals(
    (VELDEN_SQL.match(/set search_path = ''/g) ?? []).length,
    (VELDEN_SQL.match(/create or replace function/g) ?? []).length,
  );
  // Enkel ASCII: onzichtbare tekens horen als escape in het bestand.
  assert(Array.from(VELDEN_SQL).every((c) => c.charCodeAt(0) < 128));
});
