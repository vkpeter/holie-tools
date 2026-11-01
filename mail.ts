/**
 * Mail versturen via de Resend-API (`POST /emails`).
 *
 * Runtime-neutraal: enkel `fetch` en `AbortSignal`, dus het werkt in Supabase edge
 * functions (Deno), in een Cloudflare Worker (TanStack Start) en in Node.
 *
 * Privacy en sleutels, bewust zo ontworpen (zoals `./telegram`):
 * - Deze module leest GEEN omgevingsvariabelen. Het project kiest zelf welke sleutel en
 *   welke afzender het gebruikt (elke Resend-sleutel is aan zijn eigen geverifieerde
 *   domein gebonden; een gekruiste sleutel geeft een 403) en geeft ze mee.
 * - Er wordt niets gelogd en er wordt niet gegooid: wat misging staat in het resultaat.
 * - De sleutel komt nooit in `fout`: elke foutmelding wordt er eerst van ontdaan.
 */

const RESEND_API = "https://api.resend.com";

/** Resend aanvaardt hoogstens 50 ontvangers in `to`. */
export const MAIL_MAX_ONTVANGERS = 50;

export interface MailOpties {
  /** Resend-API-sleutel (`re_...`). */
  apiKey: string;
  /** Afzender, bv. `"Eagle-Eye Scissors <eagle-eye-scissors@holie.be>"`. */
  from: string;
  to: string | readonly string[];
  subject: string;
  html: string;
  /** Platte-tekstversie. Aanrader: zonder tekstdeel scoort een mail slechter op spam. */
  text?: string;
  cc?: string | readonly string[];
  bcc?: string | readonly string[];
  /** Waar een antwoord op deze mail naartoe gaat. */
  replyTo?: string | readonly string[];
  /**
   * Resend verstuurt een tweede verzoek met dezelfde sleutel (binnen 24 uur) niet
   * opnieuw. Gebruik iets vasts per gebeurtenis, bv. `bestelling-123/bevestiging`.
   */
  idempotencyKey?: string;
  /**
   * Extra mailkoppen, bv. `uitschrijfKoppen(...)` uit `./nieuwsbrief`
   * (`List-Unsubscribe`). Namen met een regeleinde worden geweigerd.
   */
  headers?: Record<string, string>;
  /** Timeout per verzoek. Standaard 10 000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Enkel voor tests. Standaard `https://api.resend.com`. */
  apiBasis?: string;
}

export interface MailResultaat {
  ok: boolean;
  /** Id van de mail bij Resend, als die verstuurd is. */
  id?: string;
  /** HTTP-status van Resend; 0 als er geen antwoord kwam of de invoer niet deugde. */
  status: number;
  /** Wat misging, zonder sleutel. */
  fout?: string;
}

const lijst = (v: string | readonly string[] | undefined): string[] =>
  (typeof v === "string" ? [v] : [...(v ?? [])])
    .map((s) => s.trim())
    .filter(Boolean);

/** Een kopnaam of -waarde met een regeleinde zou een eigen kop kunnen injecteren. */
function controleerKoppen(
  koppen: Record<string, string> | undefined,
): string | undefined {
  for (const [naam, waarde] of Object.entries(koppen ?? {})) {
    if (!/^[A-Za-z0-9-]{1,76}$/.test(naam)) return `ongeldige kopnaam: ${naam}`;
    if (typeof waarde !== "string" || /[\r\n]/.test(waarde)) {
      return `ongeldige waarde voor kop ${naam}`;
    }
  }
  return undefined;
}

/** Haalt de sleutel uit een tekst, zodat een foutmelding veilig gelogd kan worden. */
function zonderSleutel(tekst: string, sleutel: string): string {
  return sleutel ? tekst.split(sleutel).join("<sleutel>") : tekst;
}

