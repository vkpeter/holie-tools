/**
 * HTML-escaping voor mails, pagina's en Telegram (`parse_mode: "HTML"`).
 *
 * Waarom een eigen module: op 18-09-2026 stonden er 13 eigen kopieën verspreid
 * over Foodie, Billara, Phyllox, Eendje en Baki. Ze verschilden op één punt: de
 * ene escapete de apostrof wel, de andere niet. Zonder apostrof is een waarde in
 * een attribuut tussen enkele aanhalingstekens (`href='...'`) niet veilig, dus
 * deze versie escapet alle vijf.
 *
 * Telegram leest `&#39;` gewoon als apostrof: de Bot API ondersteunt alle
 * numerieke HTML-entiteiten.
 */

/** Escapet `&`, `<`, `>`, `"` en `'`. Veilig in tekst én in attributen. */
export function escapeHtml(tekst: string): string {
  return tekst
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
