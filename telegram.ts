/**
 * Telegram Bot API: berichten versturen en webhooks controleren.
 *
 * Runtime-neutraal: enkel `fetch`, `AbortSignal`, `TextEncoder` en Web Crypto, dus
 * het werkt in Supabase edge functions (Deno) en in een Cloudflare Worker
 * (TanStack Start op Lovable).
 *
 * Privacy en sleutels, bewust zo ontworpen:
 * - Deze module leest GEEN omgevingsvariabelen en kent geen tokens, chat-id's of
 *   ontvangers. Het project leest die zelf en geeft ze mee als parameter.
 * - Er wordt niets gelogd: geen tekst, geen chat-id. Wat misging staat in het
 *   resultaat, en de aanroeper beslist wat daarvan in een log mag.
 * - Het bot-token staat in de URL van de Bot API, en Deno zet die URL letterlijk in
 *   een fetch-foutmelding. Elke foutmelding wordt daarom ontdaan van het token.
 */

/** Maximale lengte van één tekstbericht volgens de Bot API. */
export const TELEGRAM_MAX_TEKST = 4096;

/** Header waarmee Telegram het `secret_token` van de webhook meestuurt. */
export const TELEGRAM_GEHEIM_HEADER = "X-Telegram-Bot-Api-Secret-Token";

export type TelegramParseMode = "HTML" | "Markdown" | "MarkdownV2";

export interface TelegramKnop {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramOpties {
  /** Standaard `"HTML"`; `null` stuurt platte tekst. */
  parseMode?: TelegramParseMode | null;
  /** Linkvoorbeelden tonen. Standaard `false`. */
  voorbeeldLinks?: boolean;
  /** `message_id` waarop het (eerste deel van het) bericht antwoordt. */
  antwoordOp?: number;
  /** Inline keyboard; komt onder het laatste deel van een opgesplitst bericht. */
  knoppen?: TelegramKnop[][];
  /** Zonder meldingsgeluid versturen. */
  stil?: boolean;
  /** Timeout per verzoek. Standaard 10 000 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Eén herkansing na een 429 als Telegram hoogstens zoveel seconden wachttijd
   * vraagt (`retry_after`). Standaard 5; 0 schakelt de herkansing uit.
   */
  maxWachtSeconden?: number;
  /** Enkel voor tests. Standaard `https://api.telegram.org`. */
  apiBasis?: string;
}

export interface TelegramResultaat {
  ok: boolean;
  /** `message_id` per verstuurd deel, in volgorde. */
  messageIds: number[];
  /** HTTP-status van het laatste verzoek; 0 als er geen antwoord kwam. */
  status: number;
  /** Wat misging, zonder token. */
  fout?: string;
}

/** Escapet de tekens die Telegram in `parse_mode: "HTML"` als opmaak leest. */
export function escapeHtml(tekst: string): string {
  return tekst
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Knipt een tekst in delen van hoogstens `max` tekens, bij voorkeur op een regeleinde.
 * Een HTML-tag die over een regeleinde loopt, kan zo doormidden gaan: hou opmaak per
 * regel als een bericht lang kan worden.
 */
export function knipTekst(tekst: string, max = TELEGRAM_MAX_TEKST): string[] {
  if (max < 1) throw new Error("max moet minstens 1 zijn");
  const delen: string[] = [];
  let rest = tekst;
  while (rest.length > max) {
    const knip = rest.lastIndexOf("\n", max);
    const eind = knip > 0 ? knip : max;
    delen.push(rest.slice(0, eind));
    rest = rest.slice(knip > 0 ? eind + 1 : eind);
  }
  if (rest.length > 0 || delen.length === 0) delen.push(rest);
  return delen;
}

/** Haalt het token uit een tekst, zodat een foutmelding veilig gelogd kan worden. */
function zonderToken(tekst: string, token: string): string {
  return token ? tekst.split(token).join("<token>") : tekst;
}

function signaal(
  timeoutMs: number,
  extern?: AbortSignal,
): AbortSignal {
  const tijd = AbortSignal.timeout(timeoutMs);
  return extern ? AbortSignal.any([tijd, extern]) : tijd;
}

/**
 * Stuurt een tekstbericht. Langer dan 4096 tekens wordt opgesplitst in meerdere
 * berichten. Gooit nooit: een melding die niet aankomt, mag de aanroepende flow
 * niet breken. Kijk naar `ok` en `fout`.
 */
export async function stuurTelegramBericht(
  token: string,
  chatId: string | number,
  tekst: string,
  opties: TelegramOpties = {},
): Promise<TelegramResultaat> {
  if (!token || chatId === "" || chatId === undefined || chatId === null) {
    return {
      ok: false,
      messageIds: [],
      status: 0,
      fout: "token of chat-id ontbreekt",
    };
  }
  const basis = opties.apiBasis ?? "https://api.telegram.org";
  const url = `${basis}/bot${token}/sendMessage`;
  const delen = knipTekst(tekst);
  const messageIds: number[] = [];
  let status = 0;

  for (let i = 0; i < delen.length; i++) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: delen[i],
      disable_web_page_preview: !opties.voorbeeldLinks,
    };
    const parseMode = opties.parseMode === undefined
      ? "HTML"
      : opties.parseMode;
    if (parseMode) body.parse_mode = parseMode;
    if (i === 0 && opties.antwoordOp) {
      body.reply_to_message_id = opties.antwoordOp;
    }
    if (i === delen.length - 1 && opties.knoppen) {
      body.reply_markup = { inline_keyboard: opties.knoppen };
    }
    if (opties.stil) body.disable_notification = true;

    const maxWacht = opties.maxWachtSeconden ?? 5;
    for (let poging = 1; poging <= 2; poging++) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: signaal(opties.timeoutMs ?? 10_000, opties.signal),
        });
        status = resp.status;
        const data = await resp.json().catch(() => null) as
          | {
            ok?: boolean;
            description?: string;
            result?: { message_id?: number };
            parameters?: { retry_after?: number };
          }
          | null;

        if (resp.ok && data?.ok) {
          if (typeof data.result?.message_id === "number") {
            messageIds.push(data.result.message_id);
          }
          break;
        }

        const wacht = data?.parameters?.retry_after;
        if (
          resp.status === 429 && poging === 1 && typeof wacht === "number" &&
          wacht <= maxWacht && maxWacht > 0
        ) {
          await new Promise((r) => setTimeout(r, wacht * 1000));
          continue;
        }
        return {
          ok: false,
          messageIds,
          status,
          fout: zonderToken(
            `Telegram gaf ${resp.status}${
              data?.description ? `: ${data.description}` : ""
            }`,
            token,
          ),
        };
      } catch (err) {
        return {
          ok: false,
          messageIds,
          status: 0,
          fout: zonderToken(
            err instanceof Error ? err.message : String(err),
            token,
          ),
        };
      }
    }
  }
  return { ok: true, messageIds, status };
}

