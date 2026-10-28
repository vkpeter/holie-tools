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

/**
 * Maximale lengte van `callback_data`, in BYTES (UTF-8), niet in tekens. Een knop
 * erboven laat het hele bericht weigeren met "BUTTON_DATA_INVALID": er komt dan
 * niets aan, ook de tekst niet.
 */
export const TELEGRAM_MAX_CALLBACK_BYTES = 64;

/** Maximale lengte van de tekst bij `answerCallbackQuery`. */
export const TELEGRAM_MAX_KLIKTEKST = 200;

/** Een knop onder een bericht (inline keyboard). Precies één van `callback_data` of `url`. */
export interface TelegramKnop {
  text: string;
  callback_data?: string;
  url?: string;
}

/** Een knop van het vaste toetsenbord onderaan het scherm (reply keyboard). */
export interface TelegramVasteKnop {
  text: string;
  /** Stuurt de locatie van de gebruiker mee. */
  request_location?: boolean;
  /** Stuurt het telefoonnummer van de gebruiker mee. */
  request_contact?: boolean;
}

/** Het vaste toetsenbord (reply keyboard), zoals de Bot API het verwacht. */
export interface TelegramVastToetsenbord {
  keyboard: TelegramVasteKnop[][];
  /** Blijft staan, ook als de gebruiker het wegklikt. */
  is_persistent?: boolean;
  /** Knoppen zo klein als nodig in plaats van een half scherm. */
  resize_keyboard?: boolean;
  /** Verdwijnt na één druk. */
  one_time_keyboard?: boolean;
  /** Grijze hint in het invoerveld, hoogstens 64 tekens. */
  input_field_placeholder?: string;
}

