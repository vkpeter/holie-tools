/**
 * @module
 * Kleine teksthulpen voor automatisch gevulde sjablonen (blogposts, kaders, socials), zonder dependencies.
 * Gebouwd uit de duo-motor van Eendje en Nilou (15 nov 2026), zodat Roundbook en Tickbook dezelfde
 * bouwstenen gebruiken voor hun socials. De woorden zelf (sjablonen, verboden woorden) blijven per project.
 */

/** Vult `{naam}`-placeholders in. Een onbekende placeholder blijft staan: controleer met {@link openPlaceholders}. */
export function vul(sjabloon: string, waarden: Record<string, string>): string {
  return sjabloon.replace(
    /\{([a-z_]+)\}/g,
    (m, k: string) => (k in waarden ? waarden[k] : m),
  );
}

/** De placeholders die na het vullen nog openstaan, bv. `["trend"]`. Leeg = alles ingevuld. */
export function openPlaceholders(tekst: string): string[] {
  return [...tekst.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
}

/**
 * Een URL-pad uit een titel: accenten weg, kleine letters, koppeltekens. Langer dan `max` wordt op een
 * woordgrens geknipt ("quelle-quantit" was een afgebroken woord, 15 nov 2026).
 */
export function slugify(tekst: string, max = 60): string {
  const s = tekst.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " en ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length <= max) return s;
  const grens = s.lastIndexOf("-", max);
  return (grens > max / 3 ? s.slice(0, grens) : s.slice(0, max)).replace(
    /-+$/,
    "",
  );
}

/** Markdown zonder links en URL's (de linktekst blijft), voor controles die enkel over de lopende tekst gaan. */
export function zonderUrls(md: string): string {
  return md.replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, "").replace(
    /\{[A-Z_]+_URL\}/g,
    "",
  );
}

/** Eerste letter als hoofdletter, volgens de regels van de taal. */
export function hoofdletter(tekst: string, taal = "nl"): string {
  return tekst.charAt(0).toLocaleUpperCase(taal) + tekst.slice(1);
}

/** Franse elisie na een ingevulde placeholder: "que une portion" wordt "qu'une portion". Andere talen: ongewijzigd. */
export function elisie(tekst: string, taal: string): string {
  return taal === "fr"
    ? tekst.replace(/\b(qu|d|l|j)e ([aeiouyàâéèêh])/gi, "$1'$2")
    : tekst;
}

const regexCache = new Map<string, RegExp>();

/**
 * Welke woorden of zinsneden uit `woorden` als heel woord in de tekst staan (hoofdletterongevoelig).
 * De regexen worden gecachet: honderden `\p{L}`-regexen bouwen kostte in een edge function 1,1 s CPU.
 */
export function woordenGevonden(
  tekst: string,
  woorden: readonly string[],
): string[] {
  const laag = tekst.toLowerCase();
  return woorden.filter((w) => {
    let re = regexCache.get(w);
    if (!re) {
      const esc = w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u");
      regexCache.set(w, re);
    }
    return re.test(laag);
  });
}

/** Hoeveel keer een URL (of een stuk ervan) in de tekst staat. Handig voor "één link per richting". */
export function telLinks(tekst: string, url: string): number {
  return tekst.split(url).length - 1;
}
