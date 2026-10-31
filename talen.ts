// Talenkern: welke talen een site kent, aanbiedt en actief gebruikt.
//
// Pure logica zonder imports, zodat hetzelfde bestand zowel in een browser-app als in
// een edge function draait.
//
// - beschikbaar: talen waarvoor de site nog inhoud leest (oude slugs blijven werken)
// - actief: talen die de bezoeker ziet en waarnaar nog vertaald wordt
// - bron: de taal waarin geschreven wordt, altijd actief
// - terugval: waar een niet-actieve taal naartoe verwijst

export interface TaalInfo {
  code: string;
  label: string;
  vlag: string;
  richting: "ltr" | "rtl";
  locale: string;
}

export const TAALCATALOGUS: readonly TaalInfo[] = [
  {
    code: "nl",
    label: "Nederlands",
    vlag: "🇳🇱",
    richting: "ltr",
    locale: "nl_BE",
  },
  {
    code: "en",
    label: "English",
    vlag: "🇬🇧",
    richting: "ltr",
    locale: "en_GB",
  },
  {
    code: "fr",
    label: "Français",
    vlag: "🇫🇷",
    richting: "ltr",
    locale: "fr_BE",
  },
  {
    code: "de",
    label: "Deutsch",
    vlag: "🇩🇪",
    richting: "ltr",
    locale: "de_DE",
  },
  {
    code: "es",
    label: "Español",
    vlag: "🇪🇸",
    richting: "ltr",
    locale: "es_ES",
  },
  {
    code: "pt",
    label: "Português",
    vlag: "🇧🇷",
    richting: "ltr",
    locale: "pt_BR",
  },
  {
    code: "ar",
    label: "العربية",
    vlag: "🇸🇦",
    richting: "rtl",
    locale: "ar_SA",
  },
  { code: "pl", label: "Polski", vlag: "🇵🇱", richting: "ltr", locale: "pl_PL" },
  { code: "ja", label: "日本語", vlag: "🇯🇵", richting: "ltr", locale: "ja_JP" },
  { code: "tr", label: "Türkçe", vlag: "🇹🇷", richting: "ltr", locale: "tr_TR" },
  {
    code: "it",
    label: "Italiano",
    vlag: "🇮🇹",
    richting: "ltr",
    locale: "it_IT",
  },
];

/**
 * Taalinstelling van een site. De generiek is optioneel: een project met een letterlijke
 * union (bv. `type Lang = "nl" | "en"`) schrijft `TaalInstelling<Lang>` en hoeft niet
 * te casten. Zonder generiek blijft alles `string`.
 */
export interface TaalInstelling<T extends string = string> {
  beschikbaar: T[];
  actief: T[];
  bron: T;
  terugval: T;
}

const uniek = <T>(codes: T[]): T[] => [...new Set(codes)];

/**
 * Maakt van een opgeslagen waarde (JSON-tekst of object) een geldige instelling.
 * Onbekende codes vallen weg, `bron` is altijd beschikbaar en actief, `actief` is een
 * deelverzameling van `beschikbaar`, en `terugval` is altijd actief. Kapotte of lege
 * invoer geeft de standaard terug: een tikfout in de admin mag de site niet leegmaken.
 */
export function normaliseerInstelling<T extends string = string>(
  ruw: unknown,
  standaard: TaalInstelling<T>,
  gekend: readonly T[] = TAALCATALOGUS.map((t) => t.code) as unknown as T[],
): TaalInstelling<T> {
  let obj: unknown = ruw;
  if (typeof ruw === "string") {
    try {
      obj = JSON.parse(ruw);
    } catch {
      return standaard;
    }
  }
  if (!obj || typeof obj !== "object") return standaard;
  const o = obj as Record<string, unknown>;

  const isGekend = (c: unknown): c is T =>
    typeof c === "string" && (gekend as readonly string[]).includes(c);
  const lijst = (v: unknown, anders: T[]): T[] =>
    Array.isArray(v) ? uniek(v.filter(isGekend)) : anders;

  const bron: T = isGekend(o["bron"]) ? o["bron"] : standaard.bron;
  const beschikbaar = uniek([
    bron,
    ...lijst(o["beschikbaar"], standaard.beschikbaar),
  ]);
  const actief = uniek([
    bron,
    ...lijst(o["actief"], standaard.actief).filter((c) =>
      beschikbaar.includes(c)
    ),
  ]);
  const terugval: T = isGekend(o["terugval"]) && actief.includes(o["terugval"])
    ? o["terugval"]
    : bron;

  return { beschikbaar, actief, bron, terugval };
}

