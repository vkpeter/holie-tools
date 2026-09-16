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

## Nieuw in 0.4.0 (ai): audio kiest zijn model, met terugval

`STANDAARD_MODELLEN.lovableAudio` is nu een **lijst** in volgorde van voorkeur,
en `transcribeerAudio` loopt die af. Er is maar een provider die audio kan, dus
de keten loopt hier over **modellen** bij dezelfde gateway in plaats van over
providers.

```
gemini-2.5-flash-lite   $0,30/M audio-in  (uit $0,40)   standaard
gemini-3.1-flash-lite   $0,50/M audio-in  (uit $1,50)   terugval
```

- **De prijs zit op de audio-modaliteit, niet op tekst.** Vraag
  `GET https://ai.gateway.lovable.dev/v1/models` op en lees
  `pricing.input.audio`. Gemeten 16-09-2026 kostten `gemini-2.5-flash` en
  `gemini-3-flash-preview` allebei **$1,00/M** audio-input terwijl hun
  tekst-tarieven 40% verschilden: een keuze op de tekstprijs zegt hier dus
  niets.
- **Waarom een terugval:** `2.5-flash-lite` is het goedkoopst maar **deprecated,
  en verloopt op 28-01-2027**. Valt het weg met een 4xx, dan schuift de keten
  door naar het volgende model in plaats van de hele spraakweg plat te leggen.
  Een 5xx, 429 of leeg antwoord wordt eerst herkanst bij hetzelfde model.
- `model` aanvaardt nog steeds een enkele string; dat pad verandert niet.

⚠️ **Breaking:** wie `STANDAARD_MODELLEN.lovableAudio` als string gebruikte,
leest nu een array. Neem `[0]` voor het voorkeursmodel.

## Nieuw in 0.5.0 (ai): beeldgeneratie

`genereerBeeld(opties)` maakt een beeld en geeft de bytes terug. Net als
`transcribeerAudio` staat het naast `callAi` en niet erin: DeepSeek genereert
geen beelden, dus de keten loopt hier over **modellen** bij dezelfde provider in
plaats van over providers.

```ts
import { genereerBeeld } from "jsr:@holie/tools@^0.5/ai";

const { bytes, mimeType, model } = await genereerBeeld({
  label: "telegram-webhook",
  prompt: "A wide landscape photo of a duck on a canal, no text",
});
```

Drie regels zitten erin ingebakken. Ze komen uit Eendjes `article-image.ts`,
waar ze allemaal een keer geld of een stille storing gekost hebben:

- **Nooit opnieuw proberen na een timeout of netwerkfout.** Een beeld dat
  server-side al gerenderd is, is al aangerekend, ook als het antwoord jou nooit
  bereikt. Een herkansing betekent dus twee keer betalen. Bij een
  HTTP-*foutstatus* ligt dat anders: dan is er niets gerenderd en niets
  aangerekend, en mag het volgende model wel.
- **402 en 403 vallen niet door naar het volgende model.** Die gaan over de
  rekening (prepaid potje leeg, of de creditlimiet van de workspace), niet over
  het model. Er komt een `AiQuotumFout` uit, zodat de aanroeper het verschil ziet
  tussen "geen krediet" en "model stuk".
- **Tekst in plaats van een beeld is een weigering, geen storing.** Dat doet het
  model wanneer het de prompt afwijst, en die poging is aangerekend. Je krijgt
  een `BeeldGeweigerd` met de tekst erin, zodat je hem kan loggen.

⚠️ **Vergelijk beeldmodellen op `pricing.output.image`**, niet op
`pricing.input.text`: beeld wordt apart aangerekend en niet als tekst. Bij een
artikelbeeld domineert de beelduitvoer de kost volledig. De tarieven staan met
meetdatum in het commentaar bij `STANDAARD_MODELLEN.lovableBeeld`.

⚠️ **Houd de terugval even duur als het eerste model.** Springt hij in omdat het
eerste model wegvalt, dan mag dat de kost niet verdubbelen: dat is precies het
moment waarop niemand naar de factuur kijkt.

⚠️ **Het antwoordformaat is dat van de Gemini-modellen** op de Lovable-gateway
(`choices[0].message.images[0].image_url.url`). Zet je er een model van een
andere leverancier in, toets dan eerst of die veldnamen kloppen. Een terugval die
stil breekt op het moment dat hij moet inspringen, is erger dan geen terugval.

## Nieuw in 0.3.0 (ai): spraak naar tekst

`transcribeerAudio(opties)` zet spraak om naar tekst. Het staat naast `callAi`,
niet erin: die keten spreekt providers aan die audio niet kennen, en DeepSeek is
er daar een van.

```ts
import { transcribeerAudio } from "jsr:@holie/tools@^0.3/ai";

const { tekst, provider } = await transcribeerAudio({
  label: "transcribe-and-analyze",
  base64: audioBase64, // zonder `data:`-voorvoegsel
  formaat: "wav", // uit AUDIO_FORMATEN
  taal: "nl",
});
```

- **De providerkeuze staat op een plek**: `AUDIO_PROVIDERS` (vandaag enkel
  `["lovable"]`) en `STANDAARD_MODELLEN.lovableAudio`. Wie het model of de
  provider voor alle spraak wil wijzigen, wijzigt die twee, niet elke aanroeper.
  De lijst is met opzet een array, zodat een tweede audioprovider erbij kan
  zonder dat een aanroeper verandert.
