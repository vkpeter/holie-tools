/**
 * Turnstile-sitekey uit een bouwvariabele, schoongemaakt en getoetst.
 *
 * Aanleiding 17 nov 2026: `VITE_TURNSTILE_SITEKEY` stond met aanhalingstekens in
 * de bouwomgeving van Nilou; `docker --env-file` nam ze letterlijk over,
 * Cloudflare weigerde de sitekey `'0x...'`, `getToken` gaf `null` en de server
 * antwoordde 403 captcha. Zonder dat de build of de pagina iets meldde.
 *
 * Runtime-neutraal; enkel `console.error`.
 */

/** Formaat van een Cloudflare-sitekey (`0x4AAAAAAF...`). */
export const SITEKEY_PATROON: RegExp = /^0x[0-9A-Za-z_-]{10,}$/;

function schoon(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  // Eén of meer paren omringende aanhalingstekens (enkel, dubbel, typografisch).
  while (s.length >= 2 && /^["'`‘“]/.test(s) && /["'`’”]$/.test(s)) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * De sitekey, of `""` als de widget uit moet.
 *
 * - Witruimte en omringende aanhalingstekens vallen weg.
 * - Leeg of ontbrekend: `terugval` (als die geldig is), anders `""`, zonder melding:
 *   dat is "bewust uit".
 * - Gevuld maar niet van de vorm `0x...`: een duidelijke `console.error`, daarna
 *   `terugval` (als die geldig is), anders `""` (widget uit).
 */
export function turnstileSitekey(raw: unknown, terugval = ""): string {
  const reserve = SITEKEY_PATROON.test(schoon(terugval))
    ? schoon(terugval)
    : "";
  const s = schoon(raw);
  if (!s) return reserve;
  if (SITEKEY_PATROON.test(s)) return s;
  console.error(
    `Turnstile: sitekey ongeldig (${
      JSON.stringify(s.slice(0, 40))
    }), verwacht 0x... ` +
      `Controleer VITE_TURNSTILE_SITEKEY in de bouwomgeving (geen aanhalingstekens).` +
      (reserve
        ? " De ingebouwde sitekey wordt gebruikt."
        : " De widget staat uit."),
  );
  return reserve;
}
