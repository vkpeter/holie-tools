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
} as const;

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
  /** Omschrijving van wat er misliep; leeg bij succes. */
  fout?: string;
}

export interface AiOpties {
  /** Naam in de logregels. */
  label: string;
  maxTokens?: number;
  temperature?: number;
  /** Standaard `["lovable", "deepseek"]`. */
  volgorde?: AiProvider[];
  lovableModel?: string;
  /** Standaard `deepseek-v4-flash`, met `beeld` het vision-model. */
  deepseekModel?: string;
  /** Laat DeepSeek wél nadenken. Standaard uit, zie de modulekop. */
  deepseekDenken?: boolean;
  /** De berichten bevatten een beeld. */
  beeld?: boolean;
  /** Pogingen per provider, standaard 1. Een herkansing volgt enkel op lege inhoud, 5xx of 429. */
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
  /** Keurt een antwoord af: dan komt de volgende provider aan de beurt, zonder herhaling. */
  aanvaard?: (content: string, provider: string) => boolean;
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
  maxTokens: number;
  temperature: number;
  denken?: boolean;
}): Record<string, unknown> {
  return {
    model: opties.model,
    messages: opties.messages,
    max_tokens: opties.maxTokens,
    temperature: opties.temperature,
    thinking: { type: opties.denken ? "enabled" : "disabled" },
  };
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
      `[ai:${poging.label}] hook faalde: ${
        e instanceof Error ? e.message : String(e)
      }`,
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
    maxTokens = 1000,
    temperature = 0.2,
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
      : { model, messages, max_tokens: maxTokens, temperature };
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
            break;
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
          afgebroken
            ? "afgebroken (timeout of deadline)"
            : err instanceof Error
            ? err.message
            : String(err)
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