/**
 * Stuurt hetzelfde bericht naar meerdere chats, na elkaar. Gooit nooit.
 * `bereikt` telt de chats waar elk deel aankwam.
 */
export async function stuurNaarChats(
  token: string,
  chatIds: readonly (string | number)[],
  tekst: string,
  opties: TelegramOpties = {},
): Promise<{ bereikt: number; resultaten: TelegramResultaat[] }> {
  const resultaten: TelegramResultaat[] = [];
  for (const chatId of chatIds) {
    resultaten.push(await stuurTelegramBericht(token, chatId, tekst, opties));
  }
  return { bereikt: resultaten.filter((r) => r.ok).length, resultaten };
}

/**
 * Vergelijkt twee teksten zonder vroeg te stoppen bij het eerste verschil.
 * JavaScript geeft geen harde garantie op constante tijd, maar zo lekt de
 * vergelijking niet via een vroege uitstap hoeveel tekens er klopten.
 */
export function gelijkeTekst(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  const lengte = Math.max(ea.length, eb.length);
  let verschil = ea.length ^ eb.length;
  for (let i = 0; i < lengte; i++) {
    verschil |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  }
  return verschil === 0;
}

/**
 * Klopt het `secret_token` dat Telegram meestuurt? Zonder verwacht geheim is het
 * antwoord altijd `false`: een webhook zonder geheim staat open voor iedereen.
 */
export function controleerWebhookGeheim(
  bron: Request | Headers,
  verwacht: string | null | undefined,
): boolean {
  if (!verwacht) return false;
  const headers = bron instanceof Headers ? bron : bron.headers;
  return gelijkeTekst(headers.get(TELEGRAM_GEHEIM_HEADER) ?? "", verwacht);
}

/**
 * Leidt een webhookgeheim af uit het bot-token, zodat er geen tweede sleutel
 * bewaard hoeft te worden: base64url van SHA-256 over `${context}:${token}`.
 * Met de standaardcontext is dat exact wat Eagle-Eye Scissors al gebruikt. Het
 * resultaat (43 tekens, A-Z a-z 0-9 _ -) is geldig als `secret_token`.
 */
export async function leidWebhookGeheimAf(
  token: string,
  context = "telegram-webhook",
): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${context}:${token}`),
  );
  let binair = "";
  for (const byte of new Uint8Array(hash)) binair += String.fromCharCode(byte);
  return btoa(binair).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}
