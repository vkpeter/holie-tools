/**
 * ai-keten: een kleine providerketen voor chat-completions, voor Deno en
 * Supabase Edge Functions.
 *
 * Probeert providers in een vaste volgorde en valt door naar de volgende bij een
 * fout, een lege of afgekapte inhoud, of een antwoord dat de aanroeper afkeurt.
 * Ondersteunt de Lovable AI-gateway en DeepSeek, allebei OpenAI-compatibel.
 *
 * ⚠️ DeepSeek V4 denkt standaard na (effort "high"). Die redeneertokens tellen
 * mee in `max_tokens` en worden als output aangerekend. Met een krappe limiet
 * breekt het antwoord af of blijft het leeg. Deze keten zet het denkwerk daarom
 * altijd uit (`thinking: { type: "disabled" }`), tenzij `deepseekDenken` aan staat.
 *
 * @module
 */

export type AiProvider = "lovable" | "deepseek";

export const STANDAARD_MODELLEN = {
  lovable: "google/gemini-3-flash-preview",
  deepseek: "deepseek-v4-flash",
  deepseekBeeld: "deepseek-v4-flash-vision-exp",
  /**
   * Spraak naar tekst. Enkel Lovable: DeepSeek verwerkt geen audio, dus hier
   * bestaat geen providerkeuze - zie `transcribeerAudio`.
   *
   * ⚠️ DE PRIJS ZIT OP DE AUDIO-MODALITEIT, NIET OP TEKST. Deze constante stond
   * eerst op 3-flash-preview en daarna kort op 2.5-flash, met "40% goedkoper" als
   * motivering. Dat was fout: die $0,30 is het TEKST-tarief. De gateway rekent
   * audio apart aan (`pricing.input.audio` in GET /v1/models, publiek), en daar
   * kosten 2.5-flash en 3-flash-preview allebei $1,00/M. Gemeten 16-09-2026, per
   * M audio-input:
   *     gemini-3.1-flash-lite   $0,50  (uit $1,50)   <- deze
   *     gemini-2.5-flash-lite   $0,30  (uit $0,40)   deprecated
   *     gemini-2.5-flash        $1,00  (uit $2,50)   deprecated
   *     gemini-3-flash-preview  $1,00  (uit $3,00)
   * ⛔ 2.5-flash-lite is goedkoper maar verloopt op 31-03-2027, en een verlopen
   * model is geen besparing. 3.1-flash-lite is het enige goedkopere dat blijft.
   *
   * ☠️ RECHTVAARDIG DIT MODEL NIET OP KWALITEIT. Bij een test met zeven ingesproken
   * zinnen (16-09-2026) maakten beide toen geteste modellen een fout: 2.5-flash
   * miste een "twee" en gaf "Mmm." op gemompel, 3-flash-preview verzon op drie
   * seconden STILTE een volledig cannelloni-recept van ruim 1500 kcal. Dit model
   * is op die zinnen NIET getoetst.
   *
   * ⛔ Reken dus niet op het model om te weigeren. Een transcriptiemodel dat
   * twijfelt vult plausibel aan; de AANROEPER hoort te toetsen of de hoeveelheid
   * tekst bij de duur van de opname past. Dat vangnet is hier meer waard dan de
   * modelkeuze zelf, want het werkt ongeacht wat hier staat.
   */
  lovableAudio: "google/gemini-3.1-flash-lite",
} as const;

/** Audioformaten die de Lovable-gateway aanvaardt voor `input_audio`. */
export const AUDIO_FORMATEN = [
  "wav",
  "mp3",
  "ogg",
  "flac",
  "aac",
  "aiff",
] as const;

export type AudioFormaat = typeof AUDIO_FORMATEN[number];

const ENDPOINT: Record<AiProvider, string> = {
  lovable: "https://ai.gateway.lovable.dev/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
};

