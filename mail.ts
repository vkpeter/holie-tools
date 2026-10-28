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
