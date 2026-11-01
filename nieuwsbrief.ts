/**
 * Bouwstenen voor een nieuwsbrief die de regels van Gmail en Yahoo volgt en
 * niemand twee keer mailt.
 *
 * - `uitschrijfKoppen`: `List-Unsubscribe` en `List-Unsubscribe-Post` (RFC 8058),
 *   zodat de mailclient een eigen uitschrijfknop toont die met één POST werkt.
 * - `isOneClickUitschrijving`: herkent die POST van de mailclient.
 * - `uitgaveSleutel` + `verdeelInBatches`: een vaste sleutel per uitgave en
 *   batches van 100, voor het verzendregister (`sql/nieuwsbrief.sql`) en de
 *   `Idempotency-Key` van Resend.
 * - `verwerkResendWebhook`: controleert de handtekening van een Resend-webhook
 *   (Svix) en zegt welke adressen na een bounce of klacht niet meer mogen.
 *
 * Uitschrijfcodes zelf staan in `./codes` (`maakUitschrijfcode`,
 * `controleerUitschrijfcode`): een HMAC, dus er hoeft geen token bewaard te
 * worden. Geef in de link een id mee, niet het e-mailadres: dan staat er geen
 * persoonsgegeven in de URL (en dus niet in logs van proxies of mailscanners).
 *
 * ⚠️ Een uitschrijfpagina schrijft pas uit na een klik (POST), nooit bij het
 * laden: mailscanners openen elke link in een mail, ook de uitschrijflink.
 *
 * Runtime-neutraal: enkel WebCrypto en `fetch`-types. Leest geen omgeving, logt niets.
 */

import { geheimenGelijk } from "./auth.ts";

const enc = new TextEncoder();

// ───────────── Uitschrijfkoppen (RFC 8058) ─────────────

export interface UitschrijfKoppenOpties {
  /** Optioneel tweede adres, bv. `uitschrijven@example.com`. */
  mailto?: string;
}

/**
 * De twee koppen voor één mail. `url` is de persoonlijke uitschrijflink en
 * moet https zijn; een POST erop met `List-Unsubscribe=One-Click` moet meteen
 * uitschrijven, zonder login of bevestiging (RFC 8058 §3.2).
 *
 * Gooit bij een url die geen https is of een mailto met vreemde tekens.
 *
 * ```ts
 * await sendMail({ ..., headers: uitschrijfKoppen(`${api}/functions/v1/uitschrijven?id=${id}&code=${code}`) });
 * ```
 */
