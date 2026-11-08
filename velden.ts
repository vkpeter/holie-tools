/**
 * Velden: één vaste normalisatie per soort invoerveld, voor alle projecten.
 *
 * Aanleiding (8 nov 2026, Roundbook): een iPhone-gebruiker plakte
 * `"0465 50 40 85"`. iOS zet er onzichtbare opmaaktekens omheen (Unicode `Cf`:
 * U+200B-U+200F, U+202A-U+202E, U+2060-U+2064, U+FEFF) en soms een
 * niet-brekende spatie (U+00A0, U+202F). `String.prototype.trim()` en Postgres'
 * `btrim()` halen die niet weg: de server weigerde het nummer, of bewaarde stil
 * rommel. Roundbook, Tickbook en Eagle-Eye hadden elk eigen hulpjes.
 *
 * De regel: **elk invoerveld voor e-mail, telefoon, land, postcode, btw, IBAN
 * en URL gaat door deze module**, in het scherm én op de server. De
 * Postgres-versie (voor kolommen en triggers) staat in `sql/velden.sql` en als
 * `VELDEN_SQL`.
 *
 * Afspraken voor alle functies:
 * - `normaliseerX(invoer: unknown, ...) => string | null`: `null` is leeg of
 *   ongeldig. `unknown`, zodat een JSON-body rechtstreeks door kan.
 * - `isGeldigX(...)` is `normaliseerX(...) !== null`.
 * - `weergaveX(...)` maakt van de opgeslagen vorm een leesbare vorm voor het
 *   scherm. Bewaar altijd de genormaliseerde vorm, nooit de weergavevorm.
 * - Zuivere functies, geen dependencies, draait in browser, Deno en Node.
 *
 * Alles valt dicht: twijfel is `null`, nooit een gok.
 */

// ───────────── Onzichtbare tekens en spaties ─────────────

/**
 * Onzichtbare opmaaktekens (Unicode-categorie `Cf`): zero-width space en
 * joiners, links-rechts-merktekens, bidi-embedding (U+202A-U+202E), woordverbinder
 * (U+2060-U+2064), BOM (U+FEFF), zachte koppelstreep (U+00AD), enz.
 *
 * Zonder `g`-vlag, dus veilig met `.test()`. Wil je alles vervangen, gebruik
 * `schoonRegel`/`schoonTekst` of maak zelf `new RegExp(CF_TEKENS, "gu")`.
 *
 * @example
 * CF_TEKENS.test("\u200Eabc"); // true
 */
export const CF_TEKENS: RegExp = /\p{Cf}/u;

/**
 * Elk soort spatie of regeleinde: gewone spatie, NBSP (U+00A0), smalle NBSP
 * (U+202F), U+2000-U+200A, U+3000, tab, `\n`, `\r`, NEL (U+0085), U+2028/9.
 *
 * Zonder `g`-vlag, zoals `CF_TEKENS`.
 */
export const UNICODE_SPATIES: RegExp = /[\s\u0085\p{Z}]/u;

const CF_ALLES = /\p{Cf}/gu;
const SPATIES_ALLES = /[\s\u0085\p{Z}]+/gu;
const SPATIE_AAN_RAND = /^[\s\u0085\p{Z}]+|[\s\u0085\p{Z}]+$/gu;
/** Spaties die géén regeleinde zijn: NBSP en vrienden worden een gewone spatie. */
const HORIZONTALE_SPATIES = /[\p{Zs}\t\v\f]/gu;

/** Maximale lengte van een veld dat we nog willen bekijken (bescherming). */
const MAX_RUW = 2048;

function alsTekst(invoer: unknown, max = MAX_RUW): string | null {
  if (typeof invoer !== "string") return null;
  if (invoer.length > max) return null;
  return invoer;
}

/**
 * Tekst van één regel: onzichtbare tekens weg, elke soort spatie (NBSP,
 * regeleinden, tabs) wordt één gewone spatie, dubbele spaties samengevoegd,
 * begin en einde afgesneden. Een niet-tekst geeft `""`.
 *
 * Gebruik voor namen, straten, steden, onderwerpen.
 *
 * @example
 * schoonRegel("\u200E Jan\u00A0  Peeters\n"); // "Jan Peeters"
 */
export function schoonRegel(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(CF_ALLES, "").replace(SPATIES_ALLES, " ").trim();
}

/**
 * Tekst van meerdere regels (berichten, notities): onzichtbare tekens weg,
 * NBSP en andere horizontale spaties worden een gewone spatie, `\r\n` en `\r`
 * worden `\n`, enkel begin en einde worden afgesneden. Spaties en lege regels in
 * het midden blijven staan. Een niet-tekst geeft `""`.
 *
 * ⚠️ Let op: `Cf` omvat ook de zero-width joiner (U+200D). Samengestelde
 * emoji (familie, huidskleur met beroep) vallen daardoor uiteen in losse emoji.
 * Dat is de bewuste prijs voor één regel zonder uitzonderingen.
 *
 * @example
 * schoonTekst("\uFEFF Dag\u00A0Jan,\r\n\r\nGroet \n"); // "Dag Jan,\n\nGroet"
 */
export function schoonTekst(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .replace(CF_ALLES, "")
    .replace(HORIZONTALE_SPATIES, " ")
    .replace(/\r\n|[\r\u0085\u2028\u2029]/g, "\n")
    .trim();
}

/** Strip `Cf` overal en alle spaties aan de rand. Binnenin blijven spaties staan. */
function stripRand(s: string): string {
  return s.replace(CF_ALLES, "").replace(SPATIE_AAN_RAND, "");
}