const SLEUTEL_VAR: Record<AiProvider, string> = {
  lovable: "LOVABLE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/** Tokenverbruik zoals de provider het teruggeeft. */
export interface AiVerbruik {
  prompt_tokens?: number;
  completion_tokens?: number;
  [sleutel: string]: unknown;
}

/** Wat een hook te zien krijgt na elke poging. */
export interface AiPoging {
  label: string;
  provider: string;
  model: string;
  duurMs: number;
  /** HTTP-status, 0 bij een netwerkfout of timeout. */
  status: number;
  finishReason?: string;
  usage?: AiVerbruik;
  /** Lengte van de ontvangen inhoud in tekens, als er een antwoord was. */
  lengte?: number;
  /** Omschrijving van wat er misliep; leeg bij succes. */
  fout?: string;
}

export interface AiOpties {
  /** Naam in de logregels. */
  label: string;
  /** Enkel meegestuurd als je hem opgeeft; anders kiest de provider. */
  maxTokens?: number;
  /** Enkel meegestuurd als je hem opgeeft; anders kiest de provider. */
  temperature?: number;
  /**
   * Gaat mee als `response_format`, bv. `{ type: "json_object" }` om JSON af te
   * dwingen. Beide providers zijn OpenAI-compatibel.
   */
  responseFormat?: Record<string, unknown>;
  /** Standaard `["lovable", "deepseek"]`. */
  volgorde?: AiProvider[];
  lovableModel?: string;
  /** Standaard `deepseek-v4-flash`, met `beeld` het vision-model. */
  deepseekModel?: string;
  /** Laat DeepSeek wél nadenken. Standaard uit, zie de modulekop. */
  deepseekDenken?: boolean;
  /** De berichten bevatten een beeld. */
  beeld?: boolean;
  /**
   * Pogingen per provider, standaard 1. Een herkansing volgt op lege inhoud, 5xx, 429
   * of een netwerkfout (niet op een timeout of een extern afbreken), en met
   * `herkansBijAfkeuring` ook op een afgekeurd antwoord.
   */
  pogingen?: number;
  /** Afbreken na zoveel milliseconden per poging. */
  timeoutMs?: number;
  /** Extern afbreken, bv. een deadline voor de hele run. */
  signal?: AbortSignal;
  tools?: unknown[];
  toolChoice?: unknown;
  /** Naar welke providers de tools gaan. Standaard alle. */
  toolsVoor?: AiProvider[];
  /**
   * Lovable gaf 429 of 402. `"doorvallen"` (standaard) probeert de volgende
   * provider; `"throw"` stopt met een `AiQuotumFout`.
   */
  opQuotum?: "doorvallen" | "throw";
  /**
   * Keurt een antwoord af: dan komt de volgende provider aan de beurt, zonder herhaling,
   * tenzij `herkansBijAfkeuring` aan staat.
   */
  aanvaard?: (content: string, provider: string) => boolean;
  /** Een afgekeurd antwoord eerst opnieuw vragen bij dezelfde provider (binnen `pogingen`). */
  herkansBijAfkeuring?: boolean;
  /** Sleutels in plaats van de omgevingsvariabelen `LOVABLE_API_KEY` en `DEEPSEEK_API_KEY`. */
  sleutels?: Partial<Record<AiProvider, string>>;
  /** Na een geslaagde poging, bv. om verbruik weg te schrijven. Een fout hierin wordt genegeerd. */
  bijSucces?: (poging: AiPoging) => void | Promise<void>;
  /** Na elke mislukte poging. Een fout hierin wordt genegeerd. */
  bijFout?: (poging: AiPoging) => void | Promise<void>;
}

export interface AiAntwoord {
  content: string;
  // deno-lint-ignore no-explicit-any
  toolCall?: any;
  // deno-lint-ignore no-explicit-any
  toolCalls?: any[];
  /** `lovable`, `deepseek` of `deepseek-vision`. */
  provider: string;
  model: string;
  finishReason?: string;
  usage?: AiVerbruik;
}

/** Lovable weigerde op quotum en de aanroeper vroeg `opQuotum: "throw"`. */
export class AiQuotumFout extends Error {
  readonly status: 402 | 429;
  constructor(status: 402 | 429) {
    super(status === 429 ? "RATE_LIMIT_429" : "CREDITS_402");
    this.name = "AiQuotumFout";
    this.status = status;
  }
}

/** Geen enkele provider leverde een bruikbaar antwoord. */
export class AiOnbeschikbaar extends Error {
  /** Status van de laatste poging, 0 bij een netwerkfout. */
  readonly status: number;
  constructor(bericht: string, status: number) {
    super(bericht);
    this.name = "AiOnbeschikbaar";
    this.status = status;
  }
}

/**
 * De request-body voor DeepSeek. Staat apart zodat een test kan vastleggen dat
 * de denkvlag meegaat; inline kan een refactor hem stil laten vallen.
 */
export function bouwDeepseekBody(opties: {
  model: string;
  messages: unknown[];
  maxTokens?: number;
  temperature?: number;
  denken?: boolean;
}): Record<string, unknown> {
  return {
    model: opties.model,
    messages: opties.messages,
    ...limieten(opties.maxTokens, opties.temperature),
    thinking: { type: opties.denken ? "enabled" : "disabled" },
  };
}

/** `max_tokens` en `temperature`, maar enkel wat de aanroeper echt opgaf. */
function limieten(
  maxTokens?: number,
  temperature?: number,
): Record<string, number> {
  const uit: Record<string, number> = {};
  if (maxTokens !== undefined) uit.max_tokens = maxTokens;
  if (temperature !== undefined) uit.temperature = temperature;
  return uit;
}

/**
 * Maakt van elke gegooide waarde een leesbare tekst, nooit `[object Object]`.
 * - Een `Error` geeft zijn `message`.
 * - Een object met `message`, `code`, `details` of `hint` (zoals een PostgREST-fout
 *   van supabase-js) geeft die velden, gescheiden door ` | `.
 * - Een ander object geeft enkel zijn soort, niet zijn inhoud: die kan
 *   gebruikersgegevens bevatten en hoort niet ongevraagd in een log.
 */
export function foutTekst(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const delen = ["message", "code", "details", "hint"]
      .map((k) => o[k])
      .filter((v) =>
        (typeof v === "string" && v !== "") || typeof v === "number"
      )
      .map(String);
    if (delen.length > 0) return delen.join(" | ");
    const soort = (o.constructor as { name?: string } | undefined)?.name;
    return `onbekende fout (${soort || "object"})`;
  }
  return String(err);
}

