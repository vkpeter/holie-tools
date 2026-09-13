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