export const isActief = <T extends string>(
  inst: TaalInstelling<T>,
  code: string | null | undefined,
): code is T => !!code && (inst.actief as readonly string[]).includes(code);

export const isBeschikbaar = <T extends string>(
  inst: TaalInstelling<T>,
  code: string | null | undefined,
): code is T =>
  !!code && (inst.beschikbaar as readonly string[]).includes(code);

/**
 * Talen waarnaar vertaald mag worden: actief, zonder de bron. Met `gevraagd` blijft
 * enkel de doorsnede over, zodat een oude aanroeper die "alle talen" vraagt geen
 * uitgeschakelde taal meer aanmaakt.
 */
export function doelTalen<T extends string>(
  inst: TaalInstelling<T>,
  gevraagd?: readonly string[] | null,
): T[] {
  const doel = inst.actief.filter((c) => c !== inst.bron);
  return gevraagd && gevraagd.length
    ? doel.filter((c) => gevraagd.includes(c))
    : doel;
}

/** De taal zelf als ze actief is, anders de terugvaltaal. */
export const vervangTaal = <T extends string>(
  inst: TaalInstelling<T>,
  code: string,
): T => isActief(inst, code) ? code : inst.terugval;

export const taalInfo = (code: string): TaalInfo | undefined =>
  TAALCATALOGUS.find((t) => t.code === code);

// ---------------------------------------------------------------------------
// Taalkeuze per verzoek: cookie, dan Accept-Language (met q-gewichten), dan standaard.
// Runtime-neutraal: werkt op de server (Request-headers) en in de browser
// (`document.cookie`, `navigator.languages`).
// ---------------------------------------------------------------------------

/** Eén taal uit een Accept-Language-header, met haar gewicht. */
export interface TaalVoorkeur {
  /** De taalcode zoals opgegeven, in kleine letters, bv. `nl-be` of `*`. */
  tag: string;
  /** Gewicht tussen 0 en 1; zonder `q=` is dat 1. */
  q: number;
}

/**
 * Ontleedt een Accept-Language-header tot een lijst, van hoogste naar laagste gewicht.
 * Bij gelijk gewicht blijft de volgorde van de header. Een rij (bv. `navigator.languages`)
 * mag ook: elk element telt dan als een ingang met gewicht 1, in die volgorde.
 * Ongeldige ingangen en ingangen met `q=0` ("niet gewenst") vallen weg.
 */
export function ontleedAcceptLanguage(
  header: string | readonly string[] | null | undefined,
): TaalVoorkeur[] {
  const tekst = typeof header === "string" ? header : (header ?? []).join(",");
  const uit: (TaalVoorkeur & { i: number })[] = [];
  tekst.split(",").forEach((ingang, i) => {
    const [tagDeel, ...params] = ingang.split(";");
    const tag = tagDeel.trim().toLowerCase().replace(/_/g, "-");
    if (!/^(\*|[a-z]{1,8}(-[a-z0-9]{1,8})*)$/.test(tag)) return;
    let q = 1;
    for (const p of params) {
      const m = p.trim().match(/^q\s*=\s*(.*)$/i);
      if (m) q = /^[0-9.]+$/.test(m[1].trim()) ? Number(m[1]) : NaN;
    }
    if (!Number.isFinite(q) || q <= 0) return;
    uit.push({ tag, q: Math.min(q, 1), i });
  });
  return uit
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map(({ tag, q }) => ({ tag, q }));
}