export function uitschrijfKoppen(
  url: string,
  opties: UitschrijfKoppenOpties = {},
): Record<string, string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("uitschrijfKoppen: ongeldige url");
  }
  if (u.protocol !== "https:") {
    throw new Error("uitschrijfKoppen: url moet https zijn");
  }
  const delen = [`<${u.href}>`];
  if (opties.mailto !== undefined) {
    if (!/^[^\s<>@,;:"]+@[^\s<>@,;:"]+$/.test(opties.mailto)) {
      throw new Error("uitschrijfKoppen: ongeldig mailto-adres");
    }
    delen.push(`<mailto:${opties.mailto}?subject=uitschrijven>`);
  }
  return {
    "List-Unsubscribe": delen.join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * Is dit verzoek de one-click-POST van een mailclient? Die stuurt
 * `List-Unsubscribe=One-Click` als formulier (RFC 8058 §3.1). Kijkt naar het
 * type en de body; de code in de URL controleer je apart.
 */
export function isOneClickUitschrijving(
  contentType: string | null | undefined,
  body: string,
): boolean {
  const type = (contentType ?? "").toLowerCase();
  if (
    !type.startsWith("application/x-www-form-urlencoded") &&
    !type.startsWith("multipart/form-data")
  ) {
    return false;
  }
  if (type.startsWith("multipart/form-data")) {
    return /name="List-Unsubscribe"\s*\r?\n\r?\nOne-Click/.test(body);
  }
  return new URLSearchParams(body).get("List-Unsubscribe") === "One-Click";
}

// ───────────── Verzending ─────────────

const SOORT_PATROON = /^[a-z0-9_-]{1,32}$/;

/**
 * Vaste sleutel voor één uitgave: `<soort>:<eerste 24 tekens van sha256>` over
 * de delen in de gegeven volgorde. Zelfde inhoud geeft dezelfde sleutel, dus
 * een tweede run van dezelfde digest wordt herkend in het verzendregister.
 *
 * ```ts
 * const uitgave = await uitgaveSleutel("digest", artikels.map((a) => a.id).sort());
 * ```
 */
export async function uitgaveSleutel(
  soort: string,
  delen: readonly string[],
): Promise<string> {
  if (!SOORT_PATROON.test(soort)) {
    throw new Error("uitgaveSleutel: soort enkel a-z, 0-9, _ en -");
  }
  const tekst = delen.map((d) => `${d.length}:${d}`).join("|");
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(tekst)),
  );
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${soort}:${hex.slice(0, 24)}`;
}

/** Splitst een lijst in stukken van hoogstens `grootte` (standaard 100, de batchgrens van Resend). */
export function verdeelInBatches<T>(
  items: readonly T[],
  grootte = 100,
): T[][] {
  if (!Number.isInteger(grootte) || grootte < 1) {
    throw new Error(
      "verdeelInBatches: grootte moet een positief geheel getal zijn",
    );
  }
  const uit: T[][] = [];
  for (let i = 0; i < items.length; i += grootte) {
    uit.push(items.slice(i, i + grootte));
  }
  return uit;
}

// ───────────── Resend-webhook (Svix) ─────────────

export interface ResendGebeurtenis {
  /** Ruw type, bv. `email.bounced`. */
  type: string;
  /** `bounce` = harde bounce, `klacht` = als spam gemeld, anders `andere`. */
  soort: "bounce" | "klacht" | "andere";
  /** Ontvangers in kleine letters. */
  adressen: string[];
  /** Resend-id van de mail, als die er is. */
  mailId?: string;
}

export type WebhookResultaat =
  | { ok: true; gebeurtenis: ResendGebeurtenis }
  | { ok: false; status: 400 | 401; fout: string };

export interface WebhookOpties {
  /** Hoeveel seconden het tijdstip mag afwijken. Standaard 300 (zoals Svix). */
  tolerantieSec?: number;
  /** Enkel voor tests: huidige tijd in seconden. */
  nu?: number;
}

function base64NaarBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesNaarBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Klopt de Svix-handtekening van deze webhook? `geheim` is het signing secret
 * van Resend (`whsec_...`). Ondertekend is `${svix-id}.${svix-timestamp}.${body}`
 * met HMAC-SHA256; `svix-signature` bevat een of meer `v1,<base64>`.
 * Valt dicht: ontbrekende koppen, een oud tijdstip of een kapot geheim geven `false`.
 */
export async function controleerResendHandtekening(
  geheim: string | null | undefined,
  koppen: Headers,
  body: string,
  opties: WebhookOpties = {},
): Promise<boolean> {
  if (typeof geheim !== "string" || !geheim.startsWith("whsec_")) return false;
  const sleutel = base64NaarBytes(geheim.slice("whsec_".length));
  if (!sleutel || sleutel.length < 16) return false;
  const id = koppen.get("svix-id");
  const tijd = koppen.get("svix-timestamp");
  const handtekeningen = koppen.get("svix-signature");
  if (!id || !tijd || !handtekeningen || !/^\d{1,12}$/.test(tijd)) return false;
  const nu = opties.nu ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nu - Number(tijd)) > (opties.tolerantieSec ?? 300)) return false;

  const k = await crypto.subtle.importKey(
    "raw",
    sleutel as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const verwacht = bytesNaarBase64(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", k, enc.encode(`${id}.${tijd}.${body}`)),
    ),
  );
  let gevonden = false;
  for (const deel of handtekeningen.split(" ")) {
    const [versie, waarde] = deel.split(",", 2);
    // Geen vroege return: vergelijk alle kandidaten.
    if (versie === "v1" && waarde && geheimenGelijk(verwacht, waarde)) {
      gevonden = true;
    }
  }
  return gevonden;
}

/** Leest het type en de ontvangers uit een Resend-webhookbody (al gecontroleerd). */
export function leesResendGebeurtenis(
  payload: unknown,
): ResendGebeurtenis | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    type?: unknown;
    data?: { to?: unknown; email_id?: unknown; bounce?: { type?: unknown } };
  };
  if (typeof p.type !== "string") return null;
  const to = Array.isArray(p.data?.to)
    ? p.data.to
    : typeof p.data?.to === "string"
    ? [p.data.to]
    : [];
  const adressen = to
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  // Een tijdelijke bounce (volle mailbox) telt niet: enkel Permanent of zonder type.
  const bounceType = p.data?.bounce?.type;
  const soort: ResendGebeurtenis["soort"] = p.type === "email.complained"
    ? "klacht"
    : p.type === "email.bounced" &&
        (bounceType === undefined || bounceType === "Permanent")
    ? "bounce"
    : "andere";
  const mailId = typeof p.data?.email_id === "string"
    ? p.data.email_id
    : undefined;
  return { type: p.type, soort, adressen, mailId };
}

/**
 * Controleert en leest een Resend-webhook in één stap. Bij `ok` en soort
 * `bounce` of `klacht`: zet die adressen op de onderdrukkingslijst en antwoord
 * 200. Bij `ok: false`: antwoord met de gegeven status, zonder details.
 *
 * ```ts
 * const r = await verwerkResendWebhook(req, Deno.env.get("RESEND_WEBHOOK_SECRET"));
 * if (!r.ok) return new Response(null, { status: r.status });
 * ```
 */
export async function verwerkResendWebhook(
  req: Request,
  geheim: string | null | undefined,
  opties: WebhookOpties = {},
): Promise<WebhookResultaat> {
  const body = await req.text().catch(() => "");
  if (
    !(await controleerResendHandtekening(geheim, req.headers, body, opties))
  ) {
    return { ok: false, status: 401, fout: "handtekening klopt niet" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, fout: "geen JSON" };
  }
  const gebeurtenis = leesResendGebeurtenis(payload);
  if (!gebeurtenis) return { ok: false, status: 400, fout: "onbekende vorm" };
  return { ok: true, gebeurtenis };
}
