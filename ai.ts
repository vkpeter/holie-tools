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
   * Spraak naar tekst, in volgorde van voorkeur. Enkel Lovable: DeepSeek verwerkt
   * geen audio, dus de keten loopt hier over MODELLEN bij dezelfde provider in
   * plaats van over providers - zie `transcribeerAudio`.
   *
   * ⚠️ DE PRIJS ZIT OP DE AUDIO-MODALITEIT, NIET OP TEKST. Deze lijst stond eerst
   * op 3-flash-preview en daarna kort op 2.5-flash, met "40% goedkoper" als
   * motivering. Dat was fout: die $0,30 was het TEKST-tarief. De gateway rekent
   * audio apart aan (`pricing.input.audio` in GET /v1/models, publiek op te
   * vragen). Gemeten 16-09-2026, per M audio-input:
   *     gemini-2.5-flash-lite   $0,30  (uit $0,40)   <- standaard
   *     gemini-3.1-flash-lite   $0,50  (uit $1,50)   <- terugval
   *     gemini-2.5-flash        $1,00  (uit $2,50)
   *     gemini-3-flash-preview  $1,00  (uit $3,00)
   * De twee die hier eerder stonden waren dus de duurste van het stel.
   *
   * ☠️ 2.5-flash-lite IS DEPRECATED EN VERLOOPT OP 28-01-2027. Dat is bewust
   * aanvaard (Peter, 16-09-2026): het is de goedkoopste, en 3.1-flash-lite staat
   * eronder als vangnet zodat spraak blijft werken wanneer het eerste model
   * wegvalt. ⚠️ Die terugval maakt de vervaldatum minder scherp, maar niet
   * onschuldig: zodra 2.5-flash-lite stopt, betaal je stilzwijgend het duurdere
   * tarief. Controleer de lijst rond die datum.
   *
   * ☠️ RECHTVAARDIG DEZE MODELLEN NIET OP KWALITEIT. Bij een test met zeven
   * ingesproken zinnen (16-09-2026) maakten de twee toen geteste modellen allebei
   * een fout: 2.5-flash miste een "twee" en gaf "Mmm." op gemompel,
   * 3-flash-preview verzon op drie seconden STILTE een volledig cannelloni-recept
   * van ruim 1500 kcal. Geen van de modellen in deze lijst is op die zinnen
   * getoetst.
   *
   * ⛔ Reken dus niet op het model om te weigeren. Een transcriptiemodel dat
   * twijfelt vult plausibel aan; de AANROEPER hoort te toetsen of de hoeveelheid
   * tekst bij de duur van de opname past. Dat vangnet is meer waard dan de
   * modelkeuze zelf, want het werkt ongeacht wat hier staat.
   */
  lovableAudio: [
    "google/gemini-2.5-flash-lite",
    "google/gemini-3.1-flash-lite",
  ],
  /**
   * Beeldgeneratie, goedkoopste eerst. Enkel Lovable: DeepSeek is tekst-only.
   *
   * DE PRIJS ZIT OP DE BEELD-MODALITEIT, NIET OP TEKST. Vergelijk op
   * `pricing.output.image` uit `GET /v1/models` (publiek, geen sleutel nodig),
   * niet op `pricing.input.text`. Bij een artikelbeeld domineert de beelduitvoer
   * de kost volledig, dus een model met dure tekst-input maar goedkope
   * beelduitvoer is nog altijd de betere keuze. Gemeten 16-09-2026, per M
   * beeld-uit:
   *     gpt-image-1-mini              $  8   DEPRECATED, geen einddatum
   *     gemini-2.5-flash-image        $ 30   DEPRECATED, verloopt 15-03-2027
   *     gemini-3.1-flash-lite-image   $ 30   actief      <- standaard
   *     gpt-image-2                   $ 30   actief
   *     gemini-3.1-flash-image        $ 60   actief
   *     gemini-3-pro-image            $120   actief
   *
   * DE TERUGVAL MOET EVEN DUUR ZIJN ALS HET EERSTE MODEL. Springt hij in omdat
   * het eerste model wegvalt, dan mag dat de kost niet verdubbelen: dat is
   * precies het moment waarop niemand naar de factuur kijkt.
   * `gemini-3.1-flash-image` ($60) stond hier daarom even en is er weer uit.
   *
   * De oude tweede plaats bij Eendje was `gemini-3.1-flash-image-preview`, en
   * die id BESTAAT NIET op de gateway (nagemeten over 44 modellen). Er was daar
   * dus feitelijk geen terugval: viel het eerste model weg, dan liep de tweede
   * poging op een onbekend model.
   *
   * GEEN OpenAI-modellen (Peter, 16-09-2026). `gpt-image-2` is even duur en niet
   * vervallend, maar staat er bewust niet in. Niet opnieuw voorstellen.
   *
   * Vóór 15-03-2027 verloopt de terugval. Binnen Google blijft dan enkel de
   * $60-variant over; kijk of er tegen die tijd iets nieuws op $30 staat.
   */
  lovableBeeld: [
    "google/gemini-3.1-flash-lite-image",
    "google/gemini-2.5-flash-image",
  ],
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

