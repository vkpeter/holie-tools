# @holie/tools

Twee kleine hulpmodules zonder dependencies, met een eigen ingang per onderdeel:
`@holie/tools/ai` (providerketen voor chat-completions) en `@holie/tools/talen`
(welke talen een site kent, aanbiedt en actief gebruikt).

Sinds 0.18.0 ook `./formulier` en `./codes`: zie
[de lat N1-N7/T1-T7](#nieuw-in-0180-formulieren-en-bots-de-lat-n1-n7t1-t7).

## ai

Een kleine providerketen voor chat-completions, voor Deno en Supabase Edge
Functions.

Probeert providers in een vaste volgorde en valt door naar de volgende bij een
fout, een lege of afgekapte inhoud, of een antwoord dat je zelf afkeurt.
Ondersteunt Google's gratis Gemini-API, de Lovable AI-gateway en DeepSeek, alle
drie OpenAI-compatibel. Geen dependencies.

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

De sleutels komen uit `GEMINI_API_KEY`, `LOVABLE_API_KEY` en `DEEPSEEK_API_KEY`,
of uit de optie `sleutels`. Een provider zonder sleutel wordt overgeslagen.

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

| optie                  | standaard                                        | betekenis                                                                  |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| `label`                | (verplicht)                                      | naam in de logregels                                                       |
| `volgorde`             | `["anthropic", "deepseek", "gemini", "lovable"]` | providers in volgorde                                                      |
| `maxTokens`            | `1000`                                           |                                                                            |
| `temperature`          | `0.2`                                            |                                                                            |
| `lovableModel`         | `google/gemini-3-flash-preview`                  |                                                                            |
| `anthropicModel`       | `claude-haiku-5-5`                               | Claude op de Messages API, zonder `temperature`                            |
| `deepseekModel`        | `deepseek-v4-flash`                              | met `beeld`: `deepseek-v4-flash-vision-exp`                                |
| `deepseekDenken`       | `false`                                          | DeepSeek laten redeneren                                                   |
| `beeld`                | `false`                                          | de berichten bevatten een beeld                                            |
| `pogingen`             | `1`                                              | pogingen per provider                                                      |
| `timeoutMs`            | geen                                             | per poging                                                                 |
| `signal`               | geen                                             | extern afbreken, bv. een deadline                                          |
| `tools`, `toolChoice`  | geen                                             | function calling                                                           |
| `toolsVoor`            | alle providers                                   | naar welke providers de tools gaan                                         |
| `opQuotum`             | `"doorvallen"`                                   | `"throw"`: stop bij een 402/429 van Lovable met een `AiQuotumFout`         |
| `aanvaard`             | geen                                             | `(content, provider) => boolean`                                           |
| `sleutels`             | omgeving                                         | `{ gemini?, lovable?, deepseek?, anthropic? }`                             |
| `bijSucces`, `bijFout` | geen                                             | hooks per poging, bv. om verbruik te loggen; een fout erin wordt genegeerd |

Het antwoord:
`{ content, toolCall?, toolCalls?, provider, model, finishReason?, usage? }`.

## Nieuw in 0.12.0 (ai): ook tekst pakt de gratis route mee

`callAi` staat standaard op **`["deepseek", "gemini", "lovable"]`**. DeepSeek is
spotgoedkoop en heeft geen dagplafond, dus die blijft vooraan; de gratis
Gemini-API pakt op wat DeepSeek laat vallen, en Lovable is het laatste vangnet.

⚠️ **Gedragswijziging** voor aanroepers die geen `volgorde` meegeven: die kregen
eerst Lovable. Wie een vaste provider wil, geeft `volgorde` expliciet mee.

Gemeten 19-09-2026 op `gemini-3.5-flash-lite`, echte calls:

| veld                           | uitkomst                    |
| ------------------------------ | --------------------------- |
| gewone tekst                   | HTTP 200                    |
| `response_format: json_object` | HTTP 200, geldige JSON      |
| tools / function calling       | HTTP 200, `tool_call` terug |
| `thinking: {type:"disabled"}`  | **HTTP 400** "Unknown name" |

☠️ Dat laatste veld is DeepSeek-specifiek en mag nooit naar Google. Het zit
daarom in `bouwDeepseekBody` en niet in de gedeelde body; een test bewaakt die
scheiding. Breekt iemand ze open, dan faalt elke tekst-call op de gratis route
met een 400 - en dat is een 4xx, dus de keten herkanst niet eens.

Een 429 van de gratis route wordt **niet** herkanst: een leeg dagquotum is
morgen pas over, dus de keten valt meteen door.

## Nieuw in 0.19.0 (ai): Claude staat vooraan

`callAi` staat standaard op **`["anthropic", "deepseek", "gemini", "lovable"]`**
(`TEKST_PROVIDERS`). Peter, 28-10-2026: Claude vooraan in elke flow waar hij
iets kan betekenen. Dat geldt voor tekst, vertalen, samenvatten, classificeren,
gestructureerde uitvoer (tools/JSON) en beeldanalyse; niet voor spraak
(`AUDIO_PROVIDERS`) en niet voor beeldgeneratie (`BEELD_PROVIDERS`), want Claude
kan die niet.

⚠️ **Bump vereist.** `^0.18` sluit 0.19 uit: zet de import op
`@holie/tools@^0.19`.

- ⚠️ **Gedragswijziging** voor aanroepers zonder eigen `volgorde`: die kregen
  eerst DeepSeek, nu eerst Claude (betalend, `claude-haiku-5-5`). Zonder
  `ANTHROPIC_API_KEY` wordt de schakel overgeslagen en verandert er niets.
- Wie een vaste volgorde wil, geeft `volgorde` expliciet mee.
- `toolsVoor` blijft een filter (standaard alle providers), geen volgorde.

## Nieuw in 0.18.0: formulieren en bots, de lat N1-N7/T1-T7

Op 27-28 okt 2026 trok Peter de nieuwsbrieven, formulieren en Telegram-bots van
zeven sites op dezelfde lat: holie, Eendje, Phyllox, Eagle-Eye, Billara, Foodie
en ESE. Elke site bouwde de stukken apart. Hier staat per stuk de sterkste
versie, in twee nieuwe ingangen (`./formulier`, `./codes`) en een uitbreiding
van `./telegram`.

⚠️ **Bump vereist.** `^0.17` sluit 0.18 uit: zet de import op
`@holie/tools@^0.18`.

### Formulieren en bots: de lat N1-N7/T1-T7

| regel | wat                                                               | helper                                                   |
| ----- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| N1    | anon en authenticated schrijven niet in formuliertabellen         | (SQL per site: policies weg, `revoke`)                   |
| N2    | dubbele opt-in: bevestigen via een eenmalige code, enkel hash     | `maakCode`, `hashCode`                                   |
| N3    | atomaire limiet per IP en per adres, dicht vallen                 | `klantIp`, `limietHit`, `RATE_LIMIT_HIT_SQL`             |
| N4    | geen lidmaatschapsorakel: zelfde antwoord, zelfde duur            | `metVasteDuur`                                           |
| N5    | lengte vóór de regex, lineaire regex, dan lower/trim              | `normaliseerEmail`, `isGeldigEmail`                      |
| N6    | uitschrijfcode per lijst en adres, vaste lengte                   | `maakUitschrijfcode`, `controleerUitschrijfcode`         |
| N7    | bevestigingsmail zonder vrije invoer (geen naam, geen kopie)      | (tekst per site), `escapeHtml` als er toch iets in moet  |
| T1    | webhook enkel met het geheim                                      | `controleerWebhookGeheim`, `leidWebhookGeheimAf`         |
| T2    | koppelen met een eenmalige code, kort geldig, enkel de hash       | `maakKorteCode`, `leesKorteCode`, `startParameter`       |
| T3    | enkel privéchat, rechten op `from.id === chat.id`                 | `priveAfzender`, `isPriveAfzender`                       |
| T4    | ingrijpende actie pas na een bevestigknop                         | `maakBevestigKnop`, `leesBevestigKnop`                   |
| T5    | een doorgestuurd bericht is nooit een commando                    | `isDoorgestuurd`                                         |
| T6    | escapen: HTML met `escapeHtml`                                    | `escapeHtml`, (`escapeMarkdownV2`)                       |
| T7    | een knop telt enkel als hij aangeboden was, van de juiste klikker | `knopWasAangeboden`, `priveAfzender`, `leesBevestigKnop` |

### `./formulier`

```ts
import {
  klantIp,
  limietHit,
  metVasteDuur,
  normaliseerEmail,
} from "jsr:@holie/tools@^0.18/formulier";

// N3: IP-limiet vóór de body. Zonder cf-connecting-ip: dicht.
const ip = klantIp(req, { ipv6Per64: true });
if (!ip) return new Response("Niet beschikbaar", { status: 503 });
if (
  !await limietHit(admin, {
    sleutel: ip,
    eindpunt: "nieuwsbrief:ip",
    max: 10,
    vensterMinuten: 60,
  })
) return new Response("Te veel aanvragen", { status: 429 });

// N5: lengte, regex, lower.
const email = normaliseerEmail(body.email);
if (!email) return new Response("Ongeldig e-mailadres", { status: 400 });

// N4: elk geldig adres krijgt hetzelfde antwoord na minstens 3,5 s.
return await metVasteDuur(3500, async () => {
  if (
    await limietHit(admin, {
      sleutel: email,
      eindpunt: "nieuwsbrief:adres",
      max: 3,
      vensterMinuten: 24 * 60,
    })
  ) {
    // rij zetten; de mail pas na het antwoord, met EdgeRuntime.waitUntil
  }
  return Response.json({ status: "ok" });
});
```

- **`klantIp`** leest enkel `cf-connecting-ip`, nooit `X-Forwarded-For`: die zet
  de client zelf. Het resultaat is canoniek, IPv4 in IPv6-vorm wordt IPv4. Met
  `ipv6Per64` telt een IPv6-adres als zijn /64-blok, in dezelfde tekst als
  Postgres `network(set_masklen(ip, 64))` (Eendje). Zonder of met een ongeldige
  kop: `null`. Twee valkuilen: Cloudflare "Pseudo IPv4: Overwrite Headers" moet
  uit staan, en een Worker die zelf een Supabase-functie aanroept stuurt zijn
  eigen IP mee (tel dan in de Worker).
- **`limietHit`** valt dicht: databankfout, gooien, `data` die niet exact `true`
  is, een lege sleutel of ongeldige opties geven `false`. De sleutel gaat
  standaard als SHA-256 naar de databank. Dat is een pseudoniem: alle
  IPv4-adressen zijn na te rekenen. Met `peper` (eigen env-var, minstens 32
  tekens) wordt het een HMAC. `versluier: false` bewaart de sleutel leesbaar.
- **`RATE_LIMIT_HIT_SQL`** (ook als `sql/rate_limit_hit.sql`) is de migratie
  erachter, letterlijk over te nemen. Tabel `rate_limit_hits` met de kolommen
  van Foodie (`sleutel`, `endpoint`): de naam `rate_limits` is in holie, ESE en
  Eagle-Eye al bezet met andere kolommen. Advisory lock per eindpunt en sleutel.
  Opkuis in de functie zelf: hoogstens 500 rijen ouder dan 25 uur per hit, met
  `skip locked`, dus geen pg_cron en geen wachtrij na een piek.
  `security
  definer` met lege `search_path`, enkel `service_role`. Venster 1
  tot 1500 minuten.
- **`normaliseerEmail`**: eerst de lengte (≤ 254), dan `EMAIL_PATROON`, dan
  kleine letters. Het patroon is dat van holie plus de uitsluitingen van Eendje
  (`<>"(),;:\[]`), zonder stuurtekens en onzichtbare tekens (zero-width space),
  zonder dubbele punt in het lokale deel en met een domein in ASCII (punycode).
  Lineair: 20.000 punten zijn in milliseconden afgewezen. De apostrof en
  accenten in het lokale deel mogen (`o'neil@...`, `josé@...`).
- **`metVasteDuur`** helpt enkel als het werk binnen de minimumduur blijft:
  verstuur een mail na het antwoord, niet erbinnen.

### `./codes`

```ts
import {
  controleerUitschrijfcode,
  hashCode,
  maakCode,
  maakKorteCode,
  maakUitschrijfcode,
} from "jsr:@holie/tools@^0.18/codes";

// N2: de code gaat in de link, enkel de hash in de databank.
const { code, hash } = await maakCode(); // 43 tekens, 256 bits
// bij de klik: .eq("confirm_token_hash", await hashCode(code))

// T2: korte koppelcode, met peper (40 bits zijn anders offline na te rekenen).
const peper = Deno.env.get("CODE_PEPER")!; // minstens 32 tekens
const kort = await maakKorteCode({ peper }); // bij /start: hashCode(leesKorteCode(x)!, peper)

// N6: geen opslag nodig, de lijst zit in de code.
const geheim = Deno.env.get("UNSUBSCRIBE_SECRET")!; // minstens 32 tekens
const uit = await maakUitschrijfcode(geheim, "nieuwsbrief", email);
const ok = await controleerUitschrijfcode(geheim, "nieuwsbrief", email, invoer);
```

- Een uitschrijfcode is altijd 43 tekens (HMAC-SHA256 als base64url, over
  `lijst:adres` met het adres in kleine letters). Een afgeknipte, verlengde of
  andere code faalt vóór de vergelijking, die in constante tijd loopt. Een link
  van de lijst `herinneringen` schrijft niemand uit voor `nieuwsbrief` (Foodie).
  Gebruik er een eigen geheim voor, niet dat van de bevestigknop.
- `maakKorteCode` geeft 8 tekens zonder 0/O/1/I om over te typen (Telegram-
  koppelcode van Eagle-Eye, 40 bits). Enkel veilig met een korte geldigheid,
  eenmalig gebruik (`delete ... returning`), `limietHit` op de pogingen en een
  `peper`: de pogingslimiet geldt niet voor wie de tabel leest.

### `./telegram`: poort en bevestigknop

```ts
import {
  isDoorgestuurd,
  knopWasAangeboden,
  leesBevestigKnop,
  maakBevestigKnop,
  priveAfzender,
} from "jsr:@holie/tools@^0.18/telegram";

const van = priveAfzender(update); // T3: null in een groep of van een ander
if (van === null) return new Response("ok"); // stil negeren

// T4: eerst vragen, met een knop die na 10 minuten vervalt.
const ja = await maakBevestigKnop({
  actie: "wis_ja",
  id: artikel.id,
  chatId: van,
  geheim,
});

// T7: bij de klik.
const cq = update.callback_query;
if (cq && knopWasAangeboden(cq)) {
  const knop = await leesBevestigKnop(cq.data, { geheim, chatId: van });
  if (knop.ok && knop.actie === "wis_ja") {
    // atomisch claimen: update ... where status = 'open' returning
  }
}
```

- **`priveAfzender(update)`** eist `chat.type === "private"`, een mens als
  afzender en `from.id === chat.id`, voor `message`, `edited_message` en
  `callback_query`. Een klik op een inline-bericht zonder chat telt niet.
- **`maakBevestigKnop`** maakt `actie:id:vervaltijd:handtekening`. De HMAC (48
  bits) bindt actie, id, vervaltijd en chat: geen verzonnen knop, geen verlengde
  knop, geen knop uit een andere chat. Billara bewaarde de vervaltijd in een
  tabel, Eendje en Foodie hadden er geen. Geldig 10 minuten, hoogstens 7 dagen.
  Past altijd in 64 bytes of gooit: met een uuid als id mag de actie 10 tekens
  zijn. Het geheim is een eigen env-var of
  `leidWebhookGeheimAf(token, "telegram-knop")`.
- **`leesBevestigKnop`** controleert vorm, dan handtekening, dan vervaltijd, en
  geeft `{ ok: false, reden }` met `vorm`, `handtekening` of `verlopen`. De knop
  bewijst de bedoeling, niet het eenmalig gebruik: claim de actie atomisch.
- **`isDoorgestuurd`** kent `forward_origin` en de oude velden. Gekopieerde
  tekst herkent niemand, dus een delete vraagt altijd een knop.
- **`startParameter`** leest `/start <parameter>` (max 64, `A-Z a-z 0-9 _ -`).
- **`escapeMarkdownV2`** bestaat voor bots die al op MarkdownV2 draaien. Het
  advies blijft `parseMode: "HTML"` met `escapeHtml`: één vergeten teken in
  MarkdownV2 laat het hele bericht weigeren.

## Nieuw in 0.17.0: de hele Bot-API, `./ics` en `claimMetVenster`

Uit de panelreview van Roundbook (28-10-2026): drie stukken die in de webshop,
Billara en Roundbook elk apart gebouwd stonden.

⚠️ **Bump vereist.** Bij een 0.x-versie sluit `^0.16` de 0.17 uit. Wie iets van
hieronder wil, zet de import op `@holie/tools@^0.17`.

**telegram (H4, H8, H9).** Eén `telegramApi(token, methode, body)` voor elke
methode van de Bot API, met de dunne helpers die de webshop zelf schreef:

| helper                                                       | Bot API                  |
| ------------------------------------------------------------ | ------------------------ |
| `telegramApi(token, methode, body, opties?)`                 | elke methode             |
| `stuurTelegramBericht(..., { toetsenbord })`                 | `sendMessage` + keyboard |
| `bewerkTelegramBericht(token, chatId, messageId, tekst, o?)` | `editMessageText`        |
| `zetTelegramKnoppen(token, chatId, messageId, knoppen?)`     | `editMessageReplyMarkup` |
| `beantwoordKlik(token, callbackQueryId, { tekst?, alert? })` | `answerCallbackQuery`    |
| `zetWebhook(token, url, { geheim?, updates? })`              | `setWebhook`             |
| `controleerKnoppen(knoppen)`, `pastAlsCallbackData(data)`    | (vooraf toetsen)         |

- Alles gooit nooit, logt niets en houdt het token uit `fout`, zoals
  `stuurTelegramBericht` al deed. Na een 429 met korte `retry_after` volgt één
  herkansing, nu voor elke methode.
- **Knoppen worden vooraf getoetst.** `callback_data` mag 1 tot 64 **bytes**
  (UTF-8) zijn, niet tekens: 17 emoji is al te veel. Erboven weigert Telegram
  het hele bericht, tekst incluis. Nu geeft het `ok: false` zonder verzoek, met
  de knop in `fout` ("knop 2.1 ... 65 bytes"). Ook een knop zonder tekst, of met
  zowel `callback_data` als `url`, wordt geweigerd.
- **Vast toetsenbord**:
  `toetsenbord: { keyboard, is_persistent, resize_keyboard }` of
  `toetsenbord: "weg"`. Niet samen met `knoppen` (één `reply_markup`).
- **Bewerken haalt standaard de knoppen weg.** Wil je ze houden, geef ze opnieuw
  mee. "message is not modified" telt als gelukt, met `ongewijzigd: true`: dat
  is een dubbele klik, geen fout.
- ⚠️ `zetWebhook` zonder `updates` houdt de vorige instelling aan. Wie knopkliks
  wil, zet `callback_query` er expliciet in.

```ts
import {
  beantwoordKlik,
  bewerkTelegramBericht,
} from "jsr:@holie/tools@^0.17/telegram";

await beantwoordKlik(token, cq.id); // altijd, anders blijft de knop "laden"
const r = await bewerkTelegramBericht(
  token,
  cq.message.chat.id,
  cq.message.message_id,
  `${tekst}\n\n✅ Bevestigd door ${escapeHtml(naam)}`,
);
if (!r.ok) console.warn("telegram:", r.fout);
```

**ics (H6).** Nieuwe ingang `./ics`: een iCalendar-feed (RFC 5545) met een
generiek event-type. Zie de sectie ics.

**runslot (H7).** `claimMetVenster` en `geefClaimVrij`: een rem in de database,
eenmalig of met een venster. Zie de sectie runslot.

## Nieuw in 0.16.0: sleutels buiten Deno, `kiesTaal` en `./mail`

**ai.** `callAi`, `transcribeerAudio` en `genereerBeeld` lezen hun sleutels nu
eerst uit `Deno.env` en, als dat niets geeft, uit `process.env`. In een
Cloudflare Worker met `nodejs_compat` (ESE, Eagle-Eye) vinden ze de secrets dus
zelf. Vroeger gaf de `try/catch` rond `Deno.env` daar stil "geen sleutel", en
moest elk project een eigen `aiSleutels()` meegeven
(`src/lib/ai-sleutels.server.ts`). Die shim kan weg:

```ts
import { aiSleutels, callAi, heeftAiSleutel } from "@holie/tools/ai";

if (!heeftAiSleutel()) throw new Error("geen AI-sleutel");
await callAi(berichten, { label: "vertaal" }); // sleutels: niet meer nodig
```

- `aiSleutels()` geeft de sleutels uit de omgeving (lege waarden tellen niet).
- `heeftAiSleutel(sleutels?, providers?)` kijkt standaard naar de tekstketen
  (`TEKST_PROVIDERS`, zonder `meta`), net als de oude shim.
- Een meegegeven `sleutels` wint nog altijd van de omgeving.

**talen.** `kiesTaal` kiest de taal van een verzoek uit cookie, Accept-Language
(met q-gewichten) en standaard. Zie de sectie talen.

**mail.** Nieuwe ingang `@holie/tools/mail` met `sendMail` voor Resend. Zie de
sectie mail.

## Nieuw in 0.15.0 (ai): Claude Haiku 5.5 vóór Lovable

`callAi` stond hier op **`["deepseek", "gemini", "anthropic", "lovable"]`**
(sinds 0.19.0 staat Claude vooraan, zie hierboven). Claude Max geeft elke maand
USD 100 API-tegoed dat op het einde van de maand vervalt (gekoppeld 16-10-2026).
Wat DeepSeek en de gratis Gemini-route laten vallen, gaat dus eerst naar dat
tegoed en pas daarna naar de betalende Lovable-gateway.

- Sleutel: **`ANTHROPIC_API_KEY`** (of `sleutels.anthropic`). Zonder sleutel
  wordt de schakel overgeslagen en loopt alles zoals in 0.14.
- Model: `claude-haiku-5-5`, USD 0,10 in / 0,50 uit per M tokens tot 100.000
  tokens per verzoek. Effort staat op `low`: het is een vangnet.
- Anthropic spreekt geen OpenAI-vorm. `bouwAnthropicBody` vertaalt system-
  berichten, beelden, tools en toolgeschiedenis; het antwoord komt terug in de
  vertrouwde vorm (`content`, `toolCalls`, `usage.prompt_tokens`).
- ⛔ `temperature` gaat er nooit heen (400 op Haiku 5.5). Een afgedwongen tool
  wordt `auto` met een instructie, en `response_format: json_object` een
  instructie in `system`.
- Tegoed op geeft een 400: geen herkansing, de keten valt door naar Lovable.
- ⚠️ Projecten met een **eigen `volgorde`** (Eendje, Shintaka) krijgen Claude
  niet vanzelf: zet `"anthropic"` daar zelf vóór `"lovable"`.

## Nieuw in 0.14.0 (ai): beeld gaat eerst naar Meta's Muse Image

`genereerBeeld` loopt nu over twee providers: `BEELD_PROVIDERS` staat op
`["meta", "lovable"]`. Zet `META_MODEL_API_KEY` en het beeld komt van
`muse-image-1.0` op de Meta Model API; zonder die sleutel verandert er niets en
loopt alles over Lovable.

- **Waarom:** $0,01 per gelukt beeld tegen $0,0336 voor het goedkoopste
  Gemini-model op de gateway, en een hogere Elo op de ranglijst van Artificial
  Analysis (1115 tegen 1095). Afgelezen 07-10-2026.
- **Nieuwe optie `formaat`** ("BxH", bv. `"1792x1024"`): Meta volgt de
  verhouding. De Gemini-modellen negeren ze en krijgen het veld niet mee.
- **Regel 2 geldt per rekening:** een 402/403/429 bij Meta valt door naar
  Lovable; de `AiQuotumFout` komt er pas uit als geen provider meer overblijft.
- **Regel 1 blijft:** na een timeout of netwerkfout bij Meta komt er geen poging
  bij Lovable. Meta redeneert en zoekt voor het tekent, dus zet `timeoutMs` ruim
  genoeg.
- `schatUsd("muse-image-1.0")` geeft de vaste $0,01, niet een tokenbedrag.
- ⚠️ De terugval is nu 3,4x duurder dan het eerste model. Springt hij vaak in,
  dan zie je dat op de Lovable-credits.

## Nieuw in 0.11.0 (ai): spraak loopt gratis, beeld niet

`transcribeerAudio` gaat nu eerst naar **Google's eigen Gemini-API**, die spraak
gratis doet, en valt pas terug op de betalende Lovable-gateway.
`AUDIO_PROVIDERS` staat daarom op `["gemini", "lovable"]`. Zet `GEMINI_API_KEY`
en er verandert verder niets aan de aanroepers: Google's OpenAI-compatibele
endpoint neemt dezelfde `input_audio`-payload aan.

Gemeten 19-09-2026 met een echte opname van 3,3 s ("I ate two slices of bread
and three grapes"): HTTP 200 op de eerste poging, woordelijk correct, 300
tokens, EUR 0.

```
gemini-3.5-flash-lite   gratis   standaard
gemini-3.1-flash-lite   gratis   terugval
```

**Waarom dit ook voor gebruikersdata mag.** Google traint standaard wél mee op
gratis input, maar de voorwaarden maken een uitzondering: wie in de EEA,
Zwitserland of het VK zit, valt onder de Paid Services-voorwaarden, "even though
they are offered free of charge". Wij zitten in Belgie. ⚠️ Dat is een
regioregel, geen producteigenschap - draait dit ooit buiten de EEA, dan vervalt
ze stil.

⛔ **Beeldgeneratie kan dit niet.** Niet opnieuw uitzoeken: een echte call met
een verse sleutel zonder billing gaf meteen `429 RESOURCE_EXHAUSTED` op zowel
`gemini-3.1-flash-lite-image` als `gemini-2.5-flash-image`. Het gratis quotum
voor beeld is nul, niet krap. Verwar het niet met de AI Studio-playground, waar
beeld wél gratis is - dat is de webinterface, niet de API. `genereerBeeld`
blijft dus volledig op Lovable.

Twee valkuilen die geld of tijd kosten:

- **De modelnamen verschillen per route.** Google's API kent
  `gemini-3.5-flash-lite`, de gateway kent dat als
  `google/gemini-2.5-flash-lite`. Een naam overnemen van de ene naar de andere
  geeft een 404. Het model waar spraak vóór deze wijziging op draaide is op
  Google's eigen API zelfs volledig ingetrokken ("no longer available to new
  users").
- **Zonder sleutel faalt dit stil.** Een provider zonder sleutel wordt
  overgeslagen, niet gemeld: staat `GEMINI_API_KEY` nergens, dan loopt alles
  gewoon door op de betalende route zonder dat iemand het merkt. De logregel per
  poging (`bijSucces`) vermeldt de provider - dat is de plek waar je het ziet.

Quota gelden **per Google-project**, niet per sleutel: een tweede sleutel in
hetzelfde project deelt hetzelfde dagquotum.

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

## Nieuw in 0.10.0 (auth): `supabaseOauth` voor MCP-servers

`jwksUri` is optioneel in `@lovable.dev/mcp-js`. Laat je hem weg, dan doet élke
koude isolate eerst een `.well-known`-ontdekking vóór hij een token kan
verifiëren. De ontdekking wordt enkel binnen één warme isolate gecachet, en
edge-isolates recyclen constant, dus je betaalt hem in de praktijk per call.

Gemeten 19-09-2026 op Billara: **90-406 ms** bovenop elke call, op een MCP-call
van ~1.200 ms. Foodie pinde `jwksUri` al; Billara, Eendje en podcast-analyse
niet - dezelfde scheefgroei als bij `geheimenGelijk`.

```ts
import { supabaseOauth } from "jsr:@holie/tools@^0.10/auth";

export default defineMcp({
  // ...
  auth: auth.oauth.issuer(supabaseOauth(projectRef)),
});
```

Neemt een project-ref of een volledige URL. `acceptedAudiences` staat op
`"authenticated"` en is te overschrijven.

## Nieuw in 0.9.0: `./auth`, `./runslot` en `./html`

Drie helpers die op 18-09-2026 als eigen kopie in meerdere repo's stonden.

**`./auth`**: geheimen controleren, altijd fail-closed.

```ts
import {
  bearerToken,
  controleerCronGeheim, // env-var, standaard CRON_SECRET (Foodie-stijl)
  controleerCronGeheimViaDb, // RPC verify_cron_secret (podcast-analyse, Eendje)
  geheimenGelijk, // constante tijd, op bytes
  isMachineSleutel, // SUPABASE_SERVICE_ROLE_KEY én SUPABASE_SECRET_KEYS
} from "jsr:@holie/tools@^0.9/auth";

if (!controleerCronGeheim(req)) {
  return new Response("unauthorized", { status: 401 });
}
const token = bearerToken(req);
if (token && isMachineSleutel(token)) { /* cron, trigger of andere functie */ }
```

⚠️ `isMachineSleutel` kijkt ook naar `SUPABASE_SECRET_KEYS` (JSON, meerdere
sleutels voor rotatie). Enkel tegen `SUPABASE_SERVICE_ROLE_KEY` vergelijken
weigert een geldige nieuwe `sb_secret_...`-sleutel. De admin-rolcontrole
(`user_roles`) zit er bewust niet in: die is per project anders.

**`./runslot`**: één run per job tegelijk, met de poort in de database. Vraagt
per project eenmalig een tabel met een partiële unieke index (SQL staat bovenaan
`runslot.ts`; standaardtabel `cron_runs`, `tabel: "podcast_runs"` kan ook).

```ts
import { eindRun, startRun } from "jsr:@holie/tools@^0.9/runslot";

const run = await startRun(db, "weeg");
if (run.albezig) return new Response("al bezig", { status: 200 });
// ... werk ...
await eindRun(db, run.runId, { note: "25 gewogen" });
```

⚠️ De vervaltermijn (standaard 8 minuten) moet **onder** de cron-interval
blijven, anders weigert de volgende tik en halveert de capaciteit.

**`./html`**: `escapeHtml` escapet `&`, `<`, `>`, `"` en `'`. `./telegram` voert
dezelfde functie heruit; nieuw sinds 0.9.0 is dat de apostrof ook meegaat
(`&#39;`, dat Telegram gewoon als apostrof toont).

## Nieuw in 0.8.0 (ai): `leesJson` en `schatUsd`

Twee stukken die in Billara en de podcast-pijplijn dubbel geschreven stonden.

```ts
import { leesJson, schatUsd, TARIEVEN } from "jsr:@holie/tools@0.8/ai";

const oordeel = leesJson<{ score: number }>(antwoord.content);
const rijtje = leesJson<string[]>(antwoord.content, { vorm: "array" });
const { usd, geschat } = schatUsd(antwoord.model, antwoord.usage);
```

**`leesJson(ruw, opties?)`** peutert JSON uit een modelantwoord, in drie
stappen: kale `JSON.parse`, dan de inhoud van het eerste codeblok (met of zonder
`json`-aanduiding), dan alles van de eerste `{` tot de laatste `}` (of `[`/`]`
met `vorm: "array"`). Lukt niets: `null`. **Geen schemavalidatie** - of de
velden kloppen weet enkel de aanroeper.

⚠️ **De fence-stap pakt de eerste fence waar dan ook in de tekst**, niet alleen
aan begin en eind. De twee originelen verschilden hierin; deze variant kan
strikt meer (een fence middenin, en inhoud die geen object of array is) en
breekt geen geval van de andere, want een fence aan begin en eind is ook de
eerste fence. De stappen zijn bovendien een keten: staat er in de eerste fence
geen geldige JSON, dan krijgt de tekststap alsnog zijn kans.

**`schatUsd(model, usage?)`** rekent tokens om naar dollars en geeft
`{ usd, input, output, geschat }`. De tarieven staan in **`TARIEVEN`**, in **USD
per token** (niet per miljoen). Ze zijn afgelezen, niet geschat: Google van de
Stripe-facturen van de Lovable-gateway, DeepSeek op de cache-miss-prijs van
$0,27 in / $1,10 uit per M.

⚠️ **Een onbekend model geeft `{ usd: 0, geschat: true }`.** Bewust overgenomen
uit het origineel: liever een bedrag dat zichtbaar ontbreekt dan een verzonnen
bedrag dat in een budgetmeter meetelt. Zet er dus geen tarief bij op gevoel -
wie optelt kan op `geschat` filteren en ziet zo dat er een tarief mist.

Komt er bij een beeldmodel geen `usage` mee, dan valt `schatUsd` terug op het
vaste tokenaantal per beeld. Zonder die terugval zou een beeldcall als gratis
geboekt worden, terwijl beeld juist het duurste deel van de rekening is.

## Nieuw in 0.6.0 (ai): domeinhint en taalnamen voor transcriptie

`transcribeerAudio` kent twee nieuwe sturingen, allebei om de **akoestische**
keuze te verbeteren bij korte, losse woorden.

```ts
await transcribeerAudio({
  label: "transcribe-and-analyze",
  base64,
  formaat: "wav",
  taal: "nl", // -> "Vlaams (Belgisch Nederlands)"
  domein: "voeding: wat iemand at of dronk", // -> in de systeemprompt
});
```

- **`domein`** belandt in de **systeemprompt**, niet achteraan de opdracht: de
  systeemrol stuurt hoe het model luistert, en een hint aan het eind komt te
  laat om de klankkeuze te halen. Gemeten 16-09-2026 in Foodie: zonder domein
  werd "druiven" begrepen als "draai".
- **`taal`** wordt een taalnaam in plaats van een ISO-code. `nl` geeft **Vlaams
  (Belgisch Nederlands)**, wat zowel de woordkeuze (pistolet, frigo, croque) als
  de klankherkenning stuurt. Een onbekende code gaat ongewijzigd mee. De tabel
  staat in `TAALNAMEN`, de omzetting is exporteerbaar als `taalnaam()`.

⚠️ **Een domeinhint is geen vrijbrief om te verzinnen.** Het verbod staat
achteraan in de systeemprompt, als laatste instructie, en benoemt de valkuil
letterlijk: het domein is een luisterkader. De poort die het transcript
beoordeelt blijft dus even nodig, want een model dat twijfelt vult plausibel aan
en een domeinhint maakt dat aanvullen juist geloofwaardiger.

⚠️ De opdracht is ook concreter geworden: niet "verzin niets" maar wat het model
WEL moet doen bij een half verstaan woord (geven wat je hoorde, niet gokken naar
iets langers) en bij stilte (exact `NIETS_VERSTAAN`). Een model dat alleen hoort
wat het niet mag, kiest bij twijfel alsnog iets plausibels.

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
  HTTP-_foutstatus_ ligt dat anders: dan is er niets gerenderd en niets
  aangerekend, en mag het volgende model wel.
- **402 en 403 vallen niet door naar het volgende model.** Die gaan over de
  rekening (prepaid potje leeg, of de creditlimiet van de workspace), niet over
  het model. Er komt een `AiQuotumFout` uit, zodat de aanroeper het verschil
  ziet tussen "geen krediet" en "model stuk".
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
andere leverancier in, toets dan eerst of die veldnamen kloppen. Een terugval
die stil breekt op het moment dat hij moet inspringen, is erger dan geen
terugval.

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

- **De providerkeuze staat op een plek**: `AUDIO_PROVIDERS` (sinds 0.11.0
  `["gemini", "lovable"]`) met `STANDAARD_MODELLEN.geminiAudio` en
  `.lovableAudio`. Wie het model of de provider voor alle spraak wil wijzigen,
  wijzigt die twee, niet elke aanroeper. De lijst is met opzet een array, zodat
  een tweede audioprovider erbij kan zonder dat een aanroeper verandert.
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

### Taal van een verzoek kiezen (0.16.0)

```ts
import { kiesTaal } from "@holie/tools/talen";

// Server (TanStack Start):
const req = getRequest();
const lang = kiesTaal({
  talen: PROJECT_LANGUAGES,
  standaard: DEFAULT_LANGUAGE,
  cookie: req.headers.get("cookie"),
  cookieNaam: "ese.lang",
  acceptLanguage: req.headers.get("accept-language"),
});

// Browser:
kiesTaal({
  talen: PROJECT_LANGUAGES,
  standaard: DEFAULT_LANGUAGE,
  cookie: document.cookie,
  cookieNaam: "ese.lang",
  acceptLanguage: navigator.languages,
});
```

Volgorde: de taalcookie (als die een taal van de site bevat), dan de ingang van
Accept-Language met het hoogste q-gewicht die past, dan `standaard`. Een
regiocode valt terug op de hoofdtaal (`nl-BE` wordt `nl`, `fr-CH` wordt `fr`).

| Accept-Language           | talen `en,nl,de,fr`, standaard `en` |
| ------------------------- | ----------------------------------- |
| `nl-BE,nl;q=0.9,en;q=0.8` | `nl`                                |
| `es;q=1,nl;q=0.4`         | `nl` (oude kopieën: `en`)           |
| `en-GB,nl;q=0.5`          | `en`                                |
| `es-ES,es` of leeg        | `en`                                |

Verschil met de projectkopieën (`request-language.server.ts`): die lazen enkel
de eerste ingang, en een cookie met een onbekende taal gaf meteen de standaard.
Hier valt zo'n cookie door naar Accept-Language.

Losse bouwstenen: `ontleedAcceptLanguage(header)`, `pasTaal(waarde, talen)`,
`normaliseerTaal(waarde, talen, standaard)` (vervangt `normalizeLanguage` met
zijn `slice(0, 2)`) en `leesCookie(header, naam)`.

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
- Sinds 0.17.0: `telegramApi` voor elke methode, `bewerkTelegramBericht`,
  `zetTelegramKnoppen`, `beantwoordKlik`, `zetWebhook`, een vast `toetsenbord`
  en `controleerKnoppen` (64 bytes). Zie "Nieuw in 0.17.0".

**Privacy en sleutels.** De module leest geen omgevingsvariabelen, bevat geen
tokens, chat-id's of ontvangers en logt niets. Het token staat in de URL van de
Bot API, en Deno zet die URL in een fetch-foutmelding: `fout` is daarom altijd
ontdaan van het token. Wat projectspecifiek is (welke beheerders, welke tabel,
de logica van een bot) blijft in het project.

## mail

```ts
import { sendMail } from "@holie/tools/mail";

const r = await sendMail({
  apiKey: process.env.RESEND_API_KEY!,
  from: "ESE <noreply@ese-scissors.eu>",
  to: "klant@example.com",
  subject: "Bevestiging",
  html,
  text,
  replyTo: "info@ese-scissors.eu",
  idempotencyKey: `contact/${id}`,
});
if (!r.ok) throw new Error(r.fout); // { ok, id?, status, fout? }
```

Eén mail via de Resend-API, enkel met `fetch`. Ook `cc` en `bcc`; `to`, `cc`,
`bcc` en `replyTo` nemen een adres of een rij.

- Gooit niet: `ok`, `status` (0 bij geen antwoord of foute invoer), `id` van
  Resend, `fout`. Lege sleutel, afzender, ontvanger of onderwerp geeft een reden
  zonder verzoek.
- Timeout standaard 10 s (`timeoutMs`), annuleren via `signal`.

**Privacy en sleutels.** Zoals `./telegram`: geen omgevingsvariabelen, niets
gelogd, en `fout` is altijd ontdaan van de sleutel. Het project kiest zelf
sleutel en afzender: een Resend-sleutel is aan zijn eigen geverifieerde domein
gebonden, en een gekruiste sleutel geeft een 403.

## ics

```ts
import { bouwIcs, ICS_CONTENT_TYPE } from "jsr:@holie/tools@^0.17/ics";

const ics = bouwIcs({
  prodId: "-//Roundbook//Afspraken//NL",
  naam: "Afspraken",
  verversen: "PT1H",
  events: [
    {
      uid: `${a.id}@roundbook.eu`,
      begin: { datum: "2026-11-03", tijd: "09:30" }, // lokale tijd, TZID
      duur: "PT1H",
      titel: "Te bevestigen: Salon X (Lier)",
      locatie: "Lier",
      status: "TENTATIVE",
      gewijzigd: a.gewijzigd_op,
    },
    { uid: "x@y", begin: { datum: "2026-11-04" }, titel: "Hele dag" },
  ],
});
return new Response(ics, { headers: { "Content-Type": ICS_CONTENT_TYPE } });
```

- `begin`/`einde`: `{ datum }` (hele dag), `{ datum, tijd }` (lokaal, in de
  kalendertijdzone, standaard Europe/Brussels met een vaste VTIMEZONE) of een
  `Date` (UTC). Een hele dag zonder einde loopt tot de volgende dag; `einde` is
  zoals in RFC 5545 de eerste dag die er níet meer bij hoort.
- Vouwt op 75 octetten (UTF-8, nooit midden in een teken), escapet TEXT
  (backslash eerst), enkel CRLF. Losse bouwstenen: `escapeIcsTekst`,
  `vouwIcsRegel`, `VTIMEZONE_BRUSSEL`.
- **Een ongeldig event wordt overgeslagen** (datum die niet bestaat, 24:00,
  `duur` samen met `einde`, url met regeleinde), zodat één slechte rij de hele
  feed niet breekt. Met `{ opOngeldig: "gooi" }` komt er een `TypeError`. Een
  fout op kalenderniveau (lege `prodId`) gooit altijd.
- **Injectie dicht.** `prodId`, `uid` en `tzid` verliezen hun controletekens:
  een CR/LF in een invoerveld kan geen eigen regel in de feed zetten.
- **Wat erin mag, beslist het project.** De module filtert geen mail of
  telefoonnummer uit titels; Roundbook houdt daar zijn eigen `zonderContact`
  voor. De vertaling van dagdeel en status naar een event blijft ook daar.
- De volgorde van de eigenschappen is die van Roundbook. Een test bewaakt dat
  Roundbooks twee standaardgevallen byte-gelijk uitkomen, dus de overstap
  verandert de feed niet.

## runslot: rem met venster (0.17.0)

`claimMetVenster` is een rem die in de **database** staat: een conditionele
UPDATE die enkel slaagt als de kolom leeg is, of (met `vensterMs`) ouder dan het
venster. Postgres zet gelijktijdige UPDATEs op dezelfde rij achter elkaar, dus
precies één aanroeper krijgt een rij terug. Hetzelfde patroon stond in
`roundbook-herstel`, in Billara's `claimMelding` en in `startRun`.

```ts
import { claimMetVenster, geefClaimVrij } from "jsr:@holie/tools@^0.17/runslot";

const opties = {
  tabel: "client_member",
  kolom: "laatste_herstel_op",
  sleutel: { email },
  vensterMs: 10 * 60 * 1000,
};
const claim = await claimMetVenster(db, {
  ...opties,
  extra: (q) => q.eq("actief", true).not("lid_user_id", "is", null),
  select: "naam",
});
if (!claim.geclaimd) return; // al een mail in de laatste 10 minuten
const r = await sendMail({/* ... */});
if (!r.ok) await geefClaimVrij(db, opties, claim.stempel); // meteen opnieuw kunnen
```

- Zonder `vensterMs` is de rem eenmalig (`kolom is null`), zoals `claimMelding`.
- **Fail-closed:** een databasefout gooit. Nooit `geclaimd: true` bij twijfel,
  want een rem die bij twijfel toch doorlaat is geen rem.
- `geefClaimVrij` zet de kolom terug op `null`, maar enkel als de stempel nog de
  onze is: een latere claim van iemand anders blijft staan.
- Zonder sleutel, met een sleutelwaarde `null`/`undefined` of met een venster
  `<= 0` komt er een `TypeError` zonder verzoek: nooit een hele tabel claimen.

## Ontwikkelen

```bash
deno task test   # = deno test --allow-env --allow-read --allow-write
deno lint
deno fmt         # vóór een versietag: de publish-workflow draait fmt --check
```

⚠️ **Gebruik `deno task test`, niet het kale `deno test`.** Zonder
`--allow-env --allow-read --allow-write` falen de drie bestandstests in
`mcp-bundel_test.ts` op een permissiefout, en dat leest als drie stukke tests.
Gemeten 16-09-2026: een sessie concludeerde daardoor dat er drie tests kapot
stonden, hield dat staande na een `git stash`-controle (die beide keren
hetzelfde foute commando gebruikte) en gaf het door als openstaand punt. De
CI-workflows draaien wél met die vlaggen, dus daar stonden ze groen - een
verschil dat je pas ziet als je de twee naast elkaar legt.

⚠️ **Echte AI-sleutels in je omgeving breken `ai_test.ts`.** Die tests gaan
ervan uit dat er geen `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`
of `META_MODEL_API_KEY` gezet is. Op een machine waar die als systeemvariabele
staan, falen er 12 (gemeten 28-10-2026, ook vóór 0.16.0). Draai lokaal zo:

```bash
env -u GEMINI_API_KEY -u LOVABLE_API_KEY -u DEEPSEEK_API_KEY -u ANTHROPIC_API_KEY -u META_MODEL_API_KEY deno task test
```

⚠️ **`deno fmt` vóór je een versietag zet.** `publish.yml` draait
`deno fmt --check` en weigert anders te publiceren. Een tag verplaatsen kan niet
(er staat een repository rule op tags), dus dan is een nieuwe patchversie de
enige weg - dat kostte `v0.5.0`.