/** Strip `Cf` en elke soort spatie, overal. */
function stripAlles(s: string): string {
  return s.replace(CF_ALLES, "").replace(SPATIES_ALLES, "");
}

// ───────────── E-mail ─────────────

/** Langste adres dat SMTP toelaat (RFC 5321: 256 voor het pad, min de haken). */
export const EMAIL_MAX_LENGTE = 254;

/**
 * Lineair e-mailpatroon. Elk deel (tussen punten, voor en na de `@`) sluit de
 * punt en de `@` uit, dus er is maar één manier om te matchen: geen
 * backtracking op `a@.......` (gemeten met 20.000 punten in
 * `formulier_test.ts`).
 *
 * Basis is het patroon `/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/` van holie, strenger
 * gemaakt na de review van 0.18.0:
 * - Zoals bij Eendje (newsletter-subscribe, 28 okt 2026) vallen de tekens weg
 *   die een mailheader of HTML kunnen breken (`<>"(),;:\[]`). Die mogen volgens
 *   RFC 5322 niet zonder aanhalingstekens in een adres staan.
 * - Ook stuurtekens en onzichtbare opmaaktekens (`\p{Cc}`, `\p{Cf}`). Voor
 *   `normaliseerEmail` zijn de `Cf`-tekens er al uit gehaald; het patroon zelf
 *   blijft ze weigeren voor wie het rechtstreeks gebruikt.
 * - Geen punt vooraan, achteraan of dubbel in het lokale deel.
 * - Het domein enkel `A-Z a-z 0-9 -` per label: een domein met accenten komt
 *   als punycode (`xn--...`), zoals een browser het in `type=email` doorgeeft.
 *
 * De apostrof en letters met accenten in het lokale deel blijven toegelaten
 * (`o'neil@...`, `josé@...`).
 */
export const EMAIL_PATROON =
  /^[^\s@.<>"(),;:\\[\]\p{Cc}\p{Cf}]+(?:\.[^\s@.<>"(),;:\\[\]\p{Cc}\p{Cf}]+)*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;

/**
 * Het adres zoals het in de databank hoort, of `null` als het geen bruikbaar
 * adres is.
 *
 * Eerst worden onzichtbare tekens (`Cf`) overal weggehaald en spaties (ook
 * NBSP) aan begin en einde afgesneden: dat is wat een iPhone of een
 * kopieer-plak-actie eraan toevoegt. Dan volgen het patroon en de kleine
 * letters. Spaties of regeleinden *midden in* het adres blijven staan en geven
 * `null`: dat is geen plakfout maar een ander adres, of een poging om een
 * mailheader te breken (`a@b.de\r\nBcc: x@y.z`).
 *
 * Volgorde: eerst de lengte (maximaal 254, ook vóór het strippen: geen grote
 * invoer door de regex), dan strippen, patroon, kleine letters.
 *
 * ⚠️ Gedragswijziging in 0.31.0: onzichtbare tekens werden eerder geweigerd
 * (`null`), nu gestript.
 *
 * @example
 * normaliseerEmail("\u200E Jan@Example.BE\u00A0"); // "jan@example.be"
 * normaliseerEmail("a b@c.de"); // null
 */
export function normaliseerEmail(invoer: unknown): string | null {
  if (typeof invoer !== "string") return null;
  if (invoer.length > EMAIL_MAX_LENGTE) return null;
  const adres = stripRand(invoer);
  if (!EMAIL_PATROON.test(adres)) return null;
  const klein = adres.toLowerCase();
  // Kleine letters kunnen langer zijn (`İ` wordt twee tekens): opnieuw meten.
  return klein.length > EMAIL_MAX_LENGTE ? null : klein;
}

/** Is dit een bruikbaar adres? Zelfde regels als `normaliseerEmail`. */
export function isGeldigEmail(invoer: unknown): boolean {
  return normaliseerEmail(invoer) !== null;
}

// ───────────── Land ─────────────

interface LandGegevens {
  alpha3: string;
  namen: string[];
}

/**
 * Landen die we herkennen: EU, VK, Zwitserland, VS, Marokko, Turkije en de
 * overige EER-landen. Sleutel is ISO 3166-1 alpha-2. Namen in nl/en/fr/de
 * (en wat mensen echt typen: "Holland", "UK", "USA"). Uitbreiden: voeg een
 * regel toe, zoals de bestaande.
 */