/**
 * Videoformaten die als VIDEO-deel meegaan in plaats van als `input_audio`.
 *
 * ⚠️ Dit is een ander bericht-onderdeel, geen ander formaat van hetzelfde: de
 * gateway verwacht `{ type: "video", video: { data, format } }` waar audio
 * `{ type: "input_audio", input_audio: { data, format } }` krijgt. Wie een mp4
 * als `input_audio` aanbiedt, krijgt een weigering of een leeg antwoord terug.
 *
 * Toegevoegd 17-09-2026 voor Billara: doorgestuurde video's in Telegram werden
 * daar met een eigen fetch getranscribeerd, omdat dit pakket ze niet aankon.
 *
 * ☠️ `webm` staat er BEWUST NIET in. De test "weigert een formaat dat het model
 * niet kan lezen" legt een eerdere meting vast: de gateway weigert webm niet
 * netjes maar verzint een plausibel klinkende transcriptie, en een verzonnen
 * transcript dat als echt doorgaat is erger dan een fout. Die meting ging over
 * webm als `input_audio`; of het als video-deel wel klopt is NIET gemeten. Tot
 * iemand dat meet blijft webm geweigerd. Zet het er niet bij "omdat het logisch
 * lijkt".
 */
export const VIDEO_FORMATEN = [
  "mp4",
  "mov",
] as const;

export type VideoFormaat = typeof VIDEO_FORMATEN[number];

/** Alles wat `transcribeerAudio` aankan: audio of video. */
export type MediaFormaat = AudioFormaat | VideoFormaat;

/** Hoort dit formaat bij de videokant? */
export function isVideoFormaat(formaat: string): formaat is VideoFormaat {
  return (VIDEO_FORMATEN as readonly string[]).includes(formaat);
}

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
  /**
   * Formaat van de opname. Moet in `AUDIO_FORMATEN` of `VIDEO_FORMATEN` zitten.
   * Een videoformaat gaat als video-deel mee, audio als `input_audio`.
   */
  formaat: MediaFormaat;
  /** Instructie voor het model. Zonder opgave een letterlijke transcriptie. */
  systeem?: string;
  /** Vraag bij de audio. Zonder opgave een neutrale transcriptie-opdracht. */
  opdracht?: string;
  /** Tweeletterige taalhint, bv. "nl". */
  taal?: string;
  /**
   * Waar de opname over gaat, bv. "voeding: wat iemand at of dronk".
   *
   * Stuurt de AKOESTISCHE keuze bij een kort of los woord, waar het model
   * anders het dichtstbijzijnde alledaagse woord pakt. Gemeten 16-09-2026 in
   * Foodie: "druiven" werd "draai".
   *
   * Het domein belandt in de SYSTEEMPROMPT (`audioSysteem`), niet achteraan de
   * opdracht: de systeemrol stuurt hoe het model luistert, en een hint aan het
   * eind komt te laat om de akoestische keuze te halen.
   *
   * Dit maakt de poort die het transcript beoordeelt NIET overbodig. De hint
   * zegt waar het over gaat, niet dat er iets moet zijn: een model dat twijfelt
   * vult plausibel aan, en een domeinhint maakt dat aanvullen juist
   * geloofwaardiger. Daarom staat het verbod achteraan in de systeemprompt, als
   * laatste instructie, en toetst de aanroeper het resultaat alsnog.
   */
  domein?: string;
  maxTokens?: number;
  temperature?: number;
  /** Providers in volgorde. Standaard `AUDIO_PROVIDERS`. */
  volgorde?: AiProvider[];
  /**
   * Model of modellen bij Lovable, in volgorde van voorkeur. Standaard
   * `STANDAARD_MODELLEN.lovableAudio`. Een enkele string mag ook.
   */
  model?: string | string[];
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

