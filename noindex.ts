/**
 * Eén uniforme lijst van pagina's die niet in Google horen, en de drie manieren om ze af te schermen
 * (zonder dependencies, geen Helmet nodig).
 *
 * Aanpak (panel 17 nov 2026):
 * - SPA op Workers Assets (Tickbook, Roundbook, Phyllox, Foodie): `X-Robots-Tag` via `public/_headers`,
 *   gegenereerd met `zetNoindexBlok`. Een header werkt ook op het SPA-terugvalpad, ziet de crawler
 *   zonder JavaScript uit te voeren en kan niet vergeten worden in een component.
 * - SSR op een eigen Worker (TanStack Start: Eendje, ESE, Shintaka, holie.be): `_headers` geldt daar
 *   NIET voor het antwoord van de Worker, dus een `<meta name="robots">` per route via `noindexMeta`.
 * - robots.txt `Disallow` NIET gebruiken voor deze paden: de crawler leest dan de noindex niet meer en
 *   een intern gelinkte URL blijft zonder snippet in de index staan. Gebruik `disallowTegenNoindex`
 *   om die tegenstrijdigheid te vinden.
 *
 * Privacy- en voorwaardenpagina's staan er bewust NIET in: die horen vindbaar te zijn (AVG art. 13,
 * Google OAuth-verificatie vraagt een publieke URL).
 */

/** De waarde van de header en de meta-tag. */
export const NOINDEX_WAARDE = "noindex, nofollow";

/**
 * Basispaden die in elke site niet in Google horen. Elk pad geldt ook voor alles eronder
 * (`/admin` dekt `/admin/team`). Een app gebruikt er met `noindexPadenVoor` enkel de paden van die
 * echt in zijn routes bestaan.
 */
export const NOINDEX_STANDAARD: readonly string[] = [
  // uitschrijven en bevestigen: handelingen uit een mail, geen zoekresultaat
  "/unsubscribe",
  "/unsubscribed",
  "/uitschrijven",
  "/confirm",
  "/confirm-subscription",
  "/confirm-email",
  "/bevestig",
  "/bevestigen",
  // wachtwoord
  "/reset-password",
  "/forgot-password",
  "/update-password",
  "/wachtwoord-vergeten",
  // inloggen en terugkeer van een login of toestemming
  "/auth",
  "/login",
  "/logout",
  "/register",
  "/signup",
  "/oauth",
  "/callback",
  // beheer en ingelogde zones
  "/admin",
  "/dashboard",
  "/account",
  "/settings",
  "/profiel",
  "/checkout",
];

/** Normaliseert een pad: begint met `/`, geen query of hash, geen slot-`/` (behalve de root). */
export function normaliseerPad(pad: string): string {
  let p = pad.split("#")[0].split("?")[0].trim();
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p.toLowerCase();
}

/** Een routepatroon van een router (`/admin/$id`, `/:taal/auth`) zonder parameters, als vaste segmenten. */
function vasteSegmenten(route: string): string[] {
  return normaliseerPad(route).split("/").filter((s) =>
    s && !s.startsWith("$") && !s.startsWith(":") && !s.startsWith("{") &&
    s !== "*"
  );
}

/** Heeft `pad` het basispad als begin (hele segmenten)? `/admin` dekt `/admin` en `/admin/x`, niet `/administratie`. */
export function valtOnderBasis(pad: string, basis: string): boolean {
  const p = normaliseerPad(pad);
  const b = normaliseerPad(basis);
  return p === b || p.startsWith(b + "/");
}

/** Hoort dit pad niet in Google, volgens `paden` (standaard de gedeelde lijst)? */
export function isNoindexPad(
  pad: string,
  paden: readonly string[] = NOINDEX_STANDAARD,
): boolean {
  return paden.some((b) => valtOnderBasis(pad, b));
}

/**
 * Filtert de standaardlijst op wat in deze app echt bestaat. `routes` zijn de routepatronen van de
 * app (`/auth`, `/admin/team`, `/{-$lang}/account`); een basis blijft staan als een route met dat
 * basispad begint, ook na een taalvoorvoegsel dat uit parameters bestaat. `extra` zijn app-eigen
 * paden (bv. `/r` voor een publieke rapportlink) die altijd mee gaan.
 */
export function noindexPadenVoor(
  routes: readonly string[],
  extra: readonly string[] = [],
  standaard: readonly string[] = NOINDEX_STANDAARD,
): string[] {
  const bestaand = standaard.filter((basis) => {
    const bs = vasteSegmenten(basis);
    return routes.some((r) => {
      const rs = vasteSegmenten(r);
      return bs.every((s, i) => rs[i] === s) && rs.length >= bs.length;
    });
  });
  const uit = new Set<string>([...bestaand, ...extra.map(normaliseerPad)]);
  return [...uit].sort();
}

/** De `<meta name="robots">`-waarde voor een pad, of `undefined` als de pagina geïndexeerd mag worden. */
export function robotsMeta(
  pad: string,
  paden: readonly string[] = NOINDEX_STANDAARD,
): string | undefined {
  return isNoindexPad(pad, paden) ? NOINDEX_WAARDE : undefined;
}