/** Leesbare fout uit een Resend-foutantwoord (`{ name, message }`), kort gehouden. */
function foutUitAntwoord(status: number, body: string): string {
  let detail = body.trim();
  try {
    const j = JSON.parse(body) as { name?: unknown; message?: unknown };
    if (typeof j.message === "string") {
      detail = typeof j.name === "string"
        ? `${j.name}: ${j.message}`
        : j.message;
    }
  } catch {
    // Geen JSON: de ruwe tekst volstaat.
  }
  if (detail.length > 300) detail = `${detail.slice(0, 300)}...`;
  return `Resend ${status}${detail ? `: ${detail}` : ""}`;
}

/**
 * Verstuurt één mail via Resend. Gooit niet: kijk naar `ok` en `fout`.
 *
 * ```ts
 * const r = await sendMail({ apiKey, from, to: "klant@example.com", subject, html, text });
 * if (!r.ok) throw new Error(r.fout);
 * ```
 */
export async function sendMail(opties: MailOpties): Promise<MailResultaat> {
  const sleutel = (opties.apiKey ?? "").trim();
  const to = lijst(opties.to);
  const ongeldig = !sleutel
    ? "geen Resend-sleutel"
    : !opties.from?.trim()
    ? "geen afzender (from)"
    : to.length === 0
    ? "geen ontvanger (to)"
    : to.length > MAIL_MAX_ONTVANGERS
    ? `meer dan ${MAIL_MAX_ONTVANGERS} ontvangers in to`
    : !opties.subject?.trim()
    ? "geen onderwerp"
    : undefined;
  if (ongeldig) return { ok: false, status: 0, fout: ongeldig };
  const koppenFout = controleerKoppen(opties.headers);
  if (koppenFout) return { ok: false, status: 0, fout: koppenFout };

  const body: Record<string, unknown> = {
    from: opties.from,
    to,
    subject: opties.subject,
    html: opties.html,
  };
  if (opties.text) body.text = opties.text;
  const cc = lijst(opties.cc);
  if (cc.length) body.cc = cc;
  const bcc = lijst(opties.bcc);
  if (bcc.length) body.bcc = bcc;
  const replyTo = lijst(opties.replyTo);
  if (replyTo.length) {
    body.reply_to = replyTo.length === 1 ? replyTo[0] : replyTo;
  }
  if (opties.headers && Object.keys(opties.headers).length) {
    body.headers = { ...opties.headers };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${sleutel}`,
  };
  if (opties.idempotencyKey) headers["Idempotency-Key"] = opties.idempotencyKey;

  const tijd = AbortSignal.timeout(opties.timeoutMs ?? 10_000);
  const signal = opties.signal ? AbortSignal.any([tijd, opties.signal]) : tijd;

  let res: Response;
  try {
    res = await fetch(`${opties.apiBasis ?? RESEND_API}/emails`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    const naam = e instanceof Error ? e.name : "";
    const tekst = naam === "TimeoutError"
      ? "Resend antwoordde niet op tijd"
      : `Resend onbereikbaar: ${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, status: 0, fout: zonderSleutel(tekst, sleutel) };
  }

  const tekst = await res.text().catch(() => "");
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      fout: zonderSleutel(foutUitAntwoord(res.status, tekst), sleutel),
    };
  }
  let id: string | undefined;
  try {
    const j = JSON.parse(tekst) as { id?: unknown };
    if (typeof j.id === "string") id = j.id;
  } catch {
    // 2xx zonder JSON: verstuurd, maar zonder id.
  }
  return { ok: true, status: res.status, id };
}

// ───────────── Batch ─────────────

/** Resend aanvaardt hoogstens 100 mails per batchverzoek. */
export const MAIL_BATCH_MAX = 100;

/** Eén mail in een batch: zelfde velden als `sendMail`, zonder sleutel en opties per verzoek. */
export interface BatchMail {
  from: string;
  to: string | readonly string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string | readonly string[];
  headers?: Record<string, string>;
}