/** Opties voor elk verzoek naar de Bot API. */
export interface TelegramApiOpties {
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

export interface TelegramOpties extends TelegramApiOpties {
  /** Standaard `"HTML"`; `null` stuurt platte tekst. */
  parseMode?: TelegramParseMode | null;
  /** Linkvoorbeelden tonen. Standaard `false`. */
  voorbeeldLinks?: boolean;
  /** `message_id` waarop het (eerste deel van het) bericht antwoordt. */
  antwoordOp?: number;
  /** Inline keyboard; komt onder het laatste deel van een opgesplitst bericht. */
  knoppen?: TelegramKnop[][];
  /**
   * Vast toetsenbord onderaan het scherm, of `"weg"` om het te verwijderen. Komt
   * mee met het laatste deel. Niet samen met `knoppen`: een bericht heeft één
   * `reply_markup`.
   */
  toetsenbord?: TelegramVastToetsenbord | "weg";
  /** Zonder meldingsgeluid versturen. */
  stil?: boolean;
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

/** Antwoord van `telegramApi`. */
export interface TelegramApiResultaat<T = unknown> {
  ok: boolean;
  /** HTTP-status; 0 als er geen verzoek of geen antwoord was. */
  status: number;
  /** Het veld `result` van de Bot API. */
  result?: T;
  /** Wat misging, zonder token. */
  fout?: string;
}

/**
 * Escapet de tekens die Telegram in `parse_mode: "HTML"` als opmaak leest. Sinds
 * 0.9.0 één bron in `./html`; hier heruitgevoerd zodat bestaande imports blijven werken.
 */
export { escapeHtml } from "./html.ts";

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

/** Past deze waarde als `callback_data`? 1 tot 64 bytes in UTF-8. */
export function pastAlsCallbackData(data: string): boolean {
  const bytes = new TextEncoder().encode(data).length;
  return bytes >= 1 && bytes <= TELEGRAM_MAX_CALLBACK_BYTES;
}

/**
 * Toetst knoppen voor er een verzoek uitgaat. Geeft de eerste fout, of `null`
 * als alles klopt. Telegram weigert anders het hele bericht, en dat merk je pas
 * als iemand vraagt waar zijn melding bleef.
 */
export function controleerKnoppen(knoppen: TelegramKnop[][]): string | null {
  for (let r = 0; r < knoppen.length; r++) {
    for (let k = 0; k < knoppen[r].length; k++) {
      const knop = knoppen[r][k];
      const plek = `knop ${r + 1}.${k + 1}`;
      if (!knop?.text) return `${plek} heeft geen tekst`;
      const metData = knop.callback_data !== undefined;
      const metUrl = knop.url !== undefined;
      if (metData === metUrl) {
        return `${plek} ("${knop.text}") heeft niet precies één van callback_data en url`;
      }
      if (metData && !pastAlsCallbackData(knop.callback_data!)) {
        const n = new TextEncoder().encode(knop.callback_data!).length;
        return `${plek} ("${knop.text}"): callback_data is ${n} bytes, toegelaten 1 tot ${TELEGRAM_MAX_CALLBACK_BYTES}`;
      }
    }
  }
  return null;
}

function controleerToetsenbord(
  toetsenbord: TelegramVastToetsenbord | "weg",
): string | null {
  if (toetsenbord === "weg") return null;
  for (let r = 0; r < toetsenbord.keyboard.length; r++) {
    for (let k = 0; k < toetsenbord.keyboard[r].length; k++) {
      if (!toetsenbord.keyboard[r][k]?.text) {
        return `toetsenbordknop ${r + 1}.${k + 1} heeft geen tekst`;
      }
    }
  }
  return null;
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
 * Eén methode van de Bot API aanroepen, voor alles waar geen eigen helper voor
 * is (`getWebhookInfo`, `deleteMessage`, `sendPhoto`, ...). Gooit nooit en logt
 * niets. Het token staat nooit in `fout`. Na een 429 met een korte `retry_after`
 * volgt één herkansing, zoals bij `stuurTelegramBericht`.
 *
 * ```ts
 * const r = await telegramApi<{ url: string }>(token, "getWebhookInfo", {});
 * if (r.ok) console.log(r.result?.url);
 * ```
 */
export async function telegramApi<T = unknown>(
  token: string,
  methode: string,
  body: Record<string, unknown>,
  opties: TelegramApiOpties = {},
): Promise<TelegramApiResultaat<T>> {
  if (!token) return { ok: false, status: 0, fout: "token ontbreekt" };
  if (!/^[A-Za-z]+$/.test(methode)) {
    return { ok: false, status: 0, fout: `ongeldige methode "${methode}"` };
  }
  const basis = opties.apiBasis ?? "https://api.telegram.org";
  const url = `${basis}/bot${token}/${methode}`;
  const maxWacht = opties.maxWachtSeconden ?? 5;

  for (let poging = 1; poging <= 2; poging++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signaal(opties.timeoutMs ?? 10_000, opties.signal),
      });
      const data = await resp.json().catch(() => null) as
        | {
          ok?: boolean;
          description?: string;
          result?: T;
          parameters?: { retry_after?: number };
        }
        | null;

      if (resp.ok && data?.ok) {
        return { ok: true, status: resp.status, result: data.result };
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
        status: resp.status,
        fout: zonderToken(
          `Telegram gaf ${resp.status} op ${methode}${
            data?.description ? `: ${data.description}` : ""
          }`,
          token,
        ),
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        fout: zonderToken(
          err instanceof Error ? err.message : String(err),
          token,
        ),
      };
    }
  }
  // Onbereikbaar: de tweede poging keert altijd terug.
  return { ok: false, status: 0, fout: `${methode}: geen antwoord` };
}

/**
 * Stuurt een tekstbericht. Langer dan 4096 tekens wordt opgesplitst in meerdere
 * berichten. Gooit nooit: een melding die niet aankomt, mag de aanroepende flow
 * niet breken. Kijk naar `ok` en `fout`.
 *
 * Knoppen worden vooraf getoetst (`controleerKnoppen`): een `callback_data` boven
 * 64 bytes geeft meteen `ok: false` zonder verzoek, in plaats van een bericht dat
 * Telegram stil weigert.
 */