const LANDEN: Record<string, LandGegevens> = {
  AT: {
    alpha3: "AUT",
    namen: ["Oostenrijk", "Austria", "Autriche", "Österreich", "Osterreich"],
  },
  BE: { alpha3: "BEL", namen: ["België", "Belgium", "Belgique", "Belgien"] },
  BG: {
    alpha3: "BGR",
    namen: ["Bulgarije", "Bulgaria", "Bulgarie", "Bulgarien"],
  },
  HR: { alpha3: "HRV", namen: ["Kroatië", "Croatia", "Croatie", "Kroatien"] },
  CY: { alpha3: "CYP", namen: ["Cyprus", "Chypre", "Zypern"] },
  CZ: {
    alpha3: "CZE",
    namen: [
      "Tsjechië",
      "Czechia",
      "Czech Republic",
      "Tchéquie",
      "République tchèque",
      "Tschechien",
      "Tsjechische Republiek",
    ],
  },
  DK: {
    alpha3: "DNK",
    namen: ["Denemarken", "Denmark", "Danemark", "Dänemark"],
  },
  EE: { alpha3: "EST", namen: ["Estland", "Estonia", "Estonie"] },
  FI: { alpha3: "FIN", namen: ["Finland", "Finlande", "Finnland"] },
  FR: { alpha3: "FRA", namen: ["Frankrijk", "France", "Frankreich"] },
  DE: {
    alpha3: "DEU",
    namen: ["Duitsland", "Germany", "Allemagne", "Deutschland"],
  },
  GR: {
    alpha3: "GRC",
    namen: ["Griekenland", "Greece", "Grèce", "Griechenland", "EL"],
  },
  HU: { alpha3: "HUN", namen: ["Hongarije", "Hungary", "Hongrie", "Ungarn"] },
  IE: { alpha3: "IRL", namen: ["Ierland", "Ireland", "Irlande", "Irland"] },
  IT: { alpha3: "ITA", namen: ["Italië", "Italy", "Italie", "Italien"] },
  LV: { alpha3: "LVA", namen: ["Letland", "Latvia", "Lettonie", "Lettland"] },
  LT: {
    alpha3: "LTU",
    namen: ["Litouwen", "Lithuania", "Lituanie", "Litauen"],
  },
  LU: {
    alpha3: "LUX",
    namen: ["Luxemburg", "Luxembourg", "Grand-Duché de Luxembourg"],
  },
  MT: { alpha3: "MLT", namen: ["Malta", "Malte"] },
  NL: {
    alpha3: "NLD",
    namen: [
      "Nederland",
      "Netherlands",
      "The Netherlands",
      "Holland",
      "Pays-Bas",
      "Niederlande",
    ],
  },
  PL: { alpha3: "POL", namen: ["Polen", "Poland", "Pologne"] },
  PT: { alpha3: "PRT", namen: ["Portugal"] },
  RO: {
    alpha3: "ROU",
    namen: ["Roemenië", "Romania", "Roumanie", "Rumänien"],
  },
  SK: {
    alpha3: "SVK",
    namen: ["Slowakije", "Slovakia", "Slovaquie", "Slowakei"],
  },
  SI: {
    alpha3: "SVN",
    namen: ["Slovenië", "Slovenia", "Slovénie", "Slowenien"],
  },
  ES: { alpha3: "ESP", namen: ["Spanje", "Spain", "Espagne", "Spanien"] },
  SE: { alpha3: "SWE", namen: ["Zweden", "Sweden", "Suède", "Schweden"] },
  GB: {
    alpha3: "GBR",
    namen: [
      "Verenigd Koninkrijk",
      "United Kingdom",
      "Great Britain",
      "Groot-Brittannië",
      "Engeland",
      "England",
      "Royaume-Uni",
      "Vereinigtes Königreich",
      "Großbritannien",
      "UK",
    ],
  },
  CH: {
    alpha3: "CHE",
    namen: ["Zwitserland", "Switzerland", "Suisse", "Schweiz", "Svizzera"],
  },
  US: {
    alpha3: "USA",
    namen: [
      "Verenigde Staten",
      "Verenigde Staten van Amerika",
      "United States",
      "United States of America",
      "États-Unis",
      "Vereinigte Staaten",
      "Amerika",
    ],
  },
  MA: { alpha3: "MAR", namen: ["Marokko", "Morocco", "Maroc"] },
  TR: {
    alpha3: "TUR",
    namen: ["Turkije", "Turkey", "Türkiye", "Turquie", "Türkei"],
  },
  NO: {
    alpha3: "NOR",
    namen: ["Noorwegen", "Norway", "Norvège", "Norwegen"],
  },
  IS: { alpha3: "ISL", namen: ["IJsland", "Iceland", "Islande", "Island"] },
  LI: { alpha3: "LIE", namen: ["Liechtenstein"] },
};

/** Sleutel zonder hoofdletters, accenten en leestekens: "Pays-Bas" = "pays bas". */
function landSleutel(s: string): string {
  return s
    .replace(CF_ALLES, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const LAND_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const [code, { alpha3, namen }] of Object.entries(LANDEN)) {
    for (const naam of [code, alpha3, ...namen]) {
      index.set(landSleutel(naam), code);
    }
  }
  return index;
})();

/**
 * ISO 3166-1 alpha-2 in hoofdletters, of `null`. Kent alpha-2- en alpha-3-codes
 * en de namen in nl/en/fr/de van de EU, het VK, Zwitserland, de VS, Marokko,
 * Turkije, Noorwegen, IJsland en Liechtenstein. Hoofdletters, accenten,
 * koppeltekens en onzichtbare tekens maken niet uit.
 *
 * @example
 * normaliseerLand("be");          // "BE"
 * normaliseerLand("Belgique");    // "BE"
 * normaliseerLand("Pays-Bas");    // "NL"
 * normaliseerLand("DEU");         // "DE"
 * normaliseerLand("Oostenrijk");  // "AT"
 * normaliseerLand("Atlantis");    // null
 */
export function normaliseerLand(invoer: unknown): string | null {
  const s = alsTekst(invoer, 100);
  if (s === null) return null;
  return LAND_INDEX.get(landSleutel(s)) ?? null;
}

/** Is dit een herkend land? Zie `normaliseerLand`. */
export function isGeldigLand(invoer: unknown): boolean {
  return normaliseerLand(invoer) !== null;
}

// ───────────── Telefoon ─────────────

/**
 * Wat er met een nul voor het nationale nummer gebeurt.
 * - `weg`: nationale nul (trunk prefix): `0475…` is `+32 475…`.
 * - `blijft`: de nul hoort bij het nummer (Italië).
 * - `geen`: dit land kent geen nationale nul.
 */
type NulRegel = "weg" | "blijft" | "geen";

interface TelefoonLand {
  /** Landnummer zonder plus. */
  cc: string;
  nul: NulRegel;
}

