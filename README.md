# @holie/tools

Twee kleine hulpmodules zonder dependencies, met een eigen ingang per onderdeel:
`@holie/tools/ai` (providerketen voor chat-completions) en `@holie/tools/talen`
(welke talen een site kent, aanbiedt en actief gebruikt).

Sinds 0.32.0 ook `./gebruikers`:
[gedeeld gebruikersbeheer](#gebruikers-gedeeld-gebruikersbeheer-0320).

Sinds 0.31.0 ook `./velden`:
[één methode per invoerveld](#velden-één-methode-per-invoerveld-0310).

Sinds 0.18.0 ook `./formulier` en `./codes`: zie
[de lat N1-N7/T1-T7](#nieuw-in-0180-formulieren-en-bots-de-lat-n1-n7t1-t7).

## gebruikers: gedeeld gebruikersbeheer (0.32.0)

> **Regel: een app die gebruikers beheert (lijst, rol, uitnodigen, deactiveren,
> verwijderen) gebruikt `@holie/tools/gebruikers`, met de rolbewaking ook in de
> databank (`sql/gebruikers.sql`).** Het rolmodel blijft van de app; het pakket
> krijgt de rollen als instelling.

Waarom: op 9 nov 2026 kon geen enkele van de vijf apps (Tickbook, Roundbook,
Eagle-Eye, Eendje, Foodie) alles, vier misten de bescherming tegen jezelf
degraderen of de laatste beheerder weghalen, en `zoekAccount` (een lus over
`listUsers`) stond twee keer gekopieerd.

```ts
const instelling = {
  toewijsbaar: ["admin", "user", "viewer"], // wat het scherm zet
  beheerders: ["admin"], // telt voor "niet de laatste beheerder"
  meerdere: false, // één rol per gebruiker
};
```

| onderdeel                                             | wat                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `magRolWijzigen`, `magDeactiveren`, `magVerwijderen`  | regels voor scherm en server: niet jezelf, niet de laatste beheerder, bevestiging met e-mail      |
| `statusVan(account)`                                  | `uitgenodigd` (nooit aangemeld), `actief`, `gedeactiveerd` (ban)                                  |
| `normaliseerNaam`, `telBeheerders`                    | naam via `schoonRegel` (max 100, `""` = wissen); beheerders die niet gedeactiveerd zijn           |
| `zoekAccountOpEmail(admin, email)`                    | één RPC `account_op_email` (service-role), geen `listUsers`-lus                                   |
| `nodigUit(admin, opties)`                             | `generateLink` + eigen bevestigingslink + mail via `./mail`; idempotent; `droog: true` mailt niet |
| `wijzigEmail`, `wijzigNaam`, `zetActief`, `verwijder` | admin-API; e-mail meteen bevestigd en nooit dat van een ander account                             |
| `vereisBeheerder(req, { gebruiker, isBeheerder })`    | poort: 401 / 403 / 500 of `{ userId }`; de rolcheck is een functie van de app                     |
| `maakGebruikersBeheer(React)`                         | scherm: lijst, zoeken, pagina's, rolkeuze, status, bewerken, uitnodigen, opnieuw sturen, ...      |
| `GEBRUIKERS_TEKSTEN`                                  | nl, en, fr, de                                                                                    |

De serverfuncties krijgen de admin-client (`createClient(url, serviceKey)`) mee
en lezen geen omgevingsvariabelen: ze werken in een edge function (Deno) en in
Node (TanStack Start). Ze gooien niet; een fout komt terug als vaste code
(`ongeldig_email`, `bezet`, `link`, `mail`, ...).

`nodigUit`: een nieuw adres krijgt een `invite`, een account dat nog nooit
aanmeldde een `magiclink` (`status: "opnieuw"`), een account in gebruik niets
(`status: "bestaat"`, tenzij `ookBestaand`). Het account bestaat zodra de link
gemaakt is; mislukt de mail, dan herstelt "opnieuw sturen" het. Een dubbele klik
in dezelfde minuut mailt één keer (Resend-idempotentie).

⚠️ `verwijder` volgt de `on delete cascade` naar `auth.users`: ga in de app
eerst na of het account eigen gegevens heeft, en deactiveer dan liever.

```tsx
// Scherm: dezelfde vorm als het loginblok. shadcn Select en Dialog zijn
// samengesteld; de app schrijft er een kleine omslag rond (Keuze, Dialoog).
import * as React from "react";
import { maakGebruikersBeheer } from "@jsr/holie__tools/gebruikers";
const GebruikersBeheer = maakGebruikersBeheer(React);

<GebruikersBeheer
  gebruikers={rijen}
  huidigeId={user.id}
  instelling={instelling}
  onRol={(g, [rol]) => zetRol(g.id, rol)}
  onUitnodigen={({ email, naam, rollen }) =>
    roep("uitnodigen", { email, naam, rol: rollen[0] })}
  onActief={(g, actief) => roep("actief", { id: g.id, actief })}
  extraKolom={{ kop: "Toegang", cel: (g) => <Toegang id={g.id} /> }}
  onderdelen={{
    Knop: Button,
    Invoer: Input,
    Keuze: MijnSelect,
    Dialoog: MijnDialoog,
  }}
/>;
```

Een handeling die een string teruggeeft (of gooit), toont die als fout; niets
teruggeven is gelukt. Het scherm toetst de regels al vóór de handeling, maar de
server en de databank moeten ze zelf afdwingen.

## velden: één methode per invoerveld (0.31.0)

> **Regel: elk invoerveld voor e-mail, telefoon, land, postcode, btw, IBAN en
> URL gaat door `@holie/tools/velden`, in het scherm én op de server (de
> SQL-versie staat in `sql/velden.sql`).** Geen eigen `trim()` of regex per
> project.

Waarom: iOS zet onzichtbare opmaaktekens (Unicode `Cf`: U+200B-U+200F,
U+202A-U+202E, U+2060-U+2064, U+FEFF) en niet-brekende spaties (U+00A0, U+202F)
in een geplakt veld. `trim()` en Postgres `btrim()` halen die niet weg. Op 8 nov
2026 plakte een iPhone-gebruiker in Roundbook `"0465 50 40 85"` en de server
weigerde het nummer of bewaarde rommel.

Afspraak voor alle functies: `normaliseerX(invoer: unknown, ...)` geeft een
`string` of `null` (leeg of ongeldig), `isGeldigX` geeft een boolean,
`weergaveX` maakt de leesbare vorm. **Bewaar altijd de genormaliseerde vorm**,
toon de weergavevorm.

| functie                                                            | geeft                                                                                         | voorbeeld                                            |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `schoonRegel(s)`                                                   | één regel: Cf weg, elke spatie een spatie, samengevoegd, getrimd                              | `"\u200E Jan\u00A0 P"` wordt `"Jan P"`               |
| `schoonTekst(s)`                                                   | meerdere regels: Cf weg, NBSP een spatie, `\r\n` wordt `\n`, rand getrimd                     | `"Dag\r\n\r\nGroet "` wordt `"Dag\n\nGroet"`         |
| `CF_TEKENS`, `UNICODE_SPATIES`                                     | de regexes (zonder `g`-vlag)                                                                  |                                                      |
| `normaliseerEmail`, `isGeldigEmail`, `EMAIL_PATROON`               | adres in kleine letters, max 254 (ook te importeren uit `./formulier`)                        | `" Jan@Example.BE"` wordt `"jan@example.be"`         |
| `normaliseerTelefoon(x, standaardLand = "BE")`, `isGeldigTelefoon` | E.164 of `null`                                                                               | `"0475/12.34.56"` wordt `"+32475123456"`             |
| `weergaveTelefoon(e164)`                                           | BE gsm/vast gegroepeerd, rest `+CC rest`                                                      | `"+32 475 12 34 56"`                                 |
| `TELEFOON_LANDEN`                                                  | landentabel voor nationale nummers (BE NL LU FR DE GB CH AT ES IT MA TR)                      |                                                      |
| `normaliseerLand`, `isGeldigLand`                                  | ISO alpha-2 uit code (alpha-2/3) of naam in nl/en/fr/de                                       | `"Pays-Bas"` wordt `"NL"`                            |
| `normaliseerPostcode(x, land)`, `isGeldigPostcode`                 | BE 4 cijfers, NL `1234 AB`, LU 4, DE 5, FR 5, rest hoofdletters max 12                        | `"1234ab"` met NL wordt `"1234 AB"`                  |
| `normaliseerOndernemingsnummer`, `isGeldigOndernemingsnummer`      | 10 cijfers, mod-97 gecontroleerd                                                              | `"BE 0403.019.261"` wordt `"0403019261"`             |
| `weergaveOndernemingsnummer`                                       | `0403.019.261`                                                                                |                                                      |
| `normaliseerBtw(x, land?)`, `isGeldigBtw`                          | `BE0403019261`, `NL123456789B01`, `LU12345678`, `FR` + 2 tekens + 9 cijfers, `DE` + 9 cijfers | `"0403.019.261"` met BE wordt `"BE0403019261"`       |
| `normaliseerIban`, `isGeldigIban`, `IBAN_LENGTES`                  | hoofdletters zonder spaties, landlengte en mod-97 gecontroleerd                               | `"be68 5390 0754 7034"` wordt `"BE68539007547034"`   |
| `weergaveIban`                                                     | groepen van vier                                                                              | `"BE68 5390 0754 7034"`                              |
| `normaliseerUrl`, `isGeldigUrl`                                    | `href`; alleen http(s), punt in de host, `https://` erbij                                     | `"www.Example.be"` wordt `"https://www.example.be/"` |
| `VELDEN_SQL`                                                       | de tekst van `sql/velden.sql`                                                                 |                                                      |

Beslissingen die je moet kennen:

- **Telefoon:** een nationaal nummer krijgt het landnummer van `standaardLand`.
  `32475123456` (landnummer zonder plus) is `null`: we raden niet. Voor BE zijn
  8 of 9 cijfers na `+32` goed, voor NL 9 na `+31`; de rest volgt
  `^\+[1-9]\d{7,14}$`.
- **Btw:** zonder landcode in de invoer en zonder `land` is het `null`. Staat er
  een landcode in de invoer, dan wint die. Enkel BE heeft een controlegetal.
- **IBAN:** enkel landen in `IBAN_LENGTES`; een ander land is `null`.
- **URL:** geen `localhost`, geen `javascript:`/`mailto:`, geen `user:pw@host`.
- `schoonTekst` strip ook de zero-width joiner (U+200D, categorie `Cf`):
  samengestelde emoji vallen uiteen.

### Gebruik

```ts
// Deno / Supabase edge functions
import {
  normaliseerEmail,
  normaliseerTelefoon,
  weergaveTelefoon,
} from "jsr:@holie/tools@^0.31/velden";

normaliseerTelefoon("\u202A0465 50 40 85\u202C"); // "+32465504085"
weergaveTelefoon("+32465504085"); // "+32 465 50 40 85"
```

```jsonc
// package.json (Vite, TanStack Start): de JSR-spiegel op npm
{ "dependencies": { "@holie/tools": "npm:@jsr/holie__tools@^0.31.0" } }
// plus in .npmrc:  @jsr:registry=https://npm.jsr.io
```

```ts
import { normaliseerPostcode } from "@holie/tools/velden";
```

### Postgres

Kopieer `sql/velden.sql` (of `VELDEN_SQL`) in een migratie. Het levert
`strip_cf`, `norm_regel`, `norm_email`, `email_geldig`, `norm_telefoon` en
`norm_postcode`, allemaal `immutable parallel safe` met `search_path = ''`, dus
bruikbaar in triggers, check-constraints en generated columns:

```sql
alter table klanten
  add column telefoon_norm text generated always as (public.norm_telefoon(telefoon)) stored,
  add constraint klanten_email_geldig check (email is null or public.email_geldig(email));
```

Verschillen met de TS-versie: telefoon en postcode nemen enkel een ISO
alpha-2-code als land (normaliseer een landnaam eerst met `normaliseerLand`),
`norm_email` geeft de opgeschoonde tekst en `email_geldig` het oordeel, en een
adres van ~254 tekens vol met `İ` (U+0130) krijgt een ander oordeel omdat
`lower()` in Postgres er één teken van maakt. De SQL is getoetst in PGlite met
dezelfde gevallen als de TS-tests (149 vergelijkingen, 0 verschillen, plus de
`Cf`-lijst en de spaties over alle codepoints tot U+30000). De landentabel voor
telefoon moet je op twee plaatsen bijhouden (`TELEFOON_LANDEN` en
`norm_telefoon`).

### ⚠️ Gedragswijziging in 0.31.0 (`normaliseerEmail`, `isGeldigEmail`)

`./formulier` houdt dezelfde namen, maar de implementatie woont nu in
`./velden`. Onzichtbare opmaaktekens (`Cf`) worden **gestript in plaats van
geweigerd**: `"a\u200B@gmail.com"` was `null` en is nu `"a@gmail.com"`. Spaties
(ook NBSP) aan begin en einde worden afgesneden. Spaties en regeleinden _midden
in_ het adres blijven `null`, net als stuurtekens (`Cc`). Een limiet per adres
wordt er niet zwakker van: `a\u200B@x.com` en `a@x.com` zijn nu hetzelfde adres.
Nieuw: `./velden` en `sql/velden.sql`.

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

## Nieuw in 0.29.1: prompt caching voor Claude

- `callAi` zet bij Claude een `cache_control`-breakpoint op het einde van het
  vaste deel (tools + system). Een herhaalde aanroep binnen 5 minuten leest dat
  deel voor 0,1x de prijs; onder het minimum van het model (512 tokens voor
  Haiku 5.5 en Sonnet 5.5) gebeurt er stil niets. Geen wijziging in de aanroep
  nodig.
- Optie `cacheTtl`: `"5m"` (standaard), `"1h"` als dezelfde aanroep meer dan 5
  minuten maar minder dan een uur uit elkaar herhaalt (schrijven kost dan 2x),
  of `false` om uit te zetten.
- Zet wat per aanroep verschilt (datum, gebruikersdata) in het user-bericht. Elk
  verschil in een system-bericht maakt de cache ongeldig.
- `schatUsd` telt `cache_read_input_tokens` (0,1x) en
  `cache_creation_input_tokens` (1,25x, of 2x voor het uur-deel) mee. Controle:
  `usage.cache_read_input_tokens` moet vanaf de tweede aanroep groter dan 0
  zijn.
- Python: `holie_ai_beleid.schat_usd` doet hetzelfde.

## Nieuw in 0.29.0: ogg-spraak via Gemini, denkruimte voor Claude

- **ogg bij Gemini via de eigen route.** Google's OpenAI-compatibele route
  aanvaardt enkel wav en mp3 en gaf op ogg (Telegram-spraakberichten) een 400.
  `transcribeerAudio` stuurt ogg nu naar `generateContent` met `inline_data`
  (`GEMINI_NATIEF_FORMATEN`); de andere formaten blijven op de OpenAI-route.
  Zonder dit viel elk spraakbericht door naar de betalende Lovable-gateway.
- **Denkruimte voor Claude.** Haiku 5.5 denkt standaard mee en dat telt mee in
  `max_tokens`. Bij een krappe `maxTokens` brak het antwoord af en viel de keten
  terug op DeepSeek (Foodie-synoniemen, elke batch). Claude krijgt nu
  `maxTokens + 8000` (`ANTHROPIC_DENKRUIMTE`); `maxTokens` blijft de maat voor
  het antwoord en voor de andere providers.

Bijwerken: `jsr:@holie/tools@^0.29.0/ai`. Geen andere wijziging in de aanroep.

## Nieuw in 0.28.1: `./login` en `./google-terug`, één loginblok voor alle apps

Elke app had een eigen loginpagina, met de Google-knop soms boven en soms onder
het formulier. `./login` is het gedeelde blok, met een vaste volgorde: **Google
bovenaan, dan "of", dan het e-mailformulier**. Het kent geen router en geen
supabase-client, en draagt geen Tailwind-klassen.

⚠️ Het blok importeert React niet zelf. Een JSR-pakket kan geen bereik "React 18
of 19" vastleggen, en een vaste versie gaf een React-18-app een tweede
React-kopie. De app geeft daarom zijn eigen React mee, één keer:

```tsx
// src/components/LoginBlok.tsx
import * as React from "react";
import { maakLoginBlok } from "@holie/tools/login";
export const LoginBlok = maakLoginBlok(React);
```

```tsx
import {
  bewaarGoogleTerug,
  googleTerugMelding,
  neemGoogleTerug,
} from "@holie/tools/google-terug";
bewaarGoogleTerug(); // op topniveau: vóór supabase-js de hash wist (implicit flow)

<LoginBlok
  onGoogle={async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    return error?.message; // een string is een foutmelding
  }}
  onEmail={async (email, wachtwoord) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password: wachtwoord,
    });
    return error ? "Ongeldig e-mailadres of wachtwoord." : null;
  }}
  wachtwoordVergeten={{ href: "/wachtwoord" }} // of { onClick: (email) => ... } of { render }
  melding={googleTerugMelding(neemGoogleTerug())}
  onderdelen={{ Knop: Button, Invoer: Input, Label }} // shadcn van de app, optioneel
/>;
```

- **Google-knop**: officieel G-logo, neutrale knop (wit, grijze rand; donker
  onder `.dark`), tekst "Doorgaan met Google" (en/fr/de: de officiële
  vertalingen van Google). Na de vorige-knop van de browser staat hij weer klaar
  (`pageshow`).
- **Teksten**: `taal` (`nl`, `en`, `fr`, `de`) plus losse `teksten` (bv.
  `inloggen: "Aanmelden"`).
- **Slots**: `emailHint`, `onderFormulier` (onthoud mij, uitnodigingstekst, link
  naar registreren), `children` vervangt het formulier (registreren) terwijl de
  volgorde blijft.
- **Tests**: `ids={{ email: "email", wachtwoord: "password" }}` voor tests die
  `#email` zoeken; `klassen` per onderdeel voor een app zonder Tailwind
  (Roundbook).
- `./google-terug`: `leesGoogleTerug(search, hash)` geeft `code` (PKCE),
  `niet_uitgenodigd` ("Signups not allowed"), `geannuleerd`, `fout` of `leeg`;
  `googleTerugMelding` maakt er de melding van ("geen uitnodiging" en
  "afgebroken" zijn `info`, geen rode fout); `urlZonderGoogleTerug` kuist de URL
  op en laat `next` staan.

## Nieuw in 0.33.0 (ai): storingen in de verbruiksmelding

`callAi` verzamelt per aanroep de providers die faalden (status >= 400 of 0 bij
timeout/netwerk; niet afgekapt, afgekeurd of lege inhoud) en stuurt ze mee als
`storingen: [{ provider, soort: "tegoed" | "fout", status, aantal }]` op de
regel van `POST /verbruik` (weggelaten als er geen waren). `soort` is `tegoed`
bij `isTegoedFout`, anders `fout`. De Worker telt ze op in D1-tabel `storing`
(schema in `beleid/verbruik.sql`, per dag, provider, soort en project) en toont
ze op `GET /storing?dag=YYYY-MM-DD` (zelfde leessleutel als `GET /verbruik`):
`{ dag, storingen: [{ dag, provider, soort, project, aantal, status, eerste, laatste }] }`.

## Nieuw in 0.33.0 (ai): Meta Muse als laatste tekstschakel

`callAi` kent `meta` als chatprovider voor type `tekst` (`META_CHAT_ENDPOINT`,
OpenAI-vorm, `META_MODEL_API_KEY`, standaardmodel `muse-spark-1.3`, optie
`metaModel`). `TEKST_PROVIDERS` is nu anthropic, gemini, lovable, deepseek,
meta. Voor `tools` en `beeld-in` blijft meta uitgesloten: function calling en
beeld-in zijn niet nagemeten. Er staat geen tarief voor Muse (prijs niet
afgelezen): `schatUsd` geeft 0.

## Nieuw in 0.27.1 (ai): `aiVerbruikVersturen` wacht op lopende verzendingen

In een Cloudflare Worker vertrekt de verbruiksmelding meteen, dus de wachtrij
was al leeg als `ctx.waitUntil(aiVerbruikVersturen())` liep en de POST bleef
onbeschermd. Nu wacht `aiVerbruikVersturen()` ook op wat al onderweg is.

## Nieuw in 0.27.0 (telegram): kort geheugen voor bots

Een bot die vrije tekst door een AI laat lezen, vergat tot nu elk vorig bericht.
Vroeg hij "op welk nummer?", dan kwam het antwoord "+32499..." los binnen en was
het belverzoek weg (Billara, 1 nov 2026: drie berichten voor één oproep). Nu
onthoudt een bot de berichten waarop hij een verduidelijking vroeg, 10 minuten
lang, en geeft hij ze mee aan de AI.

```ts
import {
  GEHEUGEN_GELDIG_MS,
  GEHEUGEN_INSTRUCTIE,
  geheugenPrompt,
} from "jsr:@holie/tools@^0.27/telegram";

const { data: onaf } = await db.from("telegram_onaf")
  .select("tekst, antwoord, gemaakt_op").eq("chat_id", chatId)
  .gte("gemaakt_op", new Date(Date.now() - GEHEUGEN_GELDIG_MS).toISOString());
const prompt = geheugenPrompt(
  (onaf ?? []).map((r) => ({
    tekst: r.tekst,
    antwoord: r.antwoord,
    op: r.gemaakt_op,
  })),
  tekst,
);
const antwoord = await callAi([
  {
    role: "system",
    content: `${systeem}
${GEHEUGEN_INSTRUCTIE}`,
  },
  { role: "user", content: prompt },
]);
// Vroeg de bot een verduidelijking: bewaar.
await db.from("telegram_onaf").insert({
  chat_id: chatId,
  tekst,
  antwoord: vraag,
});
// Deed de bot iets: vergeet.
await db.from("telegram_onaf").delete().eq("chat_id", chatId);
```

- De tabel staat in `sql/telegram_onaf.sql`: kopieer ze in een migratie van het
  project. Enkel de service role mag erin.
- `geheugenPrompt` geeft het nieuwe bericht ongewijzigd terug als er geen
  geldige eerdere berichten zijn. Hoogstens 3 berichten, elk afgeknipt op 500
  tekens.
- `GEHEUGEN_INSTRUCTIE` hoort in de systeemprompt: een volledig, ander verzoek
  negeert de oude berichten.
- Bewaar enkel berichten waarop de bot iets terugvroeg, nooit gewone opdrachten:
  anders voert de AI een oude opdracht opnieuw uit.

## Nieuw in 0.26.0 (ai): elke aanroep meldt zijn verbruik

Fase D van het AI-beleid (ontwerp §7). `callAi`, `transcribeerAudio` en
`genereerBeeld` melden na elke geslaagde of mislukte aanroep één regel aan de
dagteller op `https://beleid.holie.be/verbruik` (Worker `holie-ai-beleid`, D1
`holie-ai-verbruik`): dag (Europe/Brussels), project, provider, type, geschatte
USD (`schatUsd`, ook mislukte pogingen met `usage`), terugval, zonder
`gegevens`-label, fout. Tickbook haalt de teller dagelijks op
(`ai_verbruik_dag`).

- **Niets te doen in een project:** wie `stelAiBeleidIn({ project })` heeft,
  meldt vanzelf. Geen sleutel nodig.
- **Gebundeld en fire-and-forget:** één POST per proces of verzoek na
  `VERBRUIK_BUNDEL_MS` (500 ms), harde timeout 2 s, stil bij elke fout. In een
  Supabase edge function via `EdgeRuntime.waitUntil`; in een Cloudflare Worker
  meteen (of `ctx.waitUntil(aiVerbruikVersturen())`).
- **Uit:** `HOLIE_AI_VERBRUIK_URL=uit`, `stelAiBeleidIn({ verbruik: false })`,
  en vanzelf als `HOLIE_AI_BELEID_URL=uit` (tests) of het beleid van een ander
  adres komt. Zonder project wordt niets gemeld.
- **Eigen providers** (Mistral in een eigen lus):
  `meldAiVerbruik({ provider: "mistral", type: "tekst", usd, label: true })`.
- **Python:** `meld_verbruik(project, provider, type_, usd)` en `schat_usd` in
  `beleid/python/holie_ai_beleid.py` (py-1.1.0).

| Wat                                                         | Waarvoor                                            |
| ----------------------------------------------------------- | --------------------------------------------------- |
| `meldAiVerbruik(melding)`                                   | één aanroep melden die het pakket niet zelf doet    |
| `aiVerbruikVersturen()`                                     | de wachtrij nu versturen (Worker, script dat stopt) |
| `aiVerbruikWachtrij()`, `wisAiVerbruik()`                   | diagnose en tests                                   |
| `brusselseDag()`                                            | `YYYY-MM-DD` in Europe/Brussels                     |
| `VERBRUIK_URL`, `VERBRUIK_BUNDEL_MS`, `VERBRUIK_TIMEOUT_MS` | adres en tijden                                     |

⚠️ De teller onderschat (panel #7): Merlin, Claude Code en losse scripts die het
pakket niet gebruiken, tellen niet mee; een model zonder regel in `TARIEVEN`
telt als 0.

## Nieuw in 0.25.0: `./nieuwsbrief` en `sendMailBatch`

Een nieuwsbrief die de regels van Gmail en Yahoo volgt en niemand twee keer
mailt.

| Wat                                                | Waar                  | Waarvoor                                                                                                                  |
| -------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `uitschrijfKoppen(url, { mailto? })`               | `./nieuwsbrief`       | `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058): de mailclient toont een eigen uitschrijfknop                     |
| `isOneClickUitschrijving(type, body)`              | `./nieuwsbrief`       | herkent de POST `List-Unsubscribe=One-Click` van die knop                                                                 |
| `uitgaveSleutel(soort, delen)`                     | `./nieuwsbrief`       | vaste sleutel per uitgave, voor het verzendregister en de `Idempotency-Key`                                               |
| `verdeelInBatches(items, 100)`                     | `./nieuwsbrief`       | stukken van 100, de batchgrens van Resend                                                                                 |
| `verwerkResendWebhook(req, geheim)`                | `./nieuwsbrief`       | Svix-handtekening controleren; `soort` = `bounce` (enkel Permanent), `klacht` of `andere`                                 |
| `sendMailBatch({ apiKey, mails, idempotencyKey })` | `./mail`              | tot 100 mails per verzoek, elk met een eigen `to` en eigen koppen                                                         |
| `headers`                                          | `./mail` (`sendMail`) | extra mailkoppen; een regeleinde in naam of waarde wordt geweigerd                                                        |
| `sql/nieuwsbrief.sql`                              | SQL                   | `nieuwsbrief_claim` / `nieuwsbrief_vrijgeven` (verzendregister) en `nieuwsbrief_onderdruk` (bounce en klacht, als sha256) |

Regels die erbij horen:

- **Uitschrijflink met een id, niet met het adres**, en de code uit
  `maakUitschrijfcode(geheim, "nieuwsbrief", id)`: geen persoonsgegeven in de
  URL, geen token te bewaren.
- **Uitschrijfpagina schrijft pas uit na een klik** (POST). Mailscanners openen
  elke link, ook die.
- **Verzenden:** `nieuwsbrief_claim(uitgave, ids)` geeft enkel wie deze uitgave
  nog niet kreeg; mislukt een batch, dan `nieuwsbrief_vrijgeven` voor die batch.
  Twee gelijktijdige runs krijgen nooit dezelfde ontvanger.
- Titels en andere tekst in de mail altijd door `escapeHtml` (`./html`).

## Nieuw in 0.25.2 (ai-beleid)

Momentopname op beleid volgnummer 3: DeepSeek toegelaten voor persoonsgegevens
in Shintaka, en project `billara-klantmail` (Claude altijd eerst, DeepSeek enkel
als terugval). `PAKKET_VERSIE` staat weer gelijk met `deno.json` (0.25.0 meldde
zich als 0.24.0).

## Nieuw in 0.24.0 (ai): `kiesAiVolgorde`

Voor code die zelf over providers loopt, of een provider aanspreekt die dit
pakket niet kent (Mistral bij de Eendje-vertaling):
`kiesAiVolgorde(type, opties)` geeft de volgorde die het beleid kiest, zonder
iets aan te roepen. `pakket` zegt wat de aanroeper zelf kan, `heeftSleutel`
toetst sleutels die niet in `SLEUTEL_VAR` staan. Gooit een `AiBeleidFout` als er
niets overblijft.

## Nieuw in 0.23.0 (ai): het beleid komt van een ondertekend adres

Onder beleid haalt het pakket het beleid op bij
`https://beleid.holie.be/ai-beleid.json` (Cloudflare Worker `holie-ai-beleid`,
code in `beleid/worker.js`):

- **Ondertekend** met Ed25519 (`BELEID_PUBLIEKE_SLEUTEL`). Een vervalst of
  gewijzigd bestand wordt geweigerd; de Worker zelf aanvaardt enkel een geldig
  ondertekend bestand met een hoger volgnummer, dus er staat daar geen geheim.
- **Harde timeout 600 ms**, vers 5 min, daarna verouderd-maar-bruikbaar tot 24 u
  met verversing op de achtergrond. Ouder of onbereikbaar: de momentopname,
  anders het noodbeleid. Na een mislukte ophaling een minuut niet opnieuw
  wachten.
- Een opgehaald bestand met een lager volgnummer dan de momentopname wint nooit.
- Het ophalen meldt `?project=...&v=0.23.0`; `GET /lezers` toont per project de
  versie en wanneer het laatst gelezen werd. Een project dat daar niet staat, is
  NIET ONDER BELEID.
- `HOLIE_AI_BELEID_URL` zet een ander adres, `uit` haalt niets op;
  `stelAiBeleidIn({ url: false })` idem. `aiBeleidStatus()` voor diagnose.
- Publiceren: `deno task publiceer` (ondertekent met `HOLIE_AI_BELEID_SLEUTEL`).
  Vanaf fase C doet Tickbook dat.

## Nieuw in 0.22.0 (ai): het AI-beleid

Eén beleid voor alle projecten bepaalt welke provider een aanroep mag en in
welke volgorde (`./beleid`, het bestand zelf in `beleid/ai-beleid.json`,
meegeleverd als `./ai-beleid`). Rangorde, altijd dezelfde:

    uitsluiting > projectverbod > witte lijst > voorrang > basis

```ts
import { callAi, stelAiBeleidIn } from "jsr:@holie/tools@^0.22/ai";
import { AI_BELEID } from "jsr:@holie/tools@^0.22/ai-beleid";

stelAiBeleidIn({ project: "foodie", momentopname: AI_BELEID });

// Gegevens = projectstandaard (gezondheid); per aanroep te overschrijven.
await callAi(berichten, { label: "coach" });
await callAi(berichten, { label: "vertaal", gegevens: "publiek" });
// Bewust vaste keten: geen voorrang, wél de uitsluitingen.
await callAi(berichten, {
  label: "telefoon",
  volgorde: ["deepseek"],
  vast: true,
});
// Verwerkerscontext: enkel providers die aan de klant gemeld zijn.
await callAi(berichten, {
  label: "tg",
  gegevens: "persoon",
  context: "roundbook",
});
```

- **Zonder project** (geen `stelAiBeleidIn`, geen `HOLIE_AI_PROJECT`) loopt
  alles zoals vóór 0.22.0, met eenmaal de waarschuwing `NIET ONDER BELEID`. Een
  pakketupgrade verandert dus niets tot het project zich aanmeldt.
- **Toelating** per provider x soort gegevens (`publiek`, `prive-peter`,
  `persoon`, `gezondheid`), optioneel per project, met status `onderbouwd`,
  `testfase` of `uitgesloten`. Geen regel = uitgesloten. Na `geldig_tot` slaat
  een toelating vanzelf om naar uitgesloten. `toestemming_vereist` vraagt
  `toestemming: ["deepseek"]` in de aanroep.
- **Verwerkerscontext** (bv. `roundbook`): enkel providers met
  `gemeld_aan_klant`.
- **Projectregels**: `verboden` (nooit, ook niet als terugval) en `wittelijst`
  (`zacht`: zo ver als mogelijk; `strikt`: anders een fout), beide optioneel per
  type.
- **Voorrang** op datum (`van`/`tot`), globaal of per project, per type.
- **Leeg = fout**: `AiBeleidFout` (een `AiOnbeschikbaar`) met `stap` = de stap
  die de lijst leegmaakte (`capaciteit`, `uit`, `uitsluiting`,
  `verwerkerscontext`, `projectverbod`, `witte lijst`, `sleutel`, `tegoed op`).
- **Negatieve cache**: een 400/401/402 met "credit" of "balance" in de tekst zet
  die provider (per sleutel) 10 minuten buiten de keten (`TEGOED_OP_MS`). Ook
  zonder beleid.
- **Terugval**: zonder momentopname geldt `NOODBELEID`: persoon en gezondheid
  enkel naar Claude.
- Antwoorden en hooks dragen nu `type`, `gegevens` en `terugval`.
- `kiesProviders(beleid, vraag)` is de "wat zou er gebeuren"-toets, zonder call.
- `TARIEVEN` kent Sonnet 5.5/5/4.6 en Opus 5.5/5/4.8; `schatUsd` leest ook de
  ruwe Anthropic-vorm (`input_tokens`/`output_tokens`).

Beleid wijzigen: `beleid/ai-beleid.json` aanpassen, `volgnummer` ophogen,
`deno task
beleid` (schrijft `ai-beleid.ts`), testen, release.

## Nieuw in 0.21.0 (talen): `externeLink` weer weg

`externeLink` en `externeLinkUitRij` uit 0.20.0 zijn verwijderd. Peter,
31-10-2026: een link naar een externe site gaat naar haar hoofdadres (root URL),
de externe site regelt haar talen zelf. Adressen per taal bijhouden is overkill.
Zie [talen](#links-naar-een-externe-site).

⚠️ **Bump vereist en API-breuk.** Wie de twee functies importeerde, moet ze
eerst weghalen; geen enkel project gebruikt ze nog.

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

### Links naar een externe site

Een link naar een externe site gaat naar haar **hoofdadres** (root URL). Geen
adressen per taal, geen kolommen `website_url_<taal>`: de externe site regelt
haar talen zelf (Peter, 31-10-2026; de helpers uit 0.20.0 zijn in 0.21.0 weer
weg).

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
