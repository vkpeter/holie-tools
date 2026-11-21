// Holie-credit in de voet van een site: één bron voor de teksten, zodat een naamwissel
// één wijziging is. Pure data en logica zonder imports (draait in elke bundler en Worker).
//
// Regel (vault: _Werkwijze/WERKWIJZE-holie-credit.md, 21 nov 2026):
// - "eigen": eigen product van Holie (Nilou, Eendje, Tickbook, Roundbook, Arrif, ...)
// - "klant": klantsite waar de klant zijn eigen product of dienst verkoopt (Eagle-Eye, ese, ...)
// Altijd een link naar HOLIE_URL, klein, onderaan de voet.

export type CreditSoort = "eigen" | "klant";
export type CreditTaal =
  | "nl"
  | "fr"
  | "de"
  | "en"
  | "es"
  | "pt"
  | "ar"
  | "pl"
  | "ja"
  | "tr";

export const HOLIE_NAAM = "holie.be";
export const HOLIE_URL = "https://holie.be";

// nl/fr/de/en voor beide soorten. es/pt/ar/pl/ja/tr enkel voor "eigen" (Eendje, zes extra
// talen); een klantsite valt daar terug op het Engels.
export const CREDIT_TEKSTEN: Readonly<
  Record<CreditSoort, Readonly<Partial<Record<CreditTaal, string>>>>
> = {
  eigen: {
    nl: `Gemaakt door ${HOLIE_NAAM}`,
    fr: `Réalisé par ${HOLIE_NAAM}`,
    de: `Entwickelt von ${HOLIE_NAAM}`,
    en: `Built by ${HOLIE_NAAM}`,
    es: `Creado por ${HOLIE_NAAM}`,
    pt: `Criado por ${HOLIE_NAAM}`,
    ar: `صُنع بواسطة ${HOLIE_NAAM}`,
    pl: `Stworzone przez ${HOLIE_NAAM}`,
    ja: `${HOLIE_NAAM} 制作`,
    tr: `${HOLIE_NAAM} tarafından yapıldı`,
  },
  klant: {
    nl: `Website door ${HOLIE_NAAM}`,
    fr: `Site réalisé par ${HOLIE_NAAM}`,
    de: `Website von ${HOLIE_NAAM}`,
    en: `Website by ${HOLIE_NAAM}`,
  },
};

export interface HolieCredit {
  tekst: string;
  href: string;
}

const TALEN: readonly string[] = [
  "nl",
  "fr",
  "de",
  "en",
  "es",
  "pt",
  "ar",
  "pl",
  "ja",
  "tr",
];

/** Taalcode ("nl", "nl-BE", "FR_fr") naar een bekende credit-taal; onbekend wordt "en". */
export function creditTaal(taal: string | null | undefined): CreditTaal {
  const kort = String(taal ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return (TALEN.includes(kort) ? kort : "en") as CreditTaal;
}

/** De creditregel ({ tekst, href }) voor een soort site en een taal. */
export function holieCredit(
  soort: CreditSoort,
  taal?: string | null,
): HolieCredit {
  const teksten = CREDIT_TEKSTEN[soort];
  const tekst = teksten[creditTaal(taal)] ?? teksten.en!;
  return { tekst, href: HOLIE_URL };
}
