/**
 * Lezen wat GoTrue meegeeft bij de terugkeer van Google, voor elke app gelijk.
 *
 * - Gelukt met PKCE: `?code=...` (de app ruilt die in met `exchangeCodeForSession`).
 * - Gelukt met de implicit flow: `#access_token=...`; supabase-js leest dat zelf, hier `leeg`.
 * - Mislukt: `error`, `error_code` en `error_description`, in de query of in de hash.
 *
 * Registratie staat dicht in Peters apps: een Google-adres zonder account komt terug met
 * "Signups not allowed for this instance" (`signup_disabled`). Dat is geen storing maar
 * "geen uitnodiging", en krijgt dus een eigen soort.
 *
 * ⚠️ Bij de implicit flow wist supabase-js de hash bij het opstarten. Lees de URL dan bij het
 * laden van de module (zie `bewaarGoogleTerug`), niet pas als de loginpagina rendert.
 *
 * @module
 */

/** Wat de terugkeer van Google betekent. */
export type GoogleTerug =
  | { soort: "code"; code: string }
  | { soort: "niet_uitgenodigd" }
  | { soort: "geannuleerd" }
  | { soort: "fout"; tekst: string }
  | { soort: "leeg" };

const NIET_UITGENODIGD = /signups? not allowed|signups? (?:are )?disabled/i;

/** Leest de terugkeer uit een query (`?a=b`) en een hash (`#a=b`). */
export function leesGoogleTerug(search: string, hash = ""): GoogleTerug {
  const q = new URLSearchParams(search.replace(/^\?/, ""));
  const h = new URLSearchParams(hash.replace(/^#/, ""));
  const fout = q.get("error") ?? h.get("error");
  const code = q.get("error_code") ?? h.get("error_code") ?? "";
  const uitleg = q.get("error_description") ?? h.get("error_description") ??
    "";
  if (fout || code) {
    if (code === "signup_disabled" || NIET_UITGENODIGD.test(uitleg)) {
      return { soort: "niet_uitgenodigd" };
    }
    // Op het Google-scherm op "Annuleren" geklikt
    if (fout === "access_denied") return { soort: "geannuleerd" };
    return { soort: "fout", tekst: (uitleg || fout || code).slice(0, 160) };
  }
  const pkce = q.get("code");
  return pkce ? { soort: "code", code: pkce } : { soort: "leeg" };
}

/** Zelfde als `leesGoogleTerug`, maar op een volledige URL. */
export function googleTerugUitUrl(href: string): GoogleTerug {
  try {
    const u = new URL(href);
    return leesGoogleTerug(u.search, u.hash);
  } catch {
    return { soort: "leeg" };
  }
}

const TERUG_PARAMS = ["error", "error_code", "error_description", "code"];

/**
 * De URL zonder de Google-parameters, om met `history.replaceState` te zetten zodat een
 * herlaadbeurt de melding niet opnieuw toont. Andere parameters (zoals `next`) blijven staan.
 */
export function urlZonderGoogleTerug(href: string): string {
  const u = new URL(href);
  for (const p of TERUG_PARAMS) u.searchParams.delete(p);
  const h = new URLSearchParams(u.hash.replace(/^#/, ""));
  if (TERUG_PARAMS.some((p) => h.has(p))) {
    for (const p of TERUG_PARAMS) h.delete(p);
    const rest = h.toString();
    u.hash = rest ? `#${rest}` : "";
  }
  return u.toString();
}

let bewaard: GoogleTerug | null = null;

/**
 * Leest de terugkeer één keer, bij het laden van de module die dit aanroept, vóór supabase-js
 * de hash wist. Roep op topniveau aan (bv. in de module van de loginpagina) en lees later met
 * `neemGoogleTerug`.
 */
export function bewaarGoogleTerug(href?: string): void {
  if (bewaard) return;
  const url = href ??
    (typeof location === "undefined" ? "" : location.href);
  bewaard = url ? googleTerugUitUrl(url) : { soort: "leeg" };
}

/** Geeft de bewaarde terugkeer één keer terug; daarna `leeg`. */
export function neemGoogleTerug(): GoogleTerug {
  const t = bewaard ?? { soort: "leeg" };
  bewaard = { soort: "leeg" };
  return t;
}

/** Teksten voor de melding na een mislukte terugkeer. `{tekst}` wordt de uitleg van GoTrue. */
export interface GoogleTerugTeksten {
  niet_uitgenodigd: string;
  geannuleerd: string;
  fout: string;
}

/** Standaardteksten per taal. Apps overschrijven ze met hun eigen contactadres of toon. */
export const GOOGLE_TERUG_TEKSTEN: Record<
  "nl" | "en" | "fr" | "de",
  GoogleTerugTeksten
> = {
  nl: {
    niet_uitgenodigd:
      "Dit Google-account heeft geen uitnodiging. Meld je aan met het adres waarop je uitgenodigd bent.",
    geannuleerd: "Aanmelden met Google is afgebroken.",
    fout: "Aanmelden met Google lukte niet ({tekst}). Probeer opnieuw.",
  },
  en: {
    niet_uitgenodigd:
      "This Google account has no invitation. Sign in with the address you were invited on.",
    geannuleerd: "Google sign-in was cancelled.",
    fout: "Google sign-in failed ({tekst}). Please try again.",
  },
  fr: {
    niet_uitgenodigd:
      "Ce compte Google n'a pas d'invitation. Connectez-vous avec l'adresse de votre invitation.",
    geannuleerd: "La connexion avec Google a été annulée.",
    fout: "La connexion avec Google a échoué ({tekst}). Réessayez.",
  },
  de: {
    niet_uitgenodigd:
      "Dieses Google-Konto hat keine Einladung. Melden Sie sich mit der eingeladenen Adresse an.",
    geannuleerd: "Die Anmeldung mit Google wurde abgebrochen.",
    fout:
      "Die Anmeldung mit Google ist fehlgeschlagen ({tekst}). Bitte erneut versuchen.",
  },
};

/** Een melding voor het loginblok: `fout` is rood, `info` neutraal. */
export interface LoginMelding {
  soort: "fout" | "info";
  tekst: string;
}

/**
 * De melding voor een terugkeer, of `null` als er niets te melden is (`leeg`, `code`).
 * "Geen uitnodiging" en "afgebroken" zijn geen storing en komen als `info`.
 */
export function googleTerugMelding(
  terug: GoogleTerug,
  teksten: GoogleTerugTeksten = GOOGLE_TERUG_TEKSTEN.nl,
): LoginMelding | null {
  switch (terug.soort) {
    case "niet_uitgenodigd":
      return { soort: "info", tekst: teksten.niet_uitgenodigd };
    case "geannuleerd":
      return teksten.geannuleerd
        ? { soort: "info", tekst: teksten.geannuleerd }
        : null;
    case "fout":
      return {
        soort: "fout",
        tekst: teksten.fout.replace("{tekst}", terug.tekst),
      };
    default:
      return null;
  }
}