/** Zit er een beeld in een system- of assistant-bericht? DeepSeek weigert dat met een 400. */
export function heeftBeeldInSysteem(messages: unknown[]): boolean {
  return messages.some((m) => {
    if (!m || typeof m !== "object") return false;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role === "user" || !Array.isArray(content)) return false;
    return content.some((deel) =>
      !!deel && typeof deel === "object" &&
      (deel as { type?: unknown }).type === "image_url"
    );
  });
}

function leesSleutel(naam: AiProvider, opties: AiOpties): string | undefined {
  const opgegeven = opties.sleutels?.[naam];
  if (opgegeven) return opgegeven;
  try {
    return Deno.env.get(SLEUTEL_VAR[naam]) || undefined;
  } catch {
    return undefined;
  }
}

async function roep(
  hook: AiOpties["bijSucces"],
  poging: AiPoging,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(poging);
  } catch (e) {
    console.warn(
      `[ai:${poging.label}] hook faalde: ${foutTekst(e)}`,
    );
  }
}

function combineerSignalen(
  timeoutMs?: number,
  extern?: AbortSignal,
): AbortSignal | undefined {
  const signalen = [
    timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    extern,
  ]
    .filter((s): s is AbortSignal => !!s);
  if (signalen.length === 0) return undefined;
  return signalen.length === 1 ? signalen[0] : AbortSignal.any(signalen);
}

/**
 * Stuurt de berichten naar de eerste provider die een bruikbaar antwoord geeft.
 *
 * - Een afgekapt antwoord (`finish_reason: "length"`) gaat naar de volgende
 *   provider; is er geen volgende, dan komt het toch terug.
 * - Met `beeld` krijgt DeepSeek het vision-model en wordt hij overgeslagen als
 *   het beeld in een system-bericht zit.
 * - Faalt alles, dan volgt een `AiOnbeschikbaar` met de beschikbare sleutels en
 *   de laatste fout in de melding.
 */