/**
 * Taalcode naar een naam die een model echt als instructie leest.
 *
 * ⚠️ "De spreker spreekt nl." is een ISO-code, geen zin. Een taalnaam stuurt
 * beter, en bij Nederlands is **Vlaams** preciezer dan "Nederlands": de sprekers
 * van deze apps zijn Vlaams, en dat stuurt zowel de woordkeuze (pistolet, frigo,
 * croque, choco) als de klankherkenning. Een onbekende code gaat ongewijzigd
 * mee - beter een ruwe hint dan geen.
 */
const TAALNAMEN: Record<string, string> = {
  nl: "Vlaams (Belgisch Nederlands)",
  en: "Engels",
  fr: "Frans",
  de: "Duits",
  es: "Spaans",
  it: "Italiaans",
  pt: "Portugees",
  pl: "Pools",
  tr: "Turks",
  ar: "Arabisch",
};

/** Geeft de taalnaam voor een code, of de code zelf als die onbekend is. */
export function taalnaam(code: string): string {
  return TAALNAMEN[code.slice(0, 2).toLowerCase()] ?? code;
}

const AUDIO_SYSTEEM =
  "Je bent een transcriptie-assistent. Geef ALLEEN de exacte transcriptie terug. " +
  "Corrigeer geen woorden, vervang niets semantisch en vul niets aan wat je niet gehoord hebt.";

/**
 * Systeemprompt wanneer de aanroeper een domein meegeeft.
 *
 * ⚠️ Het domein staat in de SYSTEEMROL en niet enkel in de opdracht: de
 * systeemrol stuurt hoe het model luistert, de opdracht zegt wat het oplevert.
 * Een hint achteraan de opdracht komt te laat om de akoestische keuze te halen.
 *
 * De volgorde binnen deze tekst is bewust: eerst WAT het model is, dan het
 * domein als luisterkader, en pas daarna het verbod. Het verbod staat achteraan
 * omdat het de laatste instructie is die telt bij een twijfelgeval.
 */
