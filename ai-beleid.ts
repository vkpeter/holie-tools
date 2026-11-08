/**
 * Momentopname van het AI-beleid, meegeleverd met het pakket als terugval wanneer het
 * beleidsadres onbereikbaar is. GEGENEREERD door `deno task beleid` uit
 * `beleid/ai-beleid.json`; niet met de hand bewerken.
 *
 * Gebruik: `stelAiBeleidIn({ project: "foodie", momentopname: AI_BELEID })`.
 *
 * @module
 */
import type { AiBeleid } from "./beleid.ts";

export const AI_BELEID: AiBeleid = {
  "basis": {
    "tts": [
      "huggingface",
    ],
    "tekst": [
      "anthropic",
      "gemini",
      "lovable",
      "deepseek",
    ],
    "tools": [
      "anthropic",
      "gemini",
      "lovable",
      "deepseek",
    ],
    "audio-in": [
      "gemini",
      "lovable",
    ],
    "beeld-in": [
      "anthropic",
      "gemini",
      "lovable",
      "deepseek",
    ],
    "beeld-uit": [
      "lovable",
      "meta",
    ],
    "embeddings": [
      "nebius",
    ],
    "live-spraak": [
      "anthropic",
      "deepseek",
    ],
  },
  "schema": 1,
  "voorrang": [
    {
      "tot": "2027-01-31",
      "van": "2026-10-28",
      "wie": "Peter",
      "bron":
        "Projecten/AI-providervolgorde - audit en centrale schakelaar (1 nov 2026)",
      "datum": "2026-11-01",
      "reden":
        "Claude-tegoed USD 251 (Console, 1 nov 2026), maandlimiet USD 100: ruwweg tot eind januari. Eerder op = 400 'credit balance' en de negatieve cache slaat Claude 10 min over.",
      "types": [
        "tekst",
        "tools",
        "beeld-in",
      ],
      "provider": "anthropic",
    },
    {
      "van": "2026-11-01",
      "wie": "Peter",
      "bron": "Peter in de chat, 1 nov 2026",
      "datum": "2026-11-01",
      "reden":
        "klantmail: Claude altijd eerst, DeepSeek enkel als terugval (geen einddatum)",
      "types": [
        "tekst",
      ],
      "project": "billara-klantmail",
      "provider": "anthropic",
    },
    {
      "van": "2026-11-01",
      "wie": "Peter",
      "bron": "Peter in de chat, 1 nov 2026",
      "datum": "2026-11-01",
      "reden":
        "telefoonagent: Claude altijd eerst, DeepSeek enkel als terugval (geen einddatum)",
      "types": [
        "tekst",
        "tools",
        "live-spraak",
      ],
      "project": "billara-telefoon",
      "provider": "anthropic",
    },
    {
      "provider": "gemini",
      "project": "podcast",
      "types": [
        "audio-in",
      ],
      "van": "2026-11-08",
      "wie": "Peter",
      "datum": "2026-11-08",
      "reden":
        "Podcast-ASR op de VPS: eerst het gratis niveau van Gemini rechtstreeks (sleutel holie.be), bij quotum of 429 verder via de Lovable-gateway (Billara-sleutel). Vervangt de Lovable-voorrang van v11.",
      "bron":
        "Peter, 8 nov 2026: 'nu we weten dat het werkt, mag je idd eerst de gratis gemini tokens op farmen en daarna verder doen op lovable ai tokens'",
    },
    {
      "provider": "anthropic",
      "project": "podcast-merge",
      "types": [
        "tekst",
      ],
      "van": "2026-11-08",
      "wie": "Peter",
      "datum": "2026-11-08",
      "reden":
        "Merge van de podcast-duidingen naar de vault op de VPS: Claude Opus, geen terugval (de job stopt liever dan met een goedkoper model te schrijven).",
      "bron":
        "Peter, 8 nov 2026: 'hij mag specifiek voor het merge deel opus gebruiken, omdat het belangrijk is dat die inzichten zeer goed zijn'",
    },
  ],
  "contexten": {
    "roundbook": {
      "providers": [
        {
          "bron":
            "AVG-panel Roundbook 28 okt 2026, punt 6; shintaka telegram-ai.ts",
          "provider": "gemini",
          "gemeld_aan_klant": "2026-10-28",
        },
        {
          "bron":
            "AVG-panel Roundbook 28 okt 2026, punt 6; shintaka telegram-ai.ts",
          "provider": "lovable",
          "gemeld_aan_klant": "2026-10-28",
        },
      ],
      "omschrijving":
        "Verwerkersovereenkomst Roundbook (Eagle-Eye): berichten van Arend-Jan in Telegram met salonnamen en voornamen. Enkel providers uit de sub-verwerkerslijst.",
    },
  },
  "projecten": {
    "ese": {
      "gegevens": "publiek",
      "omschrijving": "ese-scissors.eu: artikels, vertalingen, sitetekst",
    },
    "arrif": {
      "gegevens": "publiek",
      "omschrijving": "arrif.app: woordenboek, bronnenscan",
    },
    "domus": {
      "gegevens": "prive-peter",
      "omschrijving": "Domus: woningscore",
    },
    "holie": {
      "gegevens": "publiek",
      "omschrijving": "holie.be",
    },
    "eendje": {
      "gegevens": "publiek",
      "omschrijving": "eendje.be: artikels, topics, vertalingen, beeld",
    },
    "foodie": {
      "gegevens": "gezondheid",
      "omschrijving":
        "hapklik / foodieapp.eu: maaltijden, foto's, gewicht, coaching",
    },
    "merlin": {
      "gegevens": "prive-peter",
      "omschrijving": "Merlin (OpenClaw op de Pi)",
    },
    "billara": {
      "gegevens": "persoon",
      "omschrijving":
        "Tickbook/Billara: Telegram-bot, meetings, klantberichten, Roundbook",
    },
    "phyllox": {
      "gegevens": "persoon",
      "omschrijving": "Phyllox: moderatie van gebruikersinhoud, Telegram",
    },
    "podcast": {
      "gegevens": "publiek",
      "omschrijving": "podcast-analyse: duiden, wegen, groeperen",
    },
    "shintaka": {
      "gegevens": "publiek",
      "omschrijving":
        "Shintaka-webshop: artikels, vertalingen (publiek); Telegram-flows geven gegevens persoon mee. Claude en DeepSeek toegelaten (Peter 1 nov 2026)",
    },
    "sjabloon": {
      "gegevens": "publiek",
      "omschrijving": "holie-site-sjabloon",
    },
    "roundbook": {
      "context": "roundbook",
      "gegevens": "persoon",
      "omschrijving": "Roundbook-flows in Billara",
    },
    "vacatures": {
      "gegevens": "prive-peter",
      "omschrijving": "VPS-vacaturescan",
    },
    "billara-telefoon": {
      "gegevens": "persoon",
      "omschrijving":
        "Tickbook-telefoonagent (voice-ai.ts, Isabel): Claude gestreamd, DeepSeek als terugval",
    },
    "billara-klantmail": {
      "gegevens": "persoon",
      "omschrijving":
        "Tickbook-klantmail (verslag-ai.ts): Claude, DeepSeek als terugval",
    },
    "podcast-merge": {
      "gegevens": "prive-peter",
      "omschrijving":
        "podcast-merge op de VPS: duidingen samenvoegen in de privé-vault (HolieVault), enkel Claude Opus",
    },
    "holie-ci": {
      "gegevens": "publiek",
      "omschrijving": "Korte triage van gefaalde smokes en CI-runs op de VPS",
    },
  },
  "providers": {
    "meta": {
      "naam": "Meta Model API (Muse Image)",
      "aanroepbaar": true,
      "capaciteiten": [
        "beeld-uit",
      ],
    },
    "gemini": {
      "naam": "Gemini (Google, gratis API)",
      "tier":
        "gratis: dagquotum per Google-project; beeld-uit quotum nul (429, 19 sep 2026); beeld-in niet apart nagemeten",
      "aanroepbaar": true,
      "dataprofiel": {
        "dpa": "onbekend",
        "bron":
          "ai.google.dev/gemini-api/terms, 19 sep 2026: in de EER gelden de betaalvoorwaarden (geen training); FOO-228: 'geen gevoelige info'",
        "regio": "VS",
        "training": "nee",
      },
      "capaciteiten": [
        "tekst",
        "tools",
        "beeld-in",
        "audio-in",
      ],
    },
    "nebius": {
      "naam": "Nebius",
      "tier": "embeddings van Merlin (OpenClaw)",
      "aanroepbaar": false,
      "capaciteiten": [
        "embeddings",
      ],
    },
    "lovable": {
      "naam": "Lovable AI-gateway",
      "aanroepbaar": true,
      "dataprofiel": {
        "dpa": "ja",
        "bron":
          "FOO-228: DPA verbiedt bijzondere categorieën, 90 dagen prompt-logging",
        "bewaartermijn": "90 dagen prompt-logging",
      },
      "capaciteiten": [
        "tekst",
        "tools",
        "beeld-in",
        "audio-in",
        "beeld-uit",
      ],
    },
    "mistral": {
      "naam": "Mistral",
      "tier":
        "enkel Eendje-vertaling, eigen code; niet aanroepbaar via @holie/tools",
      "aanroepbaar": false,
      "dataprofiel": {
        "bron": "niet nagemeten",
        "regio": "EU",
      },
      "capaciteiten": [
        "tekst",
      ],
    },
    "deepseek": {
      "naam": "DeepSeek",
      "aanroepbaar": true,
      "dataprofiel": {
        "dpa": "onbekend",
        "scc": "nee",
        "bron":
          "AVG-panel Roundbook 28 okt 2026: geen adequaatheidsbesluit, geen SCC; advocaatvragen 2.10-2.12",
        "regio": "China",
        "training": "onbekend",
      },
      "capaciteiten": [
        "tekst",
        "tools",
        "beeld-in",
        "live-spraak",
      ],
    },
    "anthropic": {
      "naam": "Claude (Anthropic API)",
      "tier": "betalend tegoed; maandlimiet USD 100 in de Console",
      "aanroepbaar": true,
      "dataprofiel": {
        "dpa": "onbekend",
        "scc": "onbekend",
        "bron":
          "niet nagemeten; FOO-228 vermeldt Anthropic enkel terloops (panel 1 nov 2026, #2)",
        "regio": "VS",
        "training": "onbekend",
      },
      "capaciteiten": [
        "tekst",
        "tools",
        "beeld-in",
        "live-spraak",
      ],
    },
    "huggingface": {
      "naam": "Hugging Face",
      "tier": "Tarifit-TTS en pyannote, eigen scripts",
      "aanroepbaar": false,
      "capaciteiten": [
        "tts",
      ],
    },
    "whisper": {
      "naam": "Whisper lokaal (faster-whisper op de laptop)",
      "aanroepbaar": false,
      "tier":
        "laatste terugval buiten de keten: podcast-worker --asr-backend lokaal op de laptop, met de hand",
      "capaciteiten": [
        "audio-in",
      ],
    },
  },
  "uitgegeven": "2026-11-08",
  "volgnummer": 15,
  "toelatingen": [
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "openbare tekst, geen persoonsgegevens",
      "status": "onderbouwd",
      "gegevens": "publiek",
      "provider": "anthropic",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "Peters eigen gegevens, eigen keuze",
      "status": "onderbouwd",
      "gegevens": "prive-peter",
      "provider": "anthropic",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden":
        "ja buiten de verwerkerscontext Roundbook; DPA en doorgiftegrond niet nagemeten",
      "status": "testfase",
      "herzien": "na nameting Anthropic-DPA",
      "gegevens": "persoon",
      "provider": "anthropic",
    },
    {
      "wie": "Peter",
      "bron": "panel 1 nov 2026, #2",
      "datum": "2026-11-01",
      "reden":
        "Claude staat sinds 28 okt eerst voor Foodie, maar Anthropic staat niet in verwerkersdossier FOO-228 (DPA, doorgiftegrond, bewaartermijn niet nagemeten)",
      "status": "testfase",
      "herzien": "na nameting Anthropic-DPA, vóór commerciële lancering",
      "gegevens": "gezondheid",
      "provider": "anthropic",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "openbare tekst",
      "status": "onderbouwd",
      "gegevens": "publiek",
      "provider": "deepseek",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "Peters eigen gegevens, eigen keuze",
      "status": "onderbouwd",
      "gegevens": "prive-peter",
      "provider": "deepseek",
    },
    {
      "wie": "Peter",
      "bron": "AVG-panel Roundbook 28 okt 2026, punt 6",
      "datum": "2026-10-28",
      "reden":
        "China, geen adequaatheidsbesluit, geen SCC (Roundbook: DeepSeek uit de bot)",
      "status": "uitgesloten",
      "gegevens": "persoon",
      "provider": "deepseek",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "bijzondere categorie, geen afspraak met DeepSeek",
      "status": "uitgesloten",
      "gegevens": "gezondheid",
      "provider": "deepseek",
    },
    {
      "wie": "Peter",
      "bron":
        "Vault: Foodie - Claude voor gezondheidsdata, papierwerk (FOO-228, 1 nov 2026)",
      "datum": "2026-11-01",
      "reden":
        "FOO-228 (Peter, 1 nov 2026): geen verwerkersovereenkomst, doorgifte naar China zonder geldige grond. Ook niet als terugval voor Foodie-gezondheidsgegevens.",
      "status": "uitgesloten",
      "herzien":
        "commerciële lancering; geldig_tot is een voorlopige datum zolang de lancering niet gepland is",
      "project": "foodie",
      "gegevens": "gezondheid",
      "provider": "deepseek",
      "grondslag": "nog vast te leggen (advocaatvragen 2.10-2.12)",
      "geldig_tot": "2027-05-01",
      "toestemming_vereist": false,
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "openbare tekst",
      "status": "onderbouwd",
      "gegevens": "publiek",
      "provider": "gemini",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "Peters eigen gegevens",
      "status": "onderbouwd",
      "gegevens": "prive-peter",
      "provider": "gemini",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "gemeld in Roundbook; gratis API zonder DPA niet nagemeten",
      "status": "testfase",
      "gegevens": "persoon",
      "provider": "gemini",
    },
    {
      "wie": "Peter",
      "bron": "panel 1 nov 2026, #1",
      "datum": "2026-11-01",
      "reden":
        "testfase ZONDER onderbouwing: FOO-228 noemt Gemini gratis ('geen gevoelige info') een van de zwaarste risico's; nu nog nodig voor spraak in Foodie",
      "status": "testfase",
      "herzien": "vóór commerciële lancering",
      "gegevens": "gezondheid",
      "provider": "gemini",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "openbare tekst",
      "status": "onderbouwd",
      "gegevens": "publiek",
      "provider": "lovable",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "Peters eigen gegevens",
      "status": "onderbouwd",
      "gegevens": "prive-peter",
      "provider": "lovable",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "gemeld in Roundbook; DPA bestaat, doorgifte niet nagemeten",
      "status": "testfase",
      "gegevens": "persoon",
      "provider": "lovable",
    },
    {
      "wie": "Peter",
      "bron": "panel 1 nov 2026, #1",
      "datum": "2026-11-01",
      "reden":
        "testfase ZONDER onderbouwing: Lovable-DPA verbiedt bijzondere categorieën, 90 dagen prompt-logging (FOO-228); nu nog terugval voor spraak en beeld in Foodie",
      "status": "testfase",
      "herzien": "vóór commerciële lancering",
      "gegevens": "gezondheid",
      "provider": "lovable",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "beeldprompts voor artikels",
      "status": "onderbouwd",
      "gegevens": "publiek",
      "provider": "meta",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §3",
      "datum": "2026-11-01",
      "reden": "Peters eigen beelden",
      "status": "onderbouwd",
      "gegevens": "prive-peter",
      "provider": "meta",
    },
    {
      "wie": "Peter",
      "datum": "2026-11-01",
      "reden": "niet beslist",
      "status": "uitgesloten",
      "gegevens": "persoon",
      "provider": "meta",
    },
    {
      "wie": "Peter",
      "datum": "2026-11-01",
      "reden": "niet beslist",
      "status": "uitgesloten",
      "gegevens": "gezondheid",
      "provider": "meta",
    },
    {
      "wie": "Peter",
      "bron": "ontwerp §1",
      "datum": "2026-11-01",
      "reden": "Eendje-vertalingen",
      "status": "onderbouwd",
      "gegevens": "publiek",
      "provider": "mistral",
    },
    {
      "wie": "Peter",
      "datum": "2026-11-01",
      "reden": "niet gebruikt",
      "status": "testfase",
      "gegevens": "prive-peter",
      "provider": "mistral",
    },
    {
      "wie": "Peter",
      "datum": "2026-11-01",
      "reden": "niet beslist",
      "status": "uitgesloten",
      "gegevens": "persoon",
      "provider": "mistral",
    },
    {
      "wie": "Peter",
      "datum": "2026-11-01",
      "reden": "niet beslist",
      "status": "uitgesloten",
      "gegevens": "gezondheid",
      "provider": "mistral",
    },
    {
      "wie": "Peter",
      "datum": "2026-11-01",
      "reden": "Tarifit-TTS van lesmateriaal",
      "status": "onderbouwd",
      "gegevens": "publiek",
      "provider": "huggingface",
    },
    {
      "wie": "Peter",
      "datum": "2026-11-01",
      "reden": "eigen opnames",
      "status": "onderbouwd",
      "gegevens": "prive-peter",
      "provider": "huggingface",
    },
    {
      "wie": "Peter",
      "datum": "2026-11-01",
      "reden": "embeddings",
      "status": "onderbouwd",
      "gegevens": "publiek",
      "provider": "nebius",
    },
    {
      "wie": "Peter",
      "datum": "2026-11-01",
      "reden": "Merlin-geheugen",
      "status": "onderbouwd",
      "gegevens": "prive-peter",
      "provider": "nebius",
    },
    {
      "wie": "Peter",
      "bron": "Peter in de chat, 1 nov 2026",
      "datum": "2026-11-01",
      "reden":
        "Claude en DeepSeek toegelaten bij Shintaka, ook voor de Telegram-inhoud (salonnamen, voornamen)",
      "status": "testfase",
      "project": "shintaka",
      "gegevens": "persoon",
      "provider": "deepseek",
    },
    {
      "wie": "Peter",
      "bron": 'Peter in de chat, 1 nov 2026 ("Ja en uitzondering")',
      "datum": "2026-11-01",
      "reden":
        "Peter, 1 nov 2026: klantmail mag niet stilvallen als Claude uitvalt. DeepSeek enkel als terugval; Claude blijft vooraan door de projectvoorrang",
      "status": "testfase",
      "herzien":
        "geldig_tot is een voorlopige datum, zoals bij de Foodie-toelating; herzien bij het advocaatadvies",
      "project": "billara-klantmail",
      "gegevens": "persoon",
      "provider": "deepseek",
      "grondslag":
        "gerechtvaardigd belang (continuiteit van de dienst aan de klant); verwerkersvoorwaarden DeepSeek nog na te kijken (advocaatvragen 2.10-2.12)",
      "geldig_tot": "2027-05-01",
      "toestemming_vereist": false,
    },
    {
      "wie": "Peter",
      "bron": 'Peter in de chat, 1 nov 2026 ("Yes, add exception")',
      "datum": "2026-11-01",
      "reden":
        "Peter, 1 nov 2026: de telefoonagent (Isabel) mag niet stilvallen als Claude uitvalt. DeepSeek enkel als terugval; Claude blijft vooraan door de projectvoorrang",
      "status": "testfase",
      "herzien":
        "geldig_tot is een voorlopige datum, zoals bij de klantmail; herzien bij het advocaatadvies",
      "project": "billara-telefoon",
      "gegevens": "persoon",
      "provider": "deepseek",
      "grondslag":
        "gerechtvaardigd belang (continuiteit van de dienst aan de beller); verwerkersvoorwaarden DeepSeek nog na te kijken (advocaatvragen 2.10-2.12)",
      "geldig_tot": "2027-05-01",
      "toestemming_vereist": false,
    },
    {
      "wie": "Peter",
      "bron":
        "Vault: Foodie - Claude voor gezondheidsdata, papierwerk (FOO-228, 1 nov 2026)",
      "datum": "2026-11-01",
      "reden":
        "FOO-228 (Peter, 1 nov 2026): de DPA van Lovable verbiedt gevoelige gegevens. Ook niet als terugval voor Foodie-gezondheidsgegevens.",
      "status": "uitgesloten",
      "project": "foodie",
      "gegevens": "gezondheid",
      "provider": "lovable",
    },
    {
      "wie": "Peter",
      "bron":
        "Vault: Foodie - Claude voor gezondheidsdata, papierwerk (FOO-228, 1 nov 2026), §4",
      "datum": "2026-11-01",
      "reden":
        "FOO-228 (1 nov 2026): verwerkersovereenkomst en SCC's bij Anthropic; toestemming v2 noemt de AI-dienst buiten de EU en wordt op de server afgedwongen (hapklik 6e66dd76, live).",
      "status": "onderbouwd",
      "project": "foodie",
      "gegevens": "gezondheid",
      "provider": "anthropic",
      "grondslag": "toestemming (art. 9.2.a), versie 2026-11-01.v2",
    },
    {
      "wie": "Peter",
      "datum": "2026-11-08",
      "provider": "whisper",
      "gegevens": "publiek",
      "status": "onderbouwd",
      "reden": "lokaal, niets verlaat de laptop",
    },
    {
      "wie": "Peter",
      "datum": "2026-11-08",
      "provider": "whisper",
      "gegevens": "prive-peter",
      "status": "onderbouwd",
      "reden": "lokaal, niets verlaat de laptop",
    },
  ],
  "standaard_gegevens": "persoon",
};