/**
 * Landen voor nationale nummers en het opschonen van `+32 0475…`. Sleutel is
 * ISO alpha-2. Uitbreiden: voeg een regel toe, en doe hetzelfde in
 * `sql/velden.sql` (functie `norm_telefoon`). Landnummers zijn prefix-vrij, dus
 * een nummer past op hoogstens één regel.
 */
export const TELEFOON_LANDEN: Readonly<Record<string, TelefoonLand>> = {
  BE: { cc: "32", nul: "weg" },
  NL: { cc: "31", nul: "weg" },
  LU: { cc: "352", nul: "geen" },
  FR: { cc: "33", nul: "weg" },
  DE: { cc: "49", nul: "weg" },
  GB: { cc: "44", nul: "weg" },
  CH: { cc: "41", nul: "weg" },
  AT: { cc: "43", nul: "weg" },
  ES: { cc: "34", nul: "geen" },
  IT: { cc: "39", nul: "blijft" },
  MA: { cc: "212", nul: "weg" },
  TR: { cc: "90", nul: "weg" },
};

const E164 = /^\+[1-9]\d{7,14}$/;

function landVoorNummer(
  digits: string,
): { land: string; info: TelefoonLand } | null {
  for (const [land, info] of Object.entries(TELEFOON_LANDEN)) {
    if (digits.startsWith(info.cc)) return { land, info };
  }
  return null;
}

/**
 * Telefoonnummer in E.164 (`+32475123456`), of `null`.
 *
 * Wat erdoor gaat:
 * - onzichtbare tekens, spaties (ook NBSP) en `. / - ( )` worden verwijderd;
 * - `00` aan het begin is `+` (`0032475…`);
 * - de nul tussen haakjes na het landnummer valt weg (`+32 (0)3 480 12 34`),
 *   ook zonder haakjes (`+32 0475…`), voor de landen in `TELEFOON_LANDEN`;
 * - een nationaal nummer met nul (`0475…`, `06 1234 5678`) krijgt het landnummer
 *   van `standaardLand` (ISO-code of landnaam, standaard `"BE"`). Een nationaal
 *   nummer zonder nul voor een land dat die nul gebruikt, is `null`: we raden
 *   niet of `32475…` een landnummer is;
 * - controle: `^\+[1-9]\d{7,14}$`, België 8 of 9 cijfers na `+32`, Nederland 9
 *   cijfers na `+31`.
 *
 * @example
 * normaliseerTelefoon("\u202A0465 50 40 85\u202C"); // "+32465504085"
 * normaliseerTelefoon("0475/12.34.56");             // "+32475123456"
 * normaliseerTelefoon("+32 (0)3 480 12 34");        // "+3234801234"
 * normaliseerTelefoon("06 12345678", "NL");         // "+31612345678"
 * normaliseerTelefoon("hallo");                     // null
 */
export function normaliseerTelefoon(
  invoer: unknown,
  standaardLand: string = "BE",
): string | null {
  const ruw = alsTekst(invoer, 64);
  if (ruw === null) return null;
  let s = stripAlles(ruw);
  // Een "(0)" na het landnummer is een gewoon cijfer-ballast: weg vóór de haakjes.
  if (s.startsWith("+") || s.startsWith("00")) s = s.replace(/\(0\)/g, "");
  s = s.replace(/[./\-()]/g, "");
  if (!/^\+?\d+$/.test(s)) return null;

  let e164: string;
  if (s.startsWith("+") || s.startsWith("00")) {
    let digits = s.startsWith("+") ? s.slice(1) : s.slice(2);
    // "+32 0475…": de nationale nul hoort na het landnummer niet te staan.
    const gevonden = landVoorNummer(digits);
    if (gevonden && gevonden.info.nul === "weg") {
      const na = digits.slice(gevonden.info.cc.length);
      if (na.startsWith("0")) digits = gevonden.info.cc + na.slice(1);
    }
    e164 = "+" + digits;
  } else {
    const land = normaliseerLand(standaardLand);
    const info = land ? TELEFOON_LANDEN[land] : undefined;
    if (!info) return null;
    if (info.nul === "weg") {
      if (!s.startsWith("0")) return null;
      e164 = "+" + info.cc + s.slice(1);
    } else if (info.nul === "blijft") {
      e164 = "+" + info.cc + s;
    } else {
      if (s.startsWith("0")) return null;
      e164 = "+" + info.cc + s;
    }
  }

  if (!E164.test(e164)) return null;
  if (e164.startsWith("+32") && !/^\+32[1-9]\d{7,8}$/.test(e164)) return null;
  if (e164.startsWith("+31") && !/^\+31[1-9]\d{8}$/.test(e164)) return null;
  return e164;
}

/** Is dit een bruikbaar telefoonnummer? Zie `normaliseerTelefoon`. */
export function isGeldigTelefoon(
  invoer: unknown,
  standaardLand: string = "BE",
): boolean {
  return normaliseerTelefoon(invoer, standaardLand) !== null;
}

/**
 * Leesbare vorm van een E.164-nummer. Belgische nummers krijgen een groepering
 * (gsm `+32 475 12 34 56`, vast `+32 3 480 12 34` of `+32 14 12 34 56`), andere
 * landen `+CC rest`. Geen geldig E.164-nummer? Dan komt de invoer ongewijzigd
 * terug. Bewaar het nummer zelf altijd als E.164.
 *
 * @example
 * weergaveTelefoon("+32475123456"); // "+32 475 12 34 56"
 * weergaveTelefoon("+3234801234");  // "+32 3 480 12 34"
 * weergaveTelefoon("+31612345678"); // "+31 612345678"
 */