export async function callAi(
  messages: unknown[],
  opties: AiOpties,
): Promise<AiAntwoord> {
  const {
    label,
    maxTokens,
    temperature,
    volgorde = ["lovable", "deepseek"],
    pogingen = 1,
  } = opties;

  const beschikbaar = volgorde.filter((naam) => leesSleutel(naam, opties));
  let laatsteFout = "";
  let laatsteStatus = 0;

  for (let i = 0; i < beschikbaar.length; i++) {
    const naam = beschikbaar[i];
    const laatste = i === beschikbaar.length - 1;
    const sleutel = leesSleutel(naam, opties)!;

    if (naam === "deepseek" && opties.beeld && heeftBeeldInSysteem(messages)) {
      laatsteFout =
        "DeepSeek vision overgeslagen: beeld zit in een system-bericht";
      console.warn(`[ai:${label}] ${laatsteFout}`);
      continue;
    }

    const model = naam === "lovable"
      ? opties.lovableModel ?? STANDAARD_MODELLEN.lovable
      : opties.deepseekModel ??
        (opties.beeld
          ? STANDAARD_MODELLEN.deepseekBeeld
          : STANDAARD_MODELLEN.deepseek);
    const provider = naam === "deepseek" && opties.beeld
      ? "deepseek-vision"
      : naam;

    const body: Record<string, unknown> = naam === "deepseek"
      ? bouwDeepseekBody({
        model,
        messages,
        maxTokens,
        temperature,
        denken: opties.deepseekDenken,
      })
      : { model, messages, ...limieten(maxTokens, temperature) };
    if (opties.responseFormat) body.response_format = opties.responseFormat;
    if (
      opties.tools &&
      (opties.toolsVoor ?? ["lovable", "deepseek"]).includes(naam)
    ) {
      body.tools = opties.tools;
      if (opties.toolChoice !== undefined) body.tool_choice = opties.toolChoice;
    }

    for (let poging = 1; poging <= pogingen; poging++) {
      const start = Date.now();
      const basis = { label, provider, model };
      let herkansing = false;
      try {
        const resp = await fetch(ENDPOINT[naam], {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sleutel}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: combineerSignalen(opties.timeoutMs, opties.signal),
        });

        if (!resp.ok) {
          const detail = (await resp.text().catch(() => "")).slice(0, 200);
          laatsteFout = `${provider} gaf ${resp.status}`;
          laatsteStatus = resp.status;
          console.warn(`[ai:${label}] ${laatsteFout} ${detail}`);
          await roep(opties.bijFout, {
            ...basis,
            duurMs: Date.now() - start,
            status: resp.status,
            fout: `${laatsteFout} ${detail}`.trim(),
          });
          if (
            naam === "lovable" &&
            (resp.status === 429 || resp.status === 402) &&
            opties.opQuotum === "throw"
          ) {
            throw new AiQuotumFout(resp.status);
          }
          herkansing = resp.status >= 500 || resp.status === 429;
        } else {
          const data = await resp.json();
          const keuze = data.choices?.[0];
          const usage: AiVerbruik | undefined = data.usage;
          const finishReason: string | undefined = keuze?.finish_reason;
          const toolCalls = keuze?.message?.tool_calls;
          const content: string = keuze?.message?.content || "";
          const verslag = {
            ...basis,
            duurMs: Date.now() - start,
            status: resp.status,
            finishReason,
            usage,
            lengte: content.length,
          };

          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            await roep(opties.bijSucces, verslag);
            return {
              content,
              toolCall: toolCalls[0],
              toolCalls,
              provider,
              model,
              finishReason,
              usage,
            };
          }
          if (content && finishReason === "length" && !laatste) {
            laatsteFout = `${provider} afgekapt op max_tokens`;
            console.warn(`[ai:${label}] ${laatsteFout}`);
            await roep(opties.bijFout, { ...verslag, fout: laatsteFout });
            break;
          }
          if (content) {
            if (!opties.aanvaard || opties.aanvaard(content, provider)) {
              await roep(opties.bijSucces, verslag);
              return { content, provider, model, finishReason, usage };
            }
            laatsteFout = `${provider}: antwoord afgekeurd`;
            await roep(opties.bijFout, { ...verslag, fout: laatsteFout });
            if (!opties.herkansBijAfkeuring) break;
            herkansing = true;
          }

          laatsteFout =
            `${provider} gaf lege inhoud (finish_reason=${finishReason})`;
          console.warn(`[ai:${label}] ${laatsteFout}, poging ${poging}`);
          await roep(opties.bijFout, { ...verslag, fout: laatsteFout });
          herkansing = true;
        }
      } catch (err) {
        if (err instanceof AiQuotumFout) throw err;
        const afgebroken = err instanceof DOMException &&
          (err.name === "TimeoutError" || err.name === "AbortError");
        laatsteFout = `${provider}: ${
          afgebroken ? "afgebroken (timeout of deadline)" : foutTekst(err)
        }`;
        laatsteStatus = 0;
        console.warn(`[ai:${label}] ${laatsteFout}`);
        await roep(opties.bijFout, {
          ...basis,
          duurMs: Date.now() - start,
          status: 0,
          fout: laatsteFout,
        });
        if (opties.signal?.aborted) break;
        // Een netwerkfout (DNS, connection reset) krijgt dezelfde herkansing als een
        // 5xx. Een timeout niet: die zou de wachttijd enkel verdubbelen.
        herkansing = !afgebroken;
      }

      if (!herkansing || poging >= pogingen) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (opties.signal?.aborted) break;
  }

  throw new AiOnbeschikbaar(
    `No AI provider available (sleutels: ${beschikbaar.join("+") || "geen"}${
      laatsteFout ? `; laatste fout: ${laatsteFout}` : ""
    })`,
    laatsteStatus,
  );
}

