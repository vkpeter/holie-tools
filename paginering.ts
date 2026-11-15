/**
 * Paginering, framework-onafhankelijk: een lijst opdelen in pagina's, het pad van een pagina bouwen
 * en een venster met paginanummers voor de navigatie. Pagina 1 heeft altijd het kale pad (geen
 * `/page/1`), zodat er per lijst maar een adres is voor de eerste pagina.
 */

export type Pagina<T> = {
  items: T[];
  pagina: number;
  aantalPaginas: number;
  totaal: number;
  vorige: number | null;
  volgende: number | null;
};

/**
 * Knipt `pagina` (1-gebaseerd) uit `items`. Een pagina buiten bereik wordt naar het dichtstbijzijnde
 * geldige nummer gebracht; een lege lijst heeft toch 1 (lege) pagina.
 */
export function pagineer<T>(
  items: T[],
  pagina: number,
  perPagina: number,
): Pagina<T> {
  const per = Math.max(1, Math.floor(perPagina) || 1);
  const totaal = items.length;
  const aantalPaginas = Math.max(1, Math.ceil(totaal / per));
  const nr = Math.min(aantalPaginas, Math.max(1, Math.floor(pagina) || 1));
  return {
    items: items.slice((nr - 1) * per, nr * per),
    pagina: nr,
    aantalPaginas,
    totaal,
    vorige: nr > 1 ? nr - 1 : null,
    volgende: nr < aantalPaginas ? nr + 1 : null,
  };
}

/** Pagina 1 geeft `basis`, anders `${basis}/${segment ?? "page"}/${pagina}`, zonder dubbele slash. */
export function paginaPad(
  basis: string,
  pagina: number,
  segment?: string,
): string {
  const b = basis.replace(/\/+$/, "");
  if (pagina <= 1) return b === "" ? "/" : b;
  return `${b}/${segment ?? "page"}/${pagina}`;
}

/**
 * Paginanummers voor de navigatie: eerste, laatste en `breedte` nummers rond de huidige, met "..." voor
 * elke gat van meer dan een nummer (een gat van precies een nummer wordt dat nummer zelf).
 */
export function paginaVenster(
  pagina: number,
  aantal: number,
  breedte = 5,
): (number | "...")[] {
  if (aantal < 1) return [];
  const nr = Math.min(aantal, Math.max(1, Math.floor(pagina) || 1));
  const b = Math.max(1, Math.floor(breedte));
  if (aantal <= b + 2) return Array.from({ length: aantal }, (_, i) => i + 1);
  let van = Math.max(2, nr - Math.floor((b - 1) / 2));
  let tot = van + b - 1;
  if (tot > aantal - 1) {
    tot = aantal - 1;
    van = Math.max(2, tot - b + 1);
  }
  const uit: (number | "...")[] = [1];
  if (van === 3) uit.push(2);
  else if (van > 3) uit.push("...");
  for (let i = van; i <= tot; i++) uit.push(i);
  if (tot === aantal - 2) uit.push(aantal - 1);
  else if (tot < aantal - 2) uit.push("...");
  uit.push(aantal);
  return uit;
}