export function weergaveTelefoon(e164: string): string {
  if (typeof e164 !== "string" || !E164.test(e164)) return e164;
  const digits = e164.slice(1);
  if (digits.startsWith("32")) {
    const d = digits.slice(2);
    if (d.length === 9 && d.startsWith("4")) {
      return `+32 ${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 7)} ${
        d.slice(7)
      }`;
    }
    if (d.length === 8) {
      if ("2349".includes(d[0])) {
        return `+32 ${d[0]} ${d.slice(1, 4)} ${d.slice(4, 6)} ${d.slice(6)}`;
      }
      return `+32 ${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 6)} ${
        d.slice(6)
      }`;
    }
    return `+32 ${d}`;
  }
  const gevonden = landVoorNummer(digits);
  if (!gevonden) return e164;
  return `+${gevonden.info.cc} ${digits.slice(gevonden.info.cc.length)}`;
}

// ───────────── Postcode ─────────────

/** Voorvoegsels die mensen voor een postcode zetten: `B-1000`, `L-1234`. */
const POSTCODE_VOORVOEGSEL: Record<string, RegExp> = {
  BE: /^(?:BE|B)\s?-?\s?/,
  NL: /^NL\s?-?\s?/,
  LU: /^(?:LU|L)\s?-?\s?/,
  DE: /^(?:DE|D)\s?-?\s?/,
  FR: /^(?:FR|F)\s?-?\s?/,
};

/**
 * Postcode in de vaste schrijfwijze van het land, of `null`.
 *
 * | land | regel                                                        |
 * | ---- | ------------------------------------------------------------ |
 * | BE   | 4 cijfers, eerste 1-9                                         |
 * | NL   | `1234 AB`: eerste cijfer 1-9, letters niet SA, SD of SS      |
 * | LU   | 4 cijfers (`L-1234` mag)                                      |
 * | DE   | 5 cijfers                                                     |
 * | FR   | 5 cijfers                                                     |
 * | rest | hoofdletters, cijfers, spatie en koppelteken, hoogstens 12   |
 *
 * `land` is een ISO-code of landnaam (via `normaliseerLand`). Ontbreekt het of
 * is het onbekend, dan geldt de regel voor "rest".
 *
 * @example
 * normaliseerPostcode("\u200E2000 ", "BE");     // "2000"
 * normaliseerPostcode("1234ab", "NL");          // "1234 AB"
 * normaliseerPostcode("L-1234", "LU");          // "1234"
 * normaliseerPostcode("sw1a 1aa", "GB");        // "SW1A 1AA"
 * normaliseerPostcode("0123", "BE");            // null
 */
export function normaliseerPostcode(
  invoer: unknown,
  land?: unknown,
): string | null {
  const ruw = alsTekst(invoer, 64);
  if (ruw === null) return null;
  let s = schoonRegel(ruw).toUpperCase();
  if (s === "") return null;
  const code = land === undefined || land === null
    ? null
    : normaliseerLand(land);
  const voorvoegsel = code ? POSTCODE_VOORVOEGSEL[code] : undefined;
  if (voorvoegsel && /^[A-Z]{1,2}\s?-?\s?\d/.test(s)) {
    s = s.replace(voorvoegsel, "");
  }
  switch (code) {
    case "BE":
      return /^[1-9]\d{3}$/.test(s) ? s : null;
    case "NL": {
      const m = /^([1-9]\d{3}) ?([A-Z]{2})$/.exec(s);
      if (!m || ["SA", "SD", "SS"].includes(m[2])) return null;
      return `${m[1]} ${m[2]}`;
    }
    case "LU":
      return /^\d{4}$/.test(s) ? s : null;
    case "DE":
    case "FR":
      return /^\d{5}$/.test(s) ? s : null;
    default:
      return s.length <= 12 && /^[A-Z0-9][A-Z0-9 -]*$/.test(s) ? s : null;
  }
}

/** Is dit een bruikbare postcode voor dit land? Zie `normaliseerPostcode`. */
export function isGeldigPostcode(invoer: unknown, land?: unknown): boolean {
  return normaliseerPostcode(invoer, land) !== null;
}

// ───────────── Ondernemingsnummer en btw ─────────────

/** Modulo 97 van een cijferstring, zonder grote getallen. */
function mod97(cijfers: string): number {
  let rest = 0;
  for (let i = 0; i < cijfers.length; i++) {
    rest = (rest * 10 + (cijfers.charCodeAt(i) - 48)) % 97;
  }
  return rest;
}

/** Tien cijfers; eerste 0 of 1; laatste twee = 97 min (eerste acht mod 97). */
function geldigKbo(tien: string): boolean {
  if (!/^[01]\d{9}$/.test(tien)) return false;
  const controle = 97 - mod97(tien.slice(0, 8));
  return controle === Number(tien.slice(8));
}

/** Haalt een Belgisch nummer (met of zonder `BE`) naar tien cijfers, of `null`. */
function kboCijfers(s: string): string | null {
  let rest = s.toUpperCase().replace(/^BE/, "").replace(/[.\-/]/g, "");
  if (!/^\d{9,10}$/.test(rest)) return null;
  if (rest.length === 9) rest = "0" + rest;
  return geldigKbo(rest) ? rest : null;
}