/**
 * Providers die spraak naar tekst kunnen. Vandaag enkel Lovable, maar dit staat
 * als lijst zodat een tweede provider erbij kan zonder dat een aanroeper wijzigt.
 */
export const AUDIO_PROVIDERS: AiProvider[] = ["lovable"];

export interface AudioOpties {
  /** Naam in de logregels, bv. "transcribe-and-analyze". */
  label: string;
  /** De audio als base64, zonder `data:`-voorvoegsel. */
  base64: string;
  /** Formaat van de audio. Moet in `AUDIO_FORMATEN` zitten. */
  formaat: AudioFormaat;
  /** Instructie voor het model. Zonder opgave een letterlijke transcriptie. */
  systeem?: string;
  /** Vraag bij de audio. Zonder opgave een neutrale transcriptie-opdracht. */
  opdracht?: string;
  /** Tweeletterige taalhint, bv. "nl". */
  taal?: string;
  maxTokens?: number;
  temperature?: number;
  /** Providers in volgorde. Standaard `AUDIO_PROVIDERS`. */
  volgorde?: AiProvider[];
  /** Model bij Lovable. Standaard `STANDAARD_MODELLEN.lovableAudio`. */
  model?: string;
  /** Pogingen per provider, standaard 1. */
  pogingen?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  sleutels?: Partial<Record<AiProvider, string>>;
  bijSucces?: (poging: AiPoging) => void | Promise<void>;
}

export interface AudioAntwoord {
  tekst: string;
  provider: AiProvider;
  model: string;
  usage?: AiVerbruik;
}

const AUDIO_SYSTEEM =
  "Je bent een transcriptie-assistent. Geef ALLEEN de exacte transcriptie terug. " +
  "Corrigeer geen woorden, vervang niets semantisch en vul niets aan wat je niet gehoord hebt.";

/**
 * Zet spraak om naar tekst.
 *
 * ⛔ Dit loopt NIET via `callAi`: die keten spreekt providers aan die audio niet
 * kennen, en DeepSeek is er daar één van. Zolang `AUDIO_PROVIDERS` enkel Lovable
 * bevat, is dit de plek waar de app haar Gemini-verbruik voor spraak centraal
 * beheert - niet elke aanroeper apart.
 *
 * ⚠️ Het model aanvaardt enkel de formaten uit `AUDIO_FORMATEN`. Geef je iets
 * anders (`webm`, `mp4`), dan weigert de gateway dat niet netjes maar VERZINT ze
 * een plausibele transcriptie. Daarom weigert deze functie zo'n formaat zelf, met
 * een `TypeError`, in plaats van het door te laten: een stil verzonnen antwoord is
 * erger dan een harde fout. Herverpak in de browser naar 16 kHz mono WAV.
 */
