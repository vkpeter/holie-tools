/**
 * Codes voor bevestiglinks, Telegram-koppelcodes en uitschrijflinks.
 *
 * Twee soorten, met elk een andere regel:
 *
 * - **Eenmalige codes** (bevestigen van een nieuwsbrief, een Telegram-account
 *   koppelen): willekeurig, en in de databank staat enkel de hash. Een lange
 *   code (`maakCode`, 256 bits) is uit de hash niet terug te vinden. Uit Foodie,
 *   Phyllox en Eagle-Eye (27-28 okt 2026).
 * - **Uitschrijfcodes**: niet willekeurig maar afgeleid (HMAC) van lijst en
 *   adres, zodat een link in elke mail werkt zonder dat er iets bewaard wordt.
 *   Uit Foodie (`_shared/unsubscribe.ts`): de lijst zit in de code, dus een
 *   link uit een herinnering haalt niemand van de nieuwsbrief. Nieuw tegenover
 *   Foodie: een vaste lengte, zodat een korte of afgeknipte code nooit telt
 *   (Billara schrapte op 28 okt 2026 zijn oude codes van 10 tekens, lat N6).
 *
 * Runtime-neutraal: enkel Web Crypto en `TextEncoder`.
 */

import { geheimenGelijk } from "./auth.ts";

const enc = new TextEncoder();

function naarBase64url(bytes: Uint8Array): string {
  let binair = "";
  for (const b of bytes) binair += String.fromCharCode(b);
  return btoa(binair).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

function naarHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(geheim: string, bericht: string): Promise<Uint8Array> {
  const sleutel = await crypto.subtle.importKey(
    "raw",
    enc.encode(geheim),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", sleutel, enc.encode(bericht)),
  );
}

// ───────────── Eenmalige codes (N2, T2) ─────────────

/** Een nieuwe code en wat daarvan in de databank mag. */
export interface NieuweCode {
  /** Gaat naar de gebruiker (in de link of het bericht). Nooit bewaren. */
  code: string;
  /** `hashCode(code, peper)`, 64 tekens hex. Dit staat in de databank. */
  hash: string;
}

/** Standaardlengte van `maakCode`: 32 bytes, 256 bits, 43 tekens base64url. */
export const CODE_BYTES = 32;

/** Opties voor `maakCode`. */
export interface MaakCodeOpties {
  /** Aantal willekeurige bytes, 16 tot 48. Standaard `CODE_BYTES`. */
  bytes?: number;
  /** Geheim voor de hash, zie `hashCode`. */
  peper?: string;
}

/**
 * Een willekeurige code voor een bevestiglink, met zijn hash.
 *
 * 256 bits, als base64url (`A-Z a-z 0-9 _ -`, 43 tekens): veilig in een URL en
 * geldig als Telegram-startparameter (`t.me/<bot>?start=<code>`, max 64).
 *
 * ```ts
 * const { code, hash } = await maakCode();
 * await admin.from("newsletter_subscribers").update({ confirm_token_hash: hash, ... });
 * const link = `${basis}/nieuwsbrief/bevestig?code=${code}`;
 * // bij de klik:
 * .eq("confirm_token_hash", await hashCode(code))
 * ```
 */
export async function maakCode(
  opties: MaakCodeOpties = {},
): Promise<NieuweCode> {
  const bytes = opties.bytes ?? CODE_BYTES;
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 48) {
    throw new RangeError("maakCode: 16 tot 48 bytes");
  }
  const code = naarBase64url(crypto.getRandomValues(new Uint8Array(bytes)));
  return { code, hash: await hashCode(code, opties.peper) };
}

/**
 * Alfabet van de korte code: geen 0/O en geen 1/I, dus overtypen lukt. Precies 32
 * tekens: `byte % 32` is dan zonder voorkeur voor bepaalde tekens.
 */
export const KORTE_CODE_ALFABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Lengte van `maakKorteCode`: 8 tekens, 40 bits. */
export const KORTE_CODE_LENGTE = 8;

/** Opties voor `maakKorteCode`. */
export interface MaakKorteCodeOpties {
  /** Aantal tekens, 6 tot 32. Standaard `KORTE_CODE_LENGTE`. */
  lengte?: number;
  /** Geheim voor de hash, zie `hashCode`. Aangeraden voor korte codes. */
  peper?: string;
}

/**
 * Een korte code om over te typen (Telegram-koppelcode van Eagle-Eye): 8 tekens
 * uit `KORTE_CODE_ALFABET`, 40 bits. Dat is enkel genoeg met een korte
 * geldigheid (Eagle-Eye: 15 minuten), eenmalig gebruik en een limiet op het
 * aantal pogingen (`limietHit`). Voor een link in een mail: `maakCode`.
 *
 * ⚠️ De pogingslimiet geldt enkel voor wie via de bot raadt. Wie de tabel kan
 * lezen, rekent 40 bits SHA-256 in enkele minuten na, ruim binnen de
 * geldigheid. Geef daarom een `peper` mee: dan is de hash een HMAC en zonder
 * het geheim niet na te rekenen.
 *
 * De hash is die van de code in hoofdletters; lees invoer met `leesKorteCode`.
 */