/**
 * Belgisch ondernemingsnummer (KBO) als tien cijfers (`0403019261`), of `null`.
 * Neemt `0403.019.261`, `BE 0403 019 261`, `BE0403019261` en de oude vorm van
 * negen cijfers (krijgt een nul vooraan). Eerste cijfer 0 of 1; de laatste twee
 * cijfers moeten kloppen volgens modulo 97.
 *
 * @example
 * normaliseerOndernemingsnummer("BE 0403.019.261"); // "0403019261"
 * normaliseerOndernemingsnummer("403019261");       // "0403019261"
 * normaliseerOndernemingsnummer("0403019262");      // null (controlegetal)
 */
export function normaliseerOndernemingsnummer(invoer: unknown): string | null {
  const ruw = alsTekst(invoer, 64);
  if (ruw === null) return null;
  return kboCijfers(stripAlles(ruw));
}

/** Is dit een geldig ondernemingsnummer? */
export function isGeldigOndernemingsnummer(invoer: unknown): boolean {
  return normaliseerOndernemingsnummer(invoer) !== null;
}

/**
 * `0403.019.261` voor een genormaliseerd of los ondernemingsnummer. Geldt het
 * niet als nummer, dan komt de invoer ongewijzigd terug (als tekst).
 *
 * @example
 * weergaveOndernemingsnummer("0403019261"); // "0403.019.261"
 */
export function weergaveOndernemingsnummer(invoer: unknown): string {
  const n = normaliseerOndernemingsnummer(invoer);
  if (n === null) return typeof invoer === "string" ? invoer : "";
  return `${n.slice(0, 4)}.${n.slice(4, 7)}.${n.slice(7)}`;
}

/** Btw-landen: landcode, vorm van wat na de code komt. */
const BTW_REGELS: Record<string, RegExp> = {
  BE: /^[01]\d{9}$/, // daarna ook de KBO-controle
  NL: /^\d{9}B\d{2}$/,
  LU: /^\d{8}$/,
  FR: /^[A-Z0-9]{2}\d{9}$/,
  DE: /^\d{9}$/,
};

/**
 * Btw-nummer met landcode zonder leestekens, of `null`: `BE0403019261`,
 * `NL123456789B01`, `LU12345678`, `FR12345678901` (twee tekens plus negen
 * cijfers), `DE123456789`.
 *
 * De landcode komt uit de invoer (`BE 0403.019.261`) of anders uit `land`
 * (ISO-code of naam). Staat er in de invoer een van deze vijf landcodes, dan
 * wint die. Zonder landcode en zonder `land` is het `null`: we raden niet.
 * België gaat door dezelfde controle als het ondernemingsnummer (negen cijfers
 * krijgen een nul voor). De andere landen krijgen enkel een vormcontrole, geen
 * controlecijfer.
 *
 * @example
 * normaliseerBtw("BE 0403.019.261");        // "BE0403019261"
 * normaliseerBtw("0403.019.261", "BE");     // "BE0403019261"
 * normaliseerBtw("nl 1234.56.789.B01");     // "NL123456789B01"
 * normaliseerBtw("0403019261");             // null (welk land?)
 */
export function normaliseerBtw(invoer: unknown, land?: unknown): string | null {
  const ruw = alsTekst(invoer, 64);
  if (ruw === null) return null;
  const s = stripAlles(ruw).toUpperCase().replace(/[.\-/]/g, "");
  if (s === "") return null;

  const letters = s.slice(0, 2);
  let code: string;
  let rest: string;
  if (/^[A-Z]{2}/.test(s) && letters in BTW_REGELS) {
    code = letters;
    rest = s.slice(2);
  } else {
    const uitLand = land === undefined || land === null
      ? null
      : normaliseerLand(land);
    if (!uitLand || !(uitLand in BTW_REGELS)) return null;
    code = uitLand;
    rest = s;
  }

  if (code === "BE") {
    const kbo = kboCijfers(rest);
    return kbo === null ? null : "BE" + kbo;
  }
  return BTW_REGELS[code].test(rest) ? code + rest : null;
}

/** Is dit een bruikbaar btw-nummer? Zie `normaliseerBtw`. */
export function isGeldigBtw(invoer: unknown, land?: unknown): boolean {
  return normaliseerBtw(invoer, land) !== null;
}

// ───────────── IBAN ─────────────

/**
 * Lengte van een IBAN per land (ISO 13616). Landen die hier niet staan zijn
 * ongeldig. Uitbreiden: voeg een regel toe.
 */
export const IBAN_LENGTES: Readonly<Record<string, number>> = {
  AT: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  TR: 26,
};

/**
 * IBAN in hoofdletters zonder spaties, of `null`: de landlengte uit
 * `IBAN_LENGTES` en het controlegetal (modulo 97) moeten kloppen. Spaties (ook
 * NBSP), onzichtbare tekens, punten en koppeltekens worden genegeerd.
 *
 * @example
 * normaliseerIban("be68 5390 0754 7034");  // "BE68539007547034"
 * normaliseerIban("BE68 5390 0754 7035");  // null (controlegetal)
 */
export function normaliseerIban(invoer: unknown): string | null {
  const ruw = alsTekst(invoer, 100);
  if (ruw === null) return null;
  const s = stripAlles(ruw).toUpperCase().replace(/[.\-]/g, "");
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return null;
  if (IBAN_LENGTES[s.slice(0, 2)] !== s.length) return null;
  const omgezet = (s.slice(4) + s.slice(0, 4)).replace(
    /[A-Z]/g,
    (c) => String(c.charCodeAt(0) - 55),
  );
  return mod97(omgezet) === 1 ? s : null;
}

/** Is dit een geldige IBAN? */
export function isGeldigIban(invoer: unknown): boolean {
  return normaliseerIban(invoer) !== null;
}