export interface BatchOpties {
  apiKey: string;
  mails: readonly BatchMail[];
  /**
   * Resend verstuurt een tweede batch met dezelfde sleutel (binnen 24 uur) niet
   * opnieuw. Gebruik iets vasts per uitgave en per deel, bv. `digest-2026-11-01/0`.
   */
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Enkel voor tests. */
  apiBasis?: string;
}

export interface BatchResultaat {
  ok: boolean;
  status: number;
  /** Resend-id per mail, in dezelfde volgorde als `mails`. */
  ids?: string[];
  fout?: string;
}

/**
 * Verstuurt tot 100 mails in één verzoek (`POST /emails/batch`). Elke mail heeft
 * een eigen `to`: zet nooit meerdere lezers samen in één mail. Gooit niet.
 *
 * Alles of niets: Resend weigert de hele batch als één mail niet deugt. Splits
 * grotere lijsten met `verdeelInBatches` uit `./nieuwsbrief`.
 */
export async function sendMailBatch(
  opties: BatchOpties,
): Promise<BatchResultaat> {
  const sleutel = (opties.apiKey ?? "").trim();
  if (!sleutel) return { ok: false, status: 0, fout: "geen Resend-sleutel" };
  const mails = opties.mails ?? [];
  if (mails.length === 0) return { ok: false, status: 0, fout: "geen mails" };
  if (mails.length > MAIL_BATCH_MAX) {
    return {
      ok: false,
      status: 0,
      fout: `meer dan ${MAIL_BATCH_MAX} mails in een batch`,
    };
  }

  const body: Record<string, unknown>[] = [];
  for (const [i, m] of mails.entries()) {
    const to = lijst(m.to);
    const ongeldig = !m.from?.trim()
      ? "geen afzender (from)"
      : to.length === 0
      ? "geen ontvanger (to)"
      : to.length > MAIL_MAX_ONTVANGERS
      ? `meer dan ${MAIL_MAX_ONTVANGERS} ontvangers in to`
      : !m.subject?.trim()
      ? "geen onderwerp"
      : controleerKoppen(m.headers);
    if (ongeldig) {
      return { ok: false, status: 0, fout: `mail ${i}: ${ongeldig}` };
    }
    const item: Record<string, unknown> = {
      from: m.from,
      to,
      subject: m.subject,
      html: m.html,
    };
    if (m.text) item.text = m.text;
    const replyTo = lijst(m.replyTo);
    if (replyTo.length) {
      item.reply_to = replyTo.length === 1 ? replyTo[0] : replyTo;
    }
    if (m.headers && Object.keys(m.headers).length) {
      item.headers = { ...m.headers };
    }
    body.push(item);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${sleutel}`,
  };
  if (opties.idempotencyKey) headers["Idempotency-Key"] = opties.idempotencyKey;

  const tijd = AbortSignal.timeout(opties.timeoutMs ?? 20_000);
  const signal = opties.signal ? AbortSignal.any([tijd, opties.signal]) : tijd;

  let res: Response;
  try {
    res = await fetch(`${opties.apiBasis ?? RESEND_API}/emails/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    const naam = e instanceof Error ? e.name : "";
    const tekst = naam === "TimeoutError"
      ? "Resend antwoordde niet op tijd"
      : `Resend onbereikbaar: ${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, status: 0, fout: zonderSleutel(tekst, sleutel) };
  }

  const tekst = await res.text().catch(() => "");
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      fout: zonderSleutel(foutUitAntwoord(res.status, tekst), sleutel),
    };
  }
  let ids: string[] | undefined;
  try {
    const j = JSON.parse(tekst) as { data?: { id?: unknown }[] };
    if (Array.isArray(j.data)) {
      ids = j.data.map((d) => (typeof d?.id === "string" ? d.id : ""));
    }
  } catch {
    // 2xx zonder JSON: verstuurd, maar zonder ids.
  }
  return { ok: true, status: res.status, ids };
}
