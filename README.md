# @holie/tools

Twee kleine hulpmodules zonder dependencies, met een eigen ingang per onderdeel:
`@holie/tools/ai` (providerketen voor chat-completions) en `@holie/tools/talen`
(welke talen een site kent, aanbiedt en actief gebruikt).

## ai

Een kleine providerketen voor chat-completions, voor Deno en Supabase Edge
Functions.

Probeert providers in een vaste volgorde en valt door naar de volgende bij een
fout, een lege of afgekapte inhoud, of een antwoord dat je zelf afkeurt.
Ondersteunt de Lovable AI-gateway en DeepSeek, allebei OpenAI-compatibel. Geen
dependencies.

```ts
import { callAi } from "jsr:@holie/tools@0.1/ai";

const { content, provider } = await callAi(
  [
    { role: "system", content: "Antwoord in één zin." },
    { role: "user", content: "Wat is een edge function?" },
  ],
  { label: "voorbeeld", volgorde: ["deepseek", "lovable"], maxTokens: 300 },
);
```

De sleutels komen uit `LOVABLE_API_KEY` en `DEEPSEEK_API_KEY`, of uit de optie
`sleutels`. Een provider zonder sleutel wordt overgeslagen.

## ⚠️ DeepSeek V4 denkt standaard na

`deepseek-v4-flash` redeneert standaard eerst (effort "high"). Die
redeneertokens tellen mee in `max_tokens` en worden als output aangerekend. Met
een krappe limiet breekt het antwoord af (`finish_reason: "length"`) of blijft
het leeg. In een test met `max_tokens: 4000` gingen 3602 tokens naar redeneren
en brak een JSON-antwoord halverwege af.

Deze keten stuurt daarom altijd `thinking: { type: "disabled" }` mee. Wil je het
denkwerk wel, zet dan `deepseekDenken: true`.

## Gedrag

- Een **afgekapt antwoord** gaat naar de volgende provider. Is er geen volgende,
  dan komt het toch terug, met `finishReason: "length"`.
- Een **herkansing** (`pogingen`) volgt enkel op lege inhoud, een 5xx of
  een 429. Een andere 4xx (ongeldige sleutel, te groot verzoek) is permanent.
- Een **afgekeurd antwoord** (`aanvaard` geeft `false`) wordt niet herhaald: de
  volgende provider komt aan de beurt.
- Met **`beeld`** krijgt DeepSeek het vision-model. Zit het beeld in een
  system-bericht, dan wordt DeepSeek overgeslagen: die weigert dat met een 400.
- Faalt alles, dan volgt een `AiOnbeschikbaar` met de beschikbare sleutels en de
  laatste fout.

## Opties

| optie                  | standaard                       | betekenis                                                                  |
| ---------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `label`                | (verplicht)                     | naam in de logregels                                                       |
| `volgorde`             | `["lovable", "deepseek"]`       | providers in volgorde                                                      |
| `maxTokens`            | `1000`                          |                                                                            |
| `temperature`          | `0.2`                           |                                                                            |
| `lovableModel`         | `google/gemini-3-flash-preview` |                                                                            |
| `deepseekModel`        | `deepseek-v4-flash`             | met `beeld`: `deepseek-v4-flash-vision-exp`                                |
| `deepseekDenken`       | `false`                         | DeepSeek laten redeneren                                                   |
| `beeld`                | `false`                         | de berichten bevatten een beeld                                            |
| `pogingen`             | `1`                             | pogingen per provider                                                      |
| `timeoutMs`            | geen                            | per poging                                                                 |
| `signal`               | geen                            | extern afbreken, bv. een deadline                                          |
| `tools`, `toolChoice`  | geen                            | function calling                                                           |
| `toolsVoor`            | alle providers                  | naar welke providers de tools gaan                                         |
| `opQuotum`             | `"doorvallen"`                  | `"throw"`: stop bij een 402/429 van Lovable met een `AiQuotumFout`         |
| `aanvaard`             | geen                            | `(content, provider) => boolean`                                           |
| `sleutels`             | omgeving                        | `{ lovable?, deepseek? }`                                                  |
| `bijSucces`, `bijFout` | geen                            | hooks per poging, bv. om verbruik te loggen; een fout erin wordt genegeerd |

Het antwoord:
`{ content, toolCall?, toolCalls?, provider, model, finishReason?, usage? }`.

## talen

```ts
import { doelTalen, normaliseerInstelling } from "jsr:@holie/tools@0.1/talen";
```

Pure logica zonder imports: een catalogus van talen, welke daarvan beschikbaar
zijn (oude links blijven werken) en welke actief zijn (wat de bezoeker ziet en
waarnaar vertaald wordt). Elke site kiest zijn eigen actieve talen.

## mcp-bundel

⚠️ **Bouwtijd-module**, voor Node of Deno tijdens build, pre-commit-hook en CI.
Nooit in een edge function importeren. Gebruikt enkel `node:`-modules; esbuild
en `@lovable.dev/mcp-js` komen uit de `node_modules` van het project zelf, zodat
de bundel byte-gelijk blijft aan wat de Lovable-plugin bouwt. Wie enkel `./ai`
of `./talen` importeert, haalt hier niets van binnen.

Voor Lovable-projecten op Supabase met een MCP-server in `src/lib/mcp/`. De
functie `supabase/functions/mcp/index.ts` is daaruit **gegenereerd**. Handwerk
in de bundel wordt bij de volgende build gewist, op Windows bouwde de plugin
stil een stub, en zonder banner veroudert de bundel ongemerkt.

```js
// scripts/bundle-mcp.mjs
import { bouwMcpBundel, controleerMcpBundel } from "@holie/tools/mcp-bundel";
const root = new URL("..", import.meta.url).pathname;
if (process.argv.includes("--check")) {
  const { inOrde, fouten } = await controleerMcpBundel(root);
  for (const f of fouten) console.error(`- ${f}`);
  process.exit(inOrde ? 0 : 1);
}
await bouwMcpBundel(root);
```

- `bouwMcpBundel(root, { schrijf? })`: bouwt zoals de plugin, schrijft enkel bij
  een verschil.
- `controleerMcpBundel(root)`: `{ inOrde, fouten }`, zonder te schrijven of te
  exiten. Controleert de banner, of elke toolnaam uit de bron in de bundel zit,
  en gelijkheid met een verse build (CRLF en `// @ts-nocheck` genormaliseerd).
- `mcpBundelHerstelPlugin({ root })`: Vite-plugin, ná `mcpPlugin()` zetten.
- Pre-commit-hook: `.githooks/pre-commit` roept `--check` aan, en
  `"prepare": "git config core.hooksPath .githooks 2>/dev/null || true"` in
  `package.json` zet hem bij elke install aan, zonder handwerk per clone.

## Ontwikkelen

```bash
deno test
deno lint
```