/**
 * IBAN in groepen van vier (`BE68 5390 0754 7034`). Geldt het niet als IBAN,
 * dan komt de invoer ongewijzigd terug (als tekst).
 *
 * @example
 * weergaveIban("BE68539007547034"); // "BE68 5390 0754 7034"
 */
export function weergaveIban(invoer: unknown): string {
  const n = normaliseerIban(invoer);
  if (n === null) return typeof invoer === "string" ? invoer : "";
  return n.replace(/(.{4})(?=.)/g, "$1 ");
}

// ───────────── URL ─────────────

/**
 * Webadres als `href`, of `null`. Onzichtbare tekens en spaties aan de rand
 * vallen weg; zonder schema komt `https://` ervoor. Alleen `http` en `https`:
 * `javascript:`, `data:`, `mailto:`, `file:` enz. zijn `null`. De host moet een
 * punt hebben (`localhost` en IPv6 vallen af), er mogen geen spaties in staan,
 * en een adres met gebruikersnaam of wachtwoord (`user:pw@host`) is `null`.
 * Hoogstens 2048 tekens. De href is wat `new URL` teruggeeft: een kale host
 * krijgt een slash achteraan en de host gaat naar kleine letters.
 *
 * @example
 * normaliseerUrl("\u200E www.Example.be ");   // "https://www.example.be/"
 * normaliseerUrl("http://example.be/a?b=1");  // "http://example.be/a?b=1"
 * normaliseerUrl("javascript:alert(1)");      // null
 * normaliseerUrl("localhost:3000");           // null
 */
export function normaliseerUrl(invoer: unknown): string | null {
  const ruw = alsTekst(invoer, 2048);
  if (ruw === null) return null;
  const s = stripRand(ruw);
  if (s === "" || /[\s\u0085\p{Z}\p{Cc}]/u.test(s)) return null;

  let kandidaat: string;
  if (/^https?:\/\//i.test(s)) {
    kandidaat = s;
  } else if (s.startsWith("//")) {
    kandidaat = "https:" + s;
  } else if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(s)) {
    // Een ander schema (mailto:, javascript:, ftp:), geen `host:poort`.
    return null;
  } else {
    kandidaat = "https://" + s;
  }

  let url: URL;
  try {
    url = new URL(kandidaat);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname;
  if (!host.includes(".") || host.split(".").some((deel) => deel === "")) {
    return null;
  }
  return url.href;
}

/** Is dit een bruikbaar http(s)-adres? Zie `normaliseerUrl`. */
export function isGeldigUrl(invoer: unknown): boolean {
  return normaliseerUrl(invoer) !== null;
}

// ───────────── Postgres ─────────────

/**
 * De Postgres-kant van deze module (`norm_regel`, `norm_email`, `email_geldig`,
 * `norm_telefoon`, `norm_postcode`), voor een migratie van de app. Zelfde tekst
 * als `sql/velden.sql` in het pakket; een test houdt de twee gelijk.
 *
 * Gebruik: kopieer de tekst in `supabase/migrations/<stempel>_velden.sql`, of
 * schrijf ze er vanuit een script heen. Idempotent (`create or replace`).
 */