export async function maakKorteCode(
  opties: MaakKorteCodeOpties = {},
): Promise<NieuweCode> {
  const lengte = opties.lengte ?? KORTE_CODE_LENGTE;
  if (!Number.isInteger(lengte) || lengte < 6 || lengte > 32) {
    throw new RangeError("maakKorteCode: 6 tot 32 tekens");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(lengte));
  const code = Array.from(
    bytes,
    (b) => KORTE_CODE_ALFABET[b % KORTE_CODE_ALFABET.length],
  ).join("");
  return { code, hash: await hashCode(code, opties.peper) };
}

/**
 * Getypte korte code naar de vorm van `maakKorteCode` (hoofdletters, zonder
 * spaties of streepjes), of `null` als ze dat niet kan zijn.
 */
export function leesKorteCode(
  invoer: unknown,
  lengte = KORTE_CODE_LENGTE,
): string | null {
  if (typeof invoer !== "string" || invoer.length > 64) return null;
  // Enkel ASCII: `ß` zou anders als `SS` meetellen.
  if (!/^[A-Za-z0-9\s-]*$/.test(invoer)) return null;
  const code = invoer.replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== lengte) return null;
  for (const teken of code) {
    if (!KORTE_CODE_ALFABET.includes(teken)) return null;
  }
  return code;
}

/**
 * Hash van een code, 64 tekens hex in kleine letters. Exact over de gegeven
 * tekst: geen trim, geen hoofdletters. Normaliseer vooraf (`leesKorteCode`).
 *
 * - Zonder `peper`: SHA-256. Volstaat voor `maakCode` (256 bits toeval), en is
 *   wat de sites al bewaren.
 * - Met `peper` (minstens 32 tekens, een eigen env-var): HMAC-SHA256. Nodig
 *   voor een korte code, zie `maakKorteCode`.
 *
 * Gooit bij een `peper` korter dan 32 tekens.
 */
export async function hashCode(code: string, peper?: string): Promise<string> {
  if (peper === undefined) {
    return naarHex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(code))),
    );
  }
  if (typeof peper !== "string" || peper.length < 32) {
    throw new Error("hashCode: peper van minstens 32 tekens nodig");
  }
  return naarHex(await hmac(peper, `code:${code}`));
}

// ───────────── Uitschrijfcode (N6) ─────────────

/** Lengte van een uitschrijfcode: HMAC-SHA256 als base64url, 43 tekens. */
export const UITSCHRIJFCODE_LENGTE = 43;

const LIJST_PATROON = /^[a-z0-9_-]{1,32}$/;
const UITSCHRIJFCODE_PATROON = /^[A-Za-z0-9_-]{43}$/;

async function uitschrijfHmac(
  geheim: string,
  lijst: string,
  adres: string,
): Promise<string> {
  // De lijst kan geen ":" bevatten (LIJST_PATROON), dus de scheiding is eenduidig.
  // Geen voorvoegsel: zo blijft de berekening die van Foodie (`${list}:${email}`).
  return naarBase64url(
    await hmac(geheim, `${lijst}:${adres.trim().toLowerCase()}`),
  );
}

/**
 * De uitschrijfcode voor één adres op één lijst: HMAC-SHA256 over
 * `lijst:adres`, altijd 43 tekens. Het adres telt zonder hoofdletters en
 * spaties, zoals `normaliseerEmail` het bewaart.
 *
 * Gooit bij een leeg of te kort geheim (< 32 tekens) of een ongeldige lijstnaam
 * (`a-z 0-9 _ -`, max 32): dan liever geen mail dan een link die niets bewijst.
 *
 * ⚠️ Gebruik een eigen geheim, niet dat van `maakBevestigKnop` of de webhook:
 * met een gedeeld geheim is een gekozen "adres" op de lijst `telegram-knop`
 * een geldige knophandtekening.
 *
 * ```ts
 * const code = await maakUitschrijfcode(Deno.env.get("UNSUBSCRIBE_SECRET")!, "nieuwsbrief", adres);
 * const link = `${basis}/uitschrijven?` + new URLSearchParams({ lijst: "nieuwsbrief", adres, code });
 * ```
 */
export async function maakUitschrijfcode(
  geheim: string,
  lijst: string,
  adres: string,
): Promise<string> {
  if (typeof geheim !== "string" || geheim.length < 32) {
    throw new Error("maakUitschrijfcode: geheim van minstens 32 tekens nodig");
  }
  if (!LIJST_PATROON.test(lijst)) {
    throw new Error("maakUitschrijfcode: lijstnaam enkel a-z, 0-9, _ en -");
  }
  return await uitschrijfHmac(geheim, lijst, adres);
}

/**
 * Klopt deze uitschrijfcode voor dit adres op deze lijst? Vergelijkt in
 * constante tijd (`geheimenGelijk`). Valt dicht: geen geheim, een ongeldige
 * lijst, een code van de verkeerde lengte of met vreemde tekens geeft `false`.
 */
export async function controleerUitschrijfcode(
  geheim: string | null | undefined,
  lijst: string,
  adres: string,
  code: unknown,
): Promise<boolean> {
  if (typeof geheim !== "string" || geheim.length < 32) return false;
  if (typeof lijst !== "string" || !LIJST_PATROON.test(lijst)) return false;
  if (typeof adres !== "string" || adres.trim() === "") return false;
  if (typeof code !== "string" || !UITSCHRIJFCODE_PATROON.test(code)) {
    return false;
  }
  return geheimenGelijk(await uitschrijfHmac(geheim, lijst, adres), code);
}
