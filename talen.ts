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
  { code: "nl", label: "Nederlands", vlag: "🇳🇱", richting: "ltr", locale: "nl_BE" },
  { code: "en", label: "English", vlag: "🇬🇧", richting: "ltr", locale: "en_GB" },
  { code: "fr", label: "Français", vlag: "🇫🇷", richting: "ltr", locale: "fr_BE" },
  { code: "de", label: "Deutsch", vlag: "🇩🇪", richting: "ltr", locale: "de_DE" },
  { code: "es", label: "Español", vlag: "🇪🇸", richting: "ltr", locale: "es_ES" },
  { code: "pt", label: "Português", vlag: "🇧🇷", richting: "ltr", locale: "pt_BR" },
  { code: "ar", label: "العربية", vlag: "🇸🇦", richting: "rtl", locale: "ar_SA" },
  { code: "pl", label: "Polski", vlag: "🇵🇱", richting: "ltr", locale: "pl_PL" },
  { code: "ja", label: "日本語", vlag: "🇯🇵", richting: "ltr", locale: "ja_JP" },
  { code: "tr", label: "Türkçe", vlag: "🇹🇷", richting: "ltr", locale: "tr_TR" },
  { code: "it", label: "Italiano", vlag: "🇮🇹", richting: "ltr", locale: "it_IT" },
];

export interface TaalInstelling {
  beschikbaar: string[];
  actief: string[];
  bron: string;
  terugval: string;
}

const uniek = (codes: string[]) => [...new Set(codes)];

/**
 * Maakt van een opgeslagen waarde (JSON-tekst of object) een geldige instelling.
 * Onbekende codes vallen weg, `bron` is altijd beschikbaar en actief, `actief` is een
 * deelverzameling van `beschikbaar`, en `terugval` is altijd actief. Kapotte of lege
 * invoer geeft de standaard terug: een tikfout in de admin mag de site niet leegmaken.
 */
export function normaliseerInstelling(
  ruw: unknown,
  standaard: TaalInstelling,
  gekend: readonly string[] = TAALCATALOGUS.map((t) => t.code),
): TaalInstelling {
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

  const lijst = (v: unknown, anders: string[]) =>
    Array.isArray(v) ? uniek(v.filter((c): c is string => typeof c === "string" && gekend.includes(c))) : anders;

  const bron = typeof o.bron === "string" && gekend.includes(o.bron) ? o.bron : standaard.bron;
  const beschikbaar = uniek([bron, ...lijst(o.beschikbaar, standaard.beschikbaar)]);
  const actief = uniek([bron, ...lijst(o.actief, standaard.actief).filter((c) => beschikbaar.includes(c))]);
  const terugval = typeof o.terugval === "string" && actief.includes(o.terugval) ? o.terugval : bron;

  return { beschikbaar, actief, bron, terugval };
}

export const isActief = (inst: TaalInstelling, code: string | null | undefined): boolean =>
  !!code && inst.actief.includes(code);

export const isBeschikbaar = (inst: TaalInstelling, code: string | null | undefined): boolean =>
  !!code && inst.beschikbaar.includes(code);

/**
 * Talen waarnaar vertaald mag worden: actief, zonder de bron. Met `gevraagd` blijft
 * enkel de doorsnede over, zodat een oude aanroeper die "alle talen" vraagt geen
 * uitgeschakelde taal meer aanmaakt.
 */
export function doelTalen(inst: TaalInstelling, gevraagd?: readonly string[] | null): string[] {
  const doel = inst.actief.filter((c) => c !== inst.bron);
  return gevraagd && gevraagd.length ? doel.filter((c) => gevraagd.includes(c)) : doel;
}

/** De taal zelf als ze actief is, anders de terugvaltaal. */
export const vervangTaal = (inst: TaalInstelling, code: string): string =>
  isActief(inst, code) ? code : inst.terugval;

export const taalInfo = (code: string): TaalInfo | undefined => TAALCATALOGUS.find((t) => t.code === code);