export const VELDEN_SQL: string = String
  .raw`-- velden uit @holie/tools 0.31.0: Postgres-kant van ./velden (velden.ts).
-- Kopieer in een migratie van de app. Idempotent: opnieuw draaien verandert niets.
--
-- Waarom: iOS en kopieer-plak zetten onzichtbare opmaaktekens (Unicode Cf:
-- U+200B-U+200F, U+202A-U+202E, U+2060-U+2064, U+FEFF) en NBSP (U+00A0,
-- U+202F) in een veld. btrim() haalt die niet weg. Deze functies wel, met
-- dezelfde regels als velden.ts. Gebruik ze in triggers, check-constraints en
-- generated columns, naast (niet in plaats van) de normalisatie in het scherm.
--
-- Verschillen met velden.ts:
-- - norm_telefoon en norm_postcode nemen enkel een ISO alpha-2-code als land
--   (BE, NL, ...), geen landnaam. Normaliseer de naam eerst met normaliseerLand.
-- - norm_regel en norm_email geven null bij null; een leeg resultaat is bij
--   norm_email ook null (bij norm_regel een lege tekst).
-- - lower() maakt in Postgres van I met punt (U+0130) een teken, JavaScript twee:
--   alleen een adres van ~254 tekens vol met dat teken krijgt een ander oordeel.
-- - Landentabel voor telefoon: dezelfde als TELEFOON_LANDEN in velden.ts. Breid
--   op beide plaatsen uit.

-- Onzichtbare opmaaktekens (Cf) weg, overal in de tekst.
create or replace function public.strip_cf(t text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(
    t,
    '[\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0001\U000E0020-\U000E007F]',
    '',
    'g'
  )
$$;

-- Tekst van een regel: Cf weg, elke soort spatie (NBSP, regeleinden, tabs) een
-- gewone spatie, dubbele spaties samen, begin en einde af.
create or replace function public.norm_regel(t text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(
    regexp_replace(
      public.strip_cf(t),
      '[\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+',
      ' ',
      'g'
    ),
    ' '
  )
$$;

-- E-mail: Cf overal weg, spaties aan de rand af, kleine letters. Geeft de
-- opgeschoonde tekst terug, ook als het geen geldig adres is (zie email_geldig);
-- null bij null of leeg.
create or replace function public.norm_email(t text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(
    lower(
      regexp_replace(
        public.strip_cf(t),
        '^[\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$',
        '',
        'g'
      )
    ),
    ''
  )
$$;

-- Is dit een bruikbaar adres? Zelfde regels als normaliseerEmail: hoogstens 254
-- tekens (ook v\u00F3\u00F3r het strippen), geen spaties of stuurtekens midden in het
-- adres, geen punt vooraan, achteraan of dubbel in het lokale deel, geen
-- <>"(),;:\[], domein enkel letters, cijfers en koppeltekens per label.
create or replace function public.email_geldig(t text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    length(t) <= 254
    and length(n) <= 254
    and n ~ '^[^\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000@.<>"(),;:\\\[\]\u0001-\u001F\u007F-\u009F]+(\.[^\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000@.<>"(),;:\\\[\]\u0001-\u001F\u007F-\u009F]+)*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$',
    false
  )
  from (select public.norm_email(t) as n) x
$$;

-- Telefoon naar E.164 (+32475123456), of null. Regels: zie normaliseerTelefoon.
-- De tabel hieronder is "land:landnummer:nationale nul" (weg = nul valt weg,
-- blijft = nul hoort bij het nummer, geen = land kent geen nul).
create or replace function public.norm_telefoon(
  t text,
  standaard_land text default 'BE'
)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  landen constant text[] := array[
    'BE:32:weg', 'NL:31:weg', 'LU:352:geen', 'FR:33:weg', 'DE:49:weg',
    'GB:44:weg', 'CH:41:weg', 'AT:43:weg', 'ES:34:geen', 'IT:39:blijft',
    'MA:212:weg', 'TR:90:weg'
  ];
  s text;
  digits text;
  e164 text;
  land text := upper(btrim(coalesce(standaard_land, '')));
  c text;
  nul text;
  rij text;
  delen text[];
begin
  if t is null or length(t) > 64 then
    return null;
  end if;

  s := regexp_replace(
    public.strip_cf(t),
    '[\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+',
    '',
    'g'
  );
  -- "(0)" na het landnummer is ballast: weg v\u00F3\u00F3r de haakjes zelf verdwijnen.
  if s like '+%' or s like '00%' then
    s := replace(s, '(0)', '');
  end if;
  s := regexp_replace(s, '[./()-]', '', 'g');
  if s !~ '^\+?[0-9]+$' then
    return null;
  end if;

  if s like '+%' or s like '00%' then
    digits := case when s like '+%' then substr(s, 2) else substr(s, 3) end;
    -- "+32 0475...": de nationale nul hoort na het landnummer niet te staan.
    foreach rij in array landen loop
      delen := string_to_array(rij, ':');
      if digits like delen[2] || '%' then
        if delen[3] = 'weg'
           and substr(digits, length(delen[2]) + 1, 1) = '0' then
          digits := delen[2] || substr(digits, length(delen[2]) + 2);
        end if;
        exit;
      end if;
    end loop;
    e164 := '+' || digits;
  else
    foreach rij in array landen loop
      delen := string_to_array(rij, ':');
      if delen[1] = land then
        c := delen[2];
        nul := delen[3];
      end if;
    end loop;
    if c is null then
      return null;
    end if;
    if nul = 'weg' then
      if s not like '0%' then
        return null;
      end if;
      e164 := '+' || c || substr(s, 2);
    elsif nul = 'blijft' then
      e164 := '+' || c || s;
    else
      if s like '0%' then
        return null;
      end if;
      e164 := '+' || c || s;
    end if;
  end if;

  if e164 !~ '^\+[1-9][0-9]{7,14}$' then
    return null;
  end if;
  if e164 like '+32%' and e164 !~ '^\+32[1-9][0-9]{7,8}$' then
    return null;
  end if;
  if e164 like '+31%' and e164 !~ '^\+31[1-9][0-9]{8}$' then
    return null;
  end if;
  return e164;
end
$$;

-- Postcode in de vaste schrijfwijze van het land, of null. land = ISO alpha-2.
-- BE 4 cijfers (eerste 1-9); NL "1234 AB" (niet SA, SD, SS); LU 4 cijfers;
-- DE en FR 5 cijfers; rest: A-Z 0-9 spatie koppelteken, hoogstens 12 tekens.
create or replace function public.norm_postcode(t text, land text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  s text;
  l text := upper(btrim(coalesce(land, '')));
  m text[];
begin
  if t is null or length(t) > 64 then
    return null;
  end if;
  s := upper(public.norm_regel(t));
  if s = '' then
    return null;
  end if;

  -- Voorvoegsel zoals B-1000 of L-1234.
  if l in ('BE', 'NL', 'LU', 'DE', 'FR') and s ~ '^[A-Z]{1,2} ?-? ?[0-9]' then
    s := regexp_replace(
      s,
      case l
        when 'BE' then '^(BE|B) ?-? ?'
        when 'NL' then '^NL ?-? ?'
        when 'LU' then '^(LU|L) ?-? ?'
        when 'DE' then '^(DE|D) ?-? ?'
        else '^(FR|F) ?-? ?'
      end,
      ''
    );
  end if;

  if l = 'BE' then
    return case when s ~ '^[1-9][0-9]{3}$' then s end;
  elsif l = 'NL' then
    m := regexp_match(s, '^([1-9][0-9]{3}) ?([A-Z]{2})$');
    if m is null or m[2] in ('SA', 'SD', 'SS') then
      return null;
    end if;
    return m[1] || ' ' || m[2];
  elsif l = 'LU' then
    return case when s ~ '^[0-9]{4}$' then s end;
  elsif l in ('DE', 'FR') then
    return case when s ~ '^[0-9]{5}$' then s end;
  end if;
  return case
    when length(s) <= 12 and s ~ '^[A-Z0-9][A-Z0-9 -]*$' then s
  end;
end
$$;
`;
