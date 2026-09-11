# ai-keten

Een kleine providerketen voor chat-completions, voor Deno en Supabase Edge Functions.

Probeert providers in een vaste volgorde en valt door naar de volgende bij een fout, een lege
of afgekapte inhoud, of een antwoord dat je zelf afkeurt. Ondersteunt de Lovable AI-gateway en
DeepSeek, allebei OpenAI-compatibel. Geen dependencies.

```ts
import { callAi } from "jsr:@holie/ai-keten@0.1";

const { content, provider } = await callAi(
  [
    { role: "system", content: "Antwoord in één zin." },
    { role: "user", content: "Wat is een edge function?" },
  ],
  { label: "voorbeeld", volgorde: ["deepseek", "lovable"], maxTokens: 300 },
);
```

De sleutels komen uit `LOVABLE_API_KEY` en `DEEPSEEK_API_KEY`, of uit de optie `sleutels`.
Een provider zonder sleutel wordt overgeslagen.

## ⚠️ DeepSeek V4 denkt standaard na

`deepseek-v4-flash` redeneert standaard eerst (effort "high"). Die redeneertokens tellen mee in
`max_tokens` en worden als output aangerekend. Met een krappe limiet breekt het antwoord af
(`finish_reason: "length"`) of blijft het leeg. In een test met `max_tokens: 4000` gingen 3602
tokens naar redeneren en brak een JSON-antwoord halverwege af.

Deze keten stuurt daarom altijd `thinking: { type: "disabled" }` mee. Wil je het denkwerk wel,
zet dan `deepseekDenken: true`.

## Gedrag

- Een **afgekapt antwoord** gaat naar de volgende provider. Is er geen volgende, dan komt het
  toch terug, met `finishReason: "length"`.
- Een **herkansing** (`pogingen`) volgt enkel op lege inhoud, een 5xx of een 429. Een andere 4xx
  (ongeldige sleutel, te groot verzoek) is permanent.
- Een **afgekeurd antwoord** (`aanvaard` geeft `false`) wordt niet herhaald: de volgende provider
  komt aan de beurt.
- Met **`beeld`** krijgt DeepSeek het vision-model. Zit het beeld in een system-bericht, dan
  wordt DeepSeek overgeslagen: die weigert dat met een 400.
- Faalt alles, dan volgt een `AiOnbeschikbaar` met de beschikbare sleutels en de laatste fout.

## Opties

| optie | standaard | betekenis |
|---|---|---|
| `label` | (verplicht) | naam in de logregels |
| `volgorde` | `["lovable", "deepseek"]` | providers in volgorde |
| `maxTokens` | `1000` | |
| `temperature` | `0.2` | |
| `lovableModel` | `google/gemini-3-flash-preview` | |
| `deepseekModel` | `deepseek-v4-flash` | met `beeld`: `deepseek-v4-flash-vision-exp` |
| `deepseekDenken` | `false` | DeepSeek laten redeneren |
| `beeld` | `false` | de berichten bevatten een beeld |
| `pogingen` | `1` | pogingen per provider |
| `timeoutMs` | geen | per poging |
| `signal` | geen | extern afbreken, bv. een deadline |
| `tools`, `toolChoice` | geen | function calling |
| `toolsVoor` | alle providers | naar welke providers de tools gaan |
| `opQuotum` | `"doorvallen"` | `"throw"`: stop bij een 402/429 van Lovable met een `AiQuotumFout` |
| `aanvaard` | geen | `(content, provider) => boolean` |
| `sleutels` | omgeving | `{ lovable?, deepseek? }` |
| `bijSucces`, `bijFout` | geen | hooks per poging, bv. om verbruik te loggen; een fout erin wordt genegeerd |

Het antwoord: `{ content, toolCall?, toolCalls?, provider, model, finishReason?, usage? }`.

## Ontwikkelen

```bash
deno test
deno lint
```