export async function transcribeerAudio(
  opties: AudioOpties,
): Promise<AudioAntwoord> {
  if (!AUDIO_FORMATEN.includes(opties.formaat)) {
    throw new TypeError(
      `Audioformaat "${opties.formaat}" wordt niet ondersteund (wel: ${
        AUDIO_FORMATEN.join(", ")
      })`,
    );
  }

  const volgorde = opties.volgorde ?? AUDIO_PROVIDERS;
  const model = opties.model ?? STANDAARD_MODELLEN.lovableAudio;
  const pogingen = Math.max(1, opties.pogingen ?? 1);
  const taalhint = opties.taal ? ` Taalhint: ${opties.taal}.` : "";
  const opdracht = opties.opdracht ??
    `Transcribeer dit audiobericht letterlijk. Behoud komma's en opsommingen exact zoals uitgesproken. Hoor je geen verstaanbare spraak, antwoord dan exact met NIETS_VERSTAAN en verzin niets.${taalhint}`;

  const beschikbaar: string[] = [];
  let laatsteFout = "";
  let laatsteStatus = 0;

  for (const provider of volgorde) {
    const sleutel = leesSleutel(provider, opties as unknown as AiOpties);
    if (!sleutel) continue;
    beschikbaar.push(provider);

    for (let poging = 1; poging <= pogingen; poging++) {
      const start = Date.now();
      let status = 0;
      try {
        const resp = await fetch(ENDPOINT[provider], {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sleutel}`,
            "Content-Type": "application/json",
          },
          signal: combineerSignalen(opties.timeoutMs, opties.signal),
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: opties.systeem ?? AUDIO_SYSTEEM },
              {
                role: "user",
                content: [
                  {
                    type: "input_audio",
                    input_audio: {
                      data: opties.base64,
                      format: opties.formaat,
                    },
                  },
                  { type: "text", text: opdracht },
                ],
              },
            ],
            max_tokens: opties.maxTokens ?? 500,
            temperature: opties.temperature ?? 0.1,
          }),
        });
        status = resp.status;
        const data = await resp.json().catch(() => ({}));
        const tekst = data?.choices?.[0]?.message?.content ?? "";
        const duurMs = Date.now() - start;

        if (!resp.ok || !tekst) {
          laatsteStatus = status;
          laatsteFout = `${provider} gaf ${status}${
            tekst ? "" : " (lege inhoud)"
          }`;
          console.warn(`[audio:${opties.label}] ${laatsteFout}`);
          await roep(opties.bijSucces, {
            label: opties.label,
            provider,
            model,
            duurMs,
            status,
            fout: laatsteFout,
          });
          if (status === 429 || status >= 500 || !tekst) continue;
          break;
        }

        await roep(opties.bijSucces, {
          label: opties.label,
          provider,
          model,
          duurMs,
          status,
          usage: data?.usage,
          lengte: tekst.length,
        });
        return { tekst, provider, model, usage: data?.usage };
      } catch (e) {
        laatsteFout = `${provider}: ${foutTekst(e)}`;
        console.warn(`[audio:${opties.label}] ${laatsteFout}`);
        await roep(opties.bijSucces, {
          label: opties.label,
          provider,
          model,
          duurMs: Date.now() - start,
          status,
          fout: laatsteFout,
        });
      }
      if (opties.signal?.aborted) break;
    }
    if (opties.signal?.aborted) break;
  }

  throw new AiOnbeschikbaar(
    `No audio provider available (sleutels: ${beschikbaar.join("+") || "geen"}${
      laatsteFout ? `; laatste fout: ${laatsteFout}` : ""
    })`,
    laatsteStatus,
  );
}