- **Een formaat dat het model niet kan lezen loopt hier stuk**, met een
  `TypeError`, voor er een verzoek uitgaat. ⚠️ Dat is geen vormelijkheid: de
  gateway weigert `webm` of `mp4` **niet** netjes, ze verzint dan een plausibel
  klinkende transcriptie. Een verzonnen boodschappenlijstje dat als echt
  doorgaat is erger dan een harde fout. Aanvaard worden `wav`, `mp3`, `ogg`,
  `flac`, `aac` en `aiff` (`AUDIO_FORMATEN`); herverpak in de browser naar 16
  kHz mono WAV.
- **Zonder `systeem` en `opdracht`** vraagt het om een letterlijke transcriptie
  die niets aanvult wat er niet gezegd is, met `NIETS_VERSTAAN` als er geen
  verstaanbare spraak is.
- Verder dezelfde vorm als `callAi`: `pogingen`, `timeoutMs`, `signal`,
  `sleutels`, `bijSucces`, en een `AiOnbeschikbaar` met de beschikbare sleutels
  en de laatste fout als alles faalt.

## Nieuw in 0.2.0 (ai)

- **`maxTokens` en `temperature` gaan enkel mee als je ze opgeeft.** Tot 0.1.1
  stuurde de keten altijd 1000 en 0,2 mee. Wil je het oude gedrag, geef ze dan
  expliciet op.
- **`responseFormat`** gaat mee als `response_format`, bv.
  `{ type: "json_object" }`.
- **Herkansing bij een netwerkfout** (DNS, connection reset) binnen `pogingen`,
  net als bij een 5xx. Een timeout of een extern afbreken krijgt geen
  herkansing.
- **`herkansBijAfkeuring`**: een antwoord dat `aanvaard` afkeurt, eerst opnieuw
  vragen bij dezelfde provider in plaats van meteen door te vallen.
- **`lengte`** in `AiPoging`: het aantal tekens van de ontvangen inhoud, voor de
  hooks.
- **`foutTekst(err)`** is geexporteerd. Het maakt van elke gegooide waarde een
  leesbare tekst: een PostgREST-fout wordt `message | code | details | hint` in
  plaats van `[object Object]`. Van een onbekend object komt enkel de soort mee,
  nooit de inhoud.

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
import { fileURLToPath } from "node:url";
import { bouwMcpBundel, controleerMcpBundel } from "@holie/tools/mcp-bundel";
const root = fileURLToPath(new URL("..", import.meta.url));
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

> ⚠️ `aliasesUitTsconfig` leest enkel `tsconfig.json`, niet de bestanden waar
> die via `references` naar verwijst (`tsconfig.app.json` en dergelijke). Staan
> je `paths` enkel daar, zet ze dan ook in `tsconfig.json` of geef de aliassen
> mee via de Vite-config.

**0.2.0:** `TaalInstelling<T extends string = string>` aanvaardt een letterlijke
union (`TaalInstelling<Lang>`), zodat een project niet hoeft te casten.
`mcpBundelHerstelPlugin` kreeg `faalHard` (standaard `true`); met `false` logt
een mislukte herbouw enkel en loopt de Vite-build door.

## telegram

Berichten versturen via de Telegram Bot API en een webhook controleren. Enkel
`fetch` en Web Crypto, dus het werkt in Supabase edge functions en in een
Cloudflare Worker.

```ts
import {
  controleerWebhookGeheim,
  escapeHtml,
  stuurTelegramBericht,
} from "jsr:@holie/tools/telegram";

// Het project leest zelf zijn token en chat-id; het pakket kent er geen.
const token = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const r = await stuurTelegramBericht(
  token,
  chatId,
  `<b>${escapeHtml(titel)}</b>`,
);
if (!r.ok) console.warn("telegram:", r.fout); // zonder token

// In de webhook:
if (!controleerWebhookGeheim(req, Deno.env.get("TELEGRAM_WEBHOOK_SECRET"))) {
  return new Response("Unauthorized", { status: 401 });
}
```

- `stuurTelegramBericht` gooit nooit, standaard `parse_mode: "HTML"` zonder
  linkvoorbeeld, knipt boven 4096 tekens op regeleinden, en geeft na een 429 met
  een korte `retry_after` één herkansing.
- `stuurNaarChats` stuurt naar meerdere chats en telt de bereikte.
- `controleerWebhookGeheim` weigert altijd als er geen verwacht geheim is.
- `leidWebhookGeheimAf(token)` geeft een geheim afgeleid van het token (SHA-256,
  base64url), gelijk aan wat Eagle-Eye Scissors al gebruikt.

**Privacy en sleutels.** De module leest geen omgevingsvariabelen, bevat geen
tokens, chat-id's of ontvangers en logt niets. Het token staat in de URL van de
Bot API, en Deno zet die URL in een fetch-foutmelding: `fout` is daarom altijd
ontdaan van het token. Wat projectspecifiek is (welke beheerders, welke tabel,
de logica van een bot) blijft in het project.

## Ontwikkelen

```bash
deno test
deno lint
```