/**
 * Een meta-item voor de `head()` van een TanStack-route of een `<Helmet>`-lijst:
 * `head: () => ({ meta: [noindexMeta()] })`.
 */
export function noindexMeta(): { name: "robots"; content: string } {
  return { name: "robots", content: NOINDEX_WAARDE };
}

/** Het deel van `document` dat `zetNoindex` nodig heeft (zodat de module geen DOM-types vraagt). */
export type DocumentLike = {
  head: {
    querySelector(selector: string): MetaLike | null;
    appendChild(el: MetaLike): unknown;
  };
  createElement(tag: string): MetaLike;
};
type MetaLike = {
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  remove(): void;
};

/**
 * Zet `<meta name="robots" content="noindex, nofollow">` in een SPA, zonder Helmet. Vervangt een
 * bestaande robots-meta. Geeft een functie terug die de vorige waarde herstelt (voor `useEffect`).
 * Een hulpmiddel bovenop de header: Google voert JavaScript uit, maar de header is de bron.
 */
export function zetNoindex(doc?: DocumentLike): () => void {
  const d = doc ??
    (globalThis as unknown as { document?: DocumentLike }).document;
  if (!d) return () => {};
  const bestond = d.head.querySelector('meta[name="robots"]');
  const voor = bestond?.getAttribute("content") ?? null;
  const meta = bestond ?? d.createElement("meta");
  meta.setAttribute("name", "robots");
  meta.setAttribute("content", NOINDEX_WAARDE);
  if (!bestond) d.head.appendChild(meta);
  return () => {
    if (!bestond) meta.remove();
    else if (voor === null) meta.removeAttribute("content");
    else meta.setAttribute("content", voor);
  };
}

const BLOK_BEGIN =
  "# >>> holie-noindex (gegenereerd met @holie/tools/noindex: zetNoindexBlok, niet met de hand wijzigen)";
const BLOK_EIND = "# <<< holie-noindex";

/**
 * Het blok voor `public/_headers`: per basispad een regel voor het pad zelf en een voor alles eronder.
 * Leeg bij een lege lijst.
 */
export function noindexHeadersBlok(paden: readonly string[]): string {
  const uniek = [...new Set(paden.map(normaliseerPad))].sort();
  if (uniek.length === 0) return "";
  const regels = [BLOK_BEGIN];
  for (const p of uniek) {
    regels.push(`${p}`, `  X-Robots-Tag: ${NOINDEX_WAARDE}`);
    regels.push(`${p}/*`, `  X-Robots-Tag: ${NOINDEX_WAARDE}`);
  }
  regels.push(BLOK_EIND);
  return regels.join("\n") + "\n";
}

/**
 * Zet het noindex-blok in de tekst van een `_headers`-bestand: vervangt een eerder blok of voegt het
 * achteraan toe. Idempotent: een tweede keer geeft dezelfde tekst. De rest van het bestand blijft staan.
 */
export function zetNoindexBlok(
  headersTekst: string,
  paden: readonly string[],
): string {
  const blok = noindexHeadersBlok(paden);
  const crlf = headersTekst.includes("\r\n");
  const tekst = headersTekst.replace(/\r\n/g, "\n");
  const i = tekst.indexOf(BLOK_BEGIN);
  const j = tekst.indexOf(BLOK_EIND);
  const heeftBlok = i >= 0 && j > i;
  if (!heeftBlok && blok === "") return headersTekst;
  const voor = heeftBlok ? tekst.slice(0, i) : tekst;
  const na = heeftBlok ? tekst.slice(j + BLOK_EIND.length) : "";
  const uit = (voor + "\n\n" + blok + "\n\n" + na)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "") + "\n";
  return crlf ? uit.replace(/\n/g, "\r\n") : uit;
}

/**
 * De paden uit `paden` die robots.txt met `Disallow` afsluit voor `User-agent: *` (of voor een
 * groep die `*` bevat). Een crawler die het pad niet mag ophalen leest de noindex niet: haal die
 * Disallow weg, of laat het pad bewust buiten `paden` (zoals een beheerzone zonder externe links).
 */
export function disallowTegenNoindex(
  robotsTekst: string,
  paden: readonly string[],
): string[] {
  const disallows: string[] = [];
  let groepAgents: string[] = [];
  let laatsteWasAgent = false;
  for (const ruw of robotsTekst.split(/\r?\n/)) {
    const regel = ruw.split("#")[0].trim();
    if (!regel) continue;
    const m = regel.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const sleutel = m[1].toLowerCase();
    if (sleutel === "user-agent") {
      if (!laatsteWasAgent) groepAgents = [];
      groepAgents.push(m[2].trim());
      laatsteWasAgent = true;
      continue;
    }
    laatsteWasAgent = false;
    if (sleutel === "disallow" && groepAgents.includes("*") && m[2].trim()) {
      disallows.push(normaliseerPad(m[2].trim().replace(/\*$/, "")));
    }
  }
  return paden.filter((p) =>
    disallows.some((d) => valtOnderBasis(p, d) || valtOnderBasis(d, p))
  );
}