/**
 * De taal uit `talen` die bij `waarde` past, of `undefined`. Eerst een exacte match
 * (hoofdletterongevoelig, `pt-BR` = `pt-br`), dan op de hoofdtaal: `nl-BE` wordt `nl`.
 * Andersom niet: een site met enkel `pt-BR` neemt `pt` niet aan.
 */
export function pasTaal<T extends string>(
  waarde: string | null | undefined,
  talen: readonly T[],
): T | undefined {
  const w = (waarde ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!w) return undefined;
  const exact = talen.find((t) => t.toLowerCase() === w);
  if (exact) return exact;
  const hoofd = w.split("-")[0];
  return talen.find((t) => t.toLowerCase() === hoofd);
}

/**
 * Een losse taalwaarde (uit een URL, cookie of `navigator.language`) naar een taal van
 * de site, anders `standaard`. Vervangt de `normalizeLanguage` die projecten zelf
 * schreven met `slice(0, 2)`.
 */
export function normaliseerTaal<T extends string>(
  waarde: string | null | undefined,
  talen: readonly T[],
  standaard: T,
): T {
  return pasTaal(waarde, talen) ?? standaard;
}

/**
 * De waarde van één cookie uit een Cookie-header of `document.cookie`
 * (`"a=1; b=2"`), URL-gedecodeerd. `undefined` als ze ontbreekt.
 */
export function leesCookie(
  header: string | null | undefined,
  naam: string,
): string | undefined {
  for (const deel of (header ?? "").split(";")) {
    const is = deel.indexOf("=");
    if (is < 0 || deel.slice(0, is).trim() !== naam) continue;
    const ruw = deel.slice(is + 1).trim().replace(/^"(.*)"$/, "$1");
    try {
      return decodeURIComponent(ruw);
    } catch {
      return ruw;
    }
  }
  return undefined;
}

export interface KiesTaalOpties<T extends string> {
  /** De talen die de site aanbiedt, bv. `TAAL_INSTELLING.actief`. */
  talen: readonly T[];
  /** Taal als niets past, bv. `TAAL_INSTELLING.terugval`. */
  standaard: T;
  /**
   * De Cookie-header van het verzoek, of `document.cookie` in de browser. Wordt enkel
   * gelezen als ook `cookieNaam` gezet is.
   */
  cookie?: string | null;
  /** Naam van de taalcookie, bv. `"ese.lang"`. */
  cookieNaam?: string;
  /** De Accept-Language-header, of `navigator.languages` in de browser. */
  acceptLanguage?: string | readonly string[] | null;
}

/**
 * Kiest de taal voor een verzoek, in deze volgorde:
 *
 * 1. de taalcookie, als die een taal van de site bevat (een keuze van de bezoeker);
 * 2. Accept-Language: de ingang met het hoogste q-gewicht die bij een taal van de site
 *    past, met terugval op de hoofdtaal (`fr-CH` wordt `fr`); `*` geeft `standaard`;
 * 3. `standaard`.
 *
 * Verschil met de oude projectkopieën: die lazen enkel de eerste ingang van
 * Accept-Language (`es-ES,nl;q=0.8` gaf de standaard in plaats van `nl`), en een cookie
 * met een onbekende taal gaf meteen de standaard. Hier valt zo'n cookie door naar
 * Accept-Language.
 */
export function kiesTaal<T extends string>(opties: KiesTaalOpties<T>): T {
  const { talen, standaard, cookie, cookieNaam, acceptLanguage } = opties;
  if (cookieNaam) {
    const uitCookie = pasTaal(leesCookie(cookie, cookieNaam), talen);
    if (uitCookie) return uitCookie;
  }
  for (const { tag } of ontleedAcceptLanguage(acceptLanguage)) {
    if (tag === "*") return standaard;
    const taal = pasTaal(tag, talen);
    if (taal) return taal;
  }
  return standaard;
}