function audioSysteem(domein: string): string {
  return "Je bent een transcriptie-assistent voor korte gesproken notities over " +
    `${domein}. ` +
    "Klinkt een woord als twee mogelijkheden, kies dan de mogelijkheid die in " +
    "deze context een bestaand woord is; bij gelijke waarschijnlijkheid kies je " +
    "wat je letterlijk hoorde. " +
    "Geef ALLEEN de transcriptie terug. Corrigeer geen woorden, vervang niets " +
    "semantisch en vul NOOIT iets aan wat je niet gehoord hebt: het domein is " +
    "een luisterkader, geen reden om er iets bij te bedenken.";
}

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
  const video = isVideoFormaat(opties.formaat);
  if (
    !video &&
    !(AUDIO_FORMATEN as readonly string[]).includes(opties.formaat)
  ) {
    throw new TypeError(
      `Formaat "${opties.formaat}" wordt niet ondersteund (audio: ${
        AUDIO_FORMATEN.join(", ")
      }; video: ${VIDEO_FORMATEN.join(", ")})`,
    );
  }

  const volgorde = opties.volgorde ?? AUDIO_PROVIDERS;
  // De keten loopt hier over modellen, niet over providers: er is er maar een die
  // audio kan, en de terugval is een ander model bij diezelfde gateway.
  const modellen =
    (Array.isArray(opties.model)
      ? opties.model
      : opties.model
      ? [opties.model]
      : [...STANDAARD_MODELLEN.lovableAudio]).filter(Boolean);
  const pogingen = Math.max(1, opties.pogingen ?? 1);
  const taalhint = opties.taal
    ? ` De spreker spreekt ${taalnaam(opties.taal)}.`
    : "";
  // Het domein zit in de SYSTEEMPROMPT (zie `audioSysteem`), niet hier: een hint
  // achteraan de opdracht komt te laat om de akoestische keuze te sturen.
  //
  // Deze opdracht zegt wat het model moet OPLEVEREN. Twee dingen zijn bewust
  // concreet in plaats van verbiedend geformuleerd: wat te doen bij een half
  // verstaan woord (liever weglaten dan gokken) en wat te doen bij stilte
  // (exact NIETS_VERSTAAN). Een model dat alleen hoort wat het NIET mag doen,
  // kiest bij twijfel alsnog iets plausibels.
  const opdracht = opties.opdracht ??
    `Transcribeer dit ${
        video ? "videobericht" : "audiobericht"
      } woord voor woord.` +
      " Behoud komma's en opsommingen exact zoals uitgesproken." +
      taalhint +
      " Versta je een woord maar half, geef dan wat je hoorde en gok niet naar iets langers." +
      " Hoor je helemaal geen verstaanbare spraak, antwoord dan met exact dit woord: NIETS_VERSTAAN.";

  const beschikbaar: string[] = [];
  let laatsteFout = "";
  let laatsteStatus = 0;

  for (const provider of volgorde) {
    const sleutel = leesSleutel(provider, opties as unknown as AiOpties);
    if (!sleutel) continue;
    beschikbaar.push(provider);

    for (const model of modellen) {
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
                {
                  role: "system",
                  content: opties.systeem ??
                    (opties.domein
                      ? audioSysteem(opties.domein)
                      : AUDIO_SYSTEEM),
                },
                {
                  role: "user",
                  content: [
                    video
                      ? {
                        type: "video",
                        video: {
                          data: opties.base64,
                          format: opties.formaat,
                        },
                      }
                      : {
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
            // Een 5xx, 429 of leeg antwoord is tijdelijk: opnieuw bij hetzelfde
            // model. Een 4xx betekent dat DIT model het niet aankan (ingetrokken,
            // formaat geweigerd) - dan heeft herkansen geen zin en is het volgende
            // model aan de beurt. ⚠️ Zonder die tweede tak zou een ingetrokken
            // standaardmodel de hele spraakweg platleggen terwijl de terugval klaarstaat.
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
    if (opties.signal?.aborted) break;
  }

  throw new AiOnbeschikbaar(
    `No audio provider available (sleutels: ${beschikbaar.join("+") || "geen"}${
      laatsteFout ? `; laatste fout: ${laatsteFout}` : ""
    })`,
    laatsteStatus,
  );
}

/** Providers die beeld kunnen. DeepSeek is tekst-only, dus enkel Lovable. */
export const BEELD_PROVIDERS: AiProvider[] = ["lovable"];

export interface BeeldOpties {
  /** Naam in de logregels, bv. "telegram-webhook". */
  label: string;
  /** De prompt voor het beeld, in het Engels. */
  prompt: string;
  /**
   * Model of modellen bij Lovable, in volgorde van voorkeur. Standaard
   * `STANDAARD_MODELLEN.lovableBeeld`. Een enkele string mag ook.
   */
  model?: string | string[];
  /** Hoeveel bytes het beeld hoogstens mag zijn. Standaard 10 MB. */
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  volgorde?: AiProvider[];
  sleutels?: Partial<Record<AiProvider, string>>;
  bijSucces?: (poging: AiPoging) => void | Promise<void>;
}

export interface BeeldAntwoord {
  /** De ruwe bytes van het beeld. */
  bytes: Uint8Array;
  /** Het mediatype dat het model teruggaf, bv. "image/png". */
  mimeType: string;
  provider: AiProvider;
  model: string;
  usage?: AiVerbruik;
}

/**
 * Het model antwoordde met tekst in plaats van met een beeld.
 *
 * Dat doet het wanneer het de prompt weigert. Die poging IS aangerekend, en het
 * is een inhoudelijke weigering, geen storing: herkansen bij hetzelfde model
 * heeft dus geen zin. De tekst komt mee zodat de aanroeper hem kan loggen.
 */
export class BeeldGeweigerd extends Error {
  readonly tekst: string;
  readonly model: string;
  constructor(model: string, tekst: string) {
    super(
      `Model ${model} gaf tekst in plaats van een beeld: ${
        tekst.slice(0, 200)
      }`,
    );
    this.name = "BeeldGeweigerd";
    this.model = model;
    this.tekst = tekst;
  }
}

/**
 * Genereert een beeld en geeft de bytes terug.
 *
 * Verhuisd uit Eendjes `supabase/functions/_shared/article-image.ts` op
 * 16-09-2026, zodat alle AI-calls van Holie via dit pakket lopen.
 *
 * Dit loopt NIET via `callAi`: DeepSeek genereert geen beelden, dus de keten
 * loopt hier over MODELLEN bij dezelfde provider in plaats van over providers,
 * net als bij `transcribeerAudio`.
 *
 * Drie regels die met bloed geschreven zijn en die elke herschrijving moeten
 * overleven. Ze komen uit de Eendje-implementatie, waar ze allemaal een keer
 * geld of een stille storing gekost hebben:
 *
 * 1. NOOIT OPNIEUW PROBEREN NA EEN TIMEOUT OF NETWERKFOUT. Een beeld dat
 *    server-side al gerenderd is, is al aangerekend, ook als het antwoord jou
 *    nooit bereikt. Een herkansing betekent dan twee keer betalen. Bij een
 *    HTTP-FOUTSTATUS ligt dat anders: dan heeft de gateway niets gerenderd en
 *    niets aangerekend, en mag het volgende model wel.
 * 2. BIJ 402 OF 403 NIET DOORVALLEN naar het volgende model. Die statussen gaan
 *    over de rekening (prepaid potje leeg, of de creditlimiet van de workspace),
 *    niet over het model. Doorvallen raakt dezelfde muur nog een keer en maakt
 *    de fout onleesbaar. Er komt een `AiQuotumFout` uit, zodat de aanroeper het
 *    verschil ziet tussen "geen krediet" en "model stuk".
 * 3. HET MODEL KAN MET TEKST ANTWOORDEN in plaats van met een beeld. Zie
 *    `BeeldGeweigerd`.
 *
 * Het antwoordformaat is dat van de Gemini-modellen op de Lovable-gateway:
 * `choices[0].message.images[0].image_url.url` als data-URL. Zet je hier ooit een
 * model van een andere leverancier in, toets dan EERST of die veldnamen kloppen.
 * Een terugval die stil breekt op het moment dat hij moet inspringen, is erger
 * dan geen terugval.
 */
export async function genereerBeeld(
  opties: BeeldOpties,
): Promise<BeeldAntwoord> {
  const volgorde = opties.volgorde ?? BEELD_PROVIDERS;
  const modellen =
    (Array.isArray(opties.model)
      ? opties.model
      : opties.model
      ? [opties.model]
      : [...STANDAARD_MODELLEN.lovableBeeld]).filter(Boolean);
  const maxBytes = opties.maxBytes ?? 10 * 1024 * 1024;

  const beschikbaar: string[] = [];
  let laatsteFout = "";
  let laatsteStatus = 0;

  for (const provider of volgorde) {
    const sleutel = leesSleutel(provider, opties as unknown as AiOpties);
    if (!sleutel) continue;
    beschikbaar.push(provider);

    for (const model of modellen) {
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
            messages: [{ role: "user", content: opties.prompt }],
            modalities: ["image", "text"],
          }),
        });
        status = resp.status;
        const duurMs = Date.now() - start;

        // Regel 2: dit gaat over de rekening, niet over het model.
        if (status === 402 || status === 403 || status === 429) {
          await roep(opties.bijSucces, {
            label: opties.label,
            provider,
            model,
            duurMs,
            status,
            fout: `${provider} gaf ${status}`,
          });
          throw new AiQuotumFout(status === 429 ? 429 : 402);
        }

        const data = await resp.json().catch(() => ({}));

        if (!resp.ok) {
          laatsteStatus = status;
          laatsteFout = `${provider} gaf ${status}`;
          console.warn(`[beeld:${opties.label}] ${laatsteFout}`);
          await roep(opties.bijSucces, {
            label: opties.label,
            provider,
            model,
            duurMs,
            status,
            fout: laatsteFout,
          });
          // Een foutstatus betekent dat er niets gerenderd en dus niets
          // aangerekend is: het volgende model mag het proberen.
          continue;
        }

        const dataUrl = data?.choices?.[0]?.message?.images?.[0]?.image_url
          ?.url;

        // Regel 3: tekst in plaats van een beeld is een weigering, geen storing.
        if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
          const tekst = (data?.choices?.[0]?.message?.content ?? "").toString();
          await roep(opties.bijSucces, {
            label: opties.label,
            provider,
            model,
            duurMs,
            status,
            usage: data?.usage,
            fout: "geen beeld in het antwoord",
          });
          throw new BeeldGeweigerd(model, tekst);
        }

        const komma = dataUrl.indexOf(",");
        const kop = dataUrl.slice(0, komma);
        const puntkomma = kop.indexOf(";");
        const mimeType = puntkomma > 5 ? kop.slice(5, puntkomma) : "image/png";

        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(
            atob(dataUrl.slice(komma + 1)),
            (c) => c.charCodeAt(0),
          );
        } catch {
          laatsteStatus = status;
          laatsteFout = "base64 niet decodeerbaar";
          console.warn(`[beeld:${opties.label}] ${laatsteFout}`);
          continue;
        }

        if (bytes.length > maxBytes) {
          laatsteStatus = 413;
          laatsteFout = `beeld te groot (${bytes.length} bytes)`;
          console.warn(`[beeld:${opties.label}] ${laatsteFout}`);
          continue;
        }

        await roep(opties.bijSucces, {
          label: opties.label,
          provider,
          model,
          duurMs,
          status,
          usage: data?.usage,
          lengte: bytes.length,
        });
        return { bytes, mimeType, provider, model, usage: data?.usage };
      } catch (e) {
        // Regel 2 en 3 dragen hun eigen fout: die zijn definitief.
        if (e instanceof AiQuotumFout || e instanceof BeeldGeweigerd) throw e;

        laatsteFout = `${provider}: ${foutTekst(e)}`;
        console.warn(`[beeld:${opties.label}] ${laatsteFout}`);
        await roep(opties.bijSucces, {
          label: opties.label,
          provider,
          model,
          duurMs: Date.now() - start,
          status,
          fout: laatsteFout,
        });
        // Regel 1: na een timeout of netwerkfout NIET herkansen. Het beeld kan
        // server-side al gerenderd en dus aangerekend zijn.
        throw new AiOnbeschikbaar(
          `Beeldgeneratie afgebroken bij ${provider}/${model}: ${laatsteFout}. ` +
            "Bewust GEEN herkansing: een gerenderd beeld is al aangerekend.",
          status,
        );
      }
    }
    if (opties.signal?.aborted) break;
  }

  throw new AiOnbeschikbaar(
    `No image provider available (sleutels: ${beschikbaar.join("+") || "geen"}${
      laatsteFout ? `; laatste fout: ${laatsteFout}` : ""
    })`,
    laatsteStatus,
  );
}