export async function stuurTelegramBericht(
  token: string,
  chatId: string | number,
  tekst: string,
  opties: TelegramOpties = {},
): Promise<TelegramResultaat> {
  const mislukt = (fout: string): TelegramResultaat => ({
    ok: false,
    messageIds: [],
    status: 0,
    fout,
  });
  if (!token || chatId === "" || chatId === undefined || chatId === null) {
    return mislukt("token of chat-id ontbreekt");
  }
  if (opties.knoppen && opties.toetsenbord) {
    return mislukt("knoppen en toetsenbord samen kan niet: één reply_markup");
  }
  const knopFout = (opties.knoppen && controleerKnoppen(opties.knoppen)) ||
    (opties.toetsenbord && controleerToetsenbord(opties.toetsenbord));
  if (knopFout) return mislukt(knopFout);

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
    if (i === delen.length - 1) {
      if (opties.knoppen) {
        body.reply_markup = { inline_keyboard: opties.knoppen };
      } else if (opties.toetsenbord === "weg") {
        body.reply_markup = { remove_keyboard: true };
      } else if (opties.toetsenbord) {
        body.reply_markup = opties.toetsenbord;
      }
    }
    if (opties.stil) body.disable_notification = true;

    const r = await telegramApi<{ message_id?: number }>(
      token,
      "sendMessage",
      body,
      opties,
    );
    status = r.status;
    if (!r.ok) return { ok: false, messageIds, status, fout: r.fout };
    if (typeof r.result?.message_id === "number") {
      messageIds.push(r.result.message_id);
    }
  }
  return { ok: true, messageIds, status };
}

/** Antwoord van de bewerkhelpers. */
export interface TelegramBewerkResultaat {
  ok: boolean;
  status: number;
  /**
   * Telegram meldde "message is not modified": de inhoud was al zo. Telt als
   * gelukt, want het bericht staat zoals gevraagd (typisch bij een dubbele klik).
   */
  ongewijzigd?: boolean;
  fout?: string;
}

function alsBewerking(r: TelegramApiResultaat): TelegramBewerkResultaat {
  if (r.ok) return { ok: true, status: r.status };
  if (r.status === 400 && r.fout?.includes("message is not modified")) {
    return { ok: true, status: r.status, ongewijzigd: true };
  }
  return { ok: false, status: r.status, fout: r.fout };
}

export interface TelegramBewerkOpties extends TelegramApiOpties {
  /** Standaard `"HTML"`; `null` stuurt platte tekst. */
  parseMode?: TelegramParseMode | null;
  /** Linkvoorbeelden tonen. Standaard `false`. */
  voorbeeldLinks?: boolean;
  /**
   * De knoppen onder het bewerkte bericht. Standaard `[]`: de knoppen gaan weg.
   * Wil je ze houden, geef ze dan opnieuw mee.
   */
  knoppen?: TelegramKnop[][];
}

/**
 * Vervangt de tekst van een bestaand bericht (`editMessageText`), bv. "✅
 * Bevestigd door Katleen" onder een melding na een klik. Gooit nooit.
 *
 * Een bewerking kan niet opgesplitst worden: tekst boven 4096 tekens geeft
 * `ok: false` zonder verzoek. Standaard verdwijnen de knoppen (zie `knoppen`).
 */
export async function bewerkTelegramBericht(
  token: string,
  chatId: string | number,
  messageId: number,
  tekst: string,
  opties: TelegramBewerkOpties = {},
): Promise<TelegramBewerkResultaat> {
  if (!tekst) return { ok: false, status: 0, fout: "lege tekst" };
  if (tekst.length > TELEGRAM_MAX_TEKST) {
    return {
      ok: false,
      status: 0,
      fout:
        `tekst te lang voor één bericht (${tekst.length} tekens, max ${TELEGRAM_MAX_TEKST})`,
    };
  }
  const knoppen = opties.knoppen ?? [];
  const knopFout = controleerKnoppen(knoppen);
  if (knopFout) return { ok: false, status: 0, fout: knopFout };

  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: tekst,
    disable_web_page_preview: !opties.voorbeeldLinks,
    reply_markup: { inline_keyboard: knoppen },
  };
  const parseMode = opties.parseMode === undefined ? "HTML" : opties.parseMode;
  if (parseMode) body.parse_mode = parseMode;
  return alsBewerking(
    await telegramApi(token, "editMessageText", body, opties),
  );
}

/**
 * Vervangt enkel de knoppen onder een bericht (`editMessageReplyMarkup`). Zonder
 * `knoppen` (of met `[]`) gaan ze weg, zodat niemand twee keer klikt. Gooit nooit.
 */
export async function zetTelegramKnoppen(
  token: string,
  chatId: string | number,
  messageId: number,
  knoppen: TelegramKnop[][] = [],
  opties: TelegramApiOpties = {},
): Promise<TelegramBewerkResultaat> {
  const knopFout = controleerKnoppen(knoppen);
  if (knopFout) return { ok: false, status: 0, fout: knopFout };
  return alsBewerking(
    await telegramApi(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: knoppen },
    }, opties),
  );
}

export interface TelegramKlikOpties extends TelegramApiOpties {
  /** Korte melding bovenaan het scherm; langer dan 200 tekens wordt geknipt. */
  tekst?: string;
  /** Een venster met OK-knop in plaats van een korte melding. */
  alert?: boolean;
  /** Een URL die de app opent (enkel voor games en `t.me`-links). */
  url?: string;
  /** Hoe lang de app het antwoord mag cachen. */
  cacheSeconden?: number;
}

/**
 * Beantwoordt een knopklik (`answerCallbackQuery`). Doe dat altijd, ook zonder
 * tekst: anders blijft de knop bij de gebruiker tot 15 seconden "laden". Gooit
 * nooit.
 */
export async function beantwoordKlik(
  token: string,
  callbackQueryId: string,
  opties: TelegramKlikOpties = {},
): Promise<TelegramApiResultaat<boolean>> {
  if (!callbackQueryId) {
    return { ok: false, status: 0, fout: "callback_query_id ontbreekt" };
  }
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (opties.tekst) {
    body.text = opties.tekst.length > TELEGRAM_MAX_KLIKTEKST
      ? opties.tekst.slice(0, TELEGRAM_MAX_KLIKTEKST - 1) + "…"
      : opties.tekst;
  }
  if (opties.alert) body.show_alert = true;
  if (opties.url) body.url = opties.url;
  if (opties.cacheSeconden !== undefined) {
    body.cache_time = opties.cacheSeconden;
  }
  return await telegramApi<boolean>(token, "answerCallbackQuery", body, opties);
}

/** Welke updates een webhook krijgt, bv. `["message", "callback_query"]`. */
export type TelegramUpdateSoort =
  | "message"
  | "edited_message"
  | "callback_query"
  | "inline_query"
  | "my_chat_member"
  | "chat_member"
  | (string & Record<never, never>);

export interface TelegramWebhookOpties extends TelegramApiOpties {
  /**
   * `secret_token` dat Telegram bij elke levering meestuurt; controleer het met
   * `controleerWebhookGeheim`. 1 tot 256 tekens uit A-Z a-z 0-9 _ -. Zie
   * `leidWebhookGeheimAf` om er geen tweede sleutel voor te bewaren.
   */
  geheim?: string;
  /**
   * Welke updates. ⚠️ Weglaten houdt de vorige instelling aan, niet "alles": wie
   * knopkliks wil, zet `callback_query` er expliciet in.
   */
  updates?: TelegramUpdateSoort[];
  /** Hoeveel gelijktijdige leveringen (1 tot 100). */
  maxVerbindingen?: number;
  /** Wachtende updates weggooien. */
  wisWachtrij?: boolean;
}

/**
 * Zet de webhook (`setWebhook`). Gooit nooit. Een webhookadres moet HTTPS zijn;
 * een geheim met tekens die Telegram weigert geeft `ok: false` zonder verzoek.
 */
export async function zetWebhook(
  token: string,
  url: string,
  opties: TelegramWebhookOpties = {},
): Promise<TelegramApiResultaat<boolean>> {
  if (!url.startsWith("https://")) {
    return { ok: false, status: 0, fout: "webhookadres moet https:// zijn" };
  }
  const body: Record<string, unknown> = { url };
  if (opties.geheim !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(opties.geheim)) {
      return {
        ok: false,
        status: 0,
        fout: "geheim moet 1 tot 256 tekens uit A-Z a-z 0-9 _ - zijn",
      };
    }
    body.secret_token = opties.geheim;
  }
  if (opties.updates) body.allowed_updates = opties.updates;
  if (opties.maxVerbindingen !== undefined) {
    body.max_connections = opties.maxVerbindingen;
  }
  if (opties.wisWachtrij) body.drop_pending_updates = true;
  return await telegramApi<boolean>(token, "setWebhook", body, opties);
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
