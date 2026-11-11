/**
 * Ondertekent het AI-beleid en zet het op het beleidsadres. De privésleutel komt uit
 * `HOLIE_AI_BELEID_SLEUTEL` (PKCS#8, base64).
 *
 *     deno task publiceer [pad/naar.json]            # beleid/ai-beleid.json of een ander bestand
 *     deno task publiceer --uit-tickbook [--droog]   # het concept uit Tickbook
 *
 * `--uit-tickbook` (fase C, 1 nov 2026) haalt het laatste concept op bij de edge function
 * ai-beleid van Tickbook, tekent het, zet het op beleid.holie.be en laat Tickbook weten dat het
 * gepubliceerd is. Er is geen Tickbook-login of tweede geheim voor nodig: de laptop bewijst zich
 * met een Ed25519-handtekening van dezelfde beleidssleutel over `ai-beleid:concept:<tijd>`
 * (hoogstens 5 min oud). `--droog` toont enkel wat er zou gepubliceerd worden.
 *
 * De Worker weigert een volgnummer dat niet hoger is dan het huidige (409).
 */
import {
  type AiBeleid,
  BELEID_URL,
  controleerEnvelop,
  ondertekenBeleid,
  publiekBeleid,
  valideerBeleid,
} from "../beleid.ts";

/** De edge function ai-beleid van Tickbook (Tickbook op de VPS). */
export const TICKBOOK_AI_BELEID =
  "https://billara-api.holie.be/functions/v1/ai-beleid";

const naarB64 = (b: ArrayBuffer) => {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s);
};

/** Ed25519-handtekening (base64) over een tekst, met de PKCS#8-sleutel. */
export async function tekenTekst(
  tekst: string,
  privesleutelPkcs8: string,
): Promise<string> {
  const sleutel = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(privesleutelPkcs8), (c) => c.charCodeAt(0)),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return naarB64(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      sleutel,
      new TextEncoder().encode(tekst),
    ),
  );
}

export interface UitTickbookOpties {
  sleutel: string;
  fetch?: typeof fetch;
  tickbook?: string;
  beleidUrl?: string;
  /** Publieke sleutel voor de controle vooraf (standaard die in het pakket). */
  publiekeSleutel?: string;
  droog?: boolean;
  nu?: () => Date;
  log?: (regel: string) => void;
}

export interface UitTickbookUitslag {
  volgnummer: number;
  gepubliceerd: boolean;
  bevestigd: boolean;
}

/** `--uit-tickbook`: concept ophalen, tekenen, publiceren, Tickbook laten weten. */
export async function publiceerUitTickbook(
  o: UitTickbookOpties,
): Promise<UitTickbookUitslag> {
  const f = o.fetch ?? fetch;
  const tickbook = o.tickbook ?? TICKBOOK_AI_BELEID;
  const log = o.log ?? console.log;
  const post = async (body: unknown) => {
    const r = await f(tickbook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(
        `Tickbook ai-beleid: HTTP ${r.status} ${j?.error ?? ""}`.trim(),
      );
    }
    return j;
  };

  const tijd = (o.nu?.() ?? new Date()).toISOString();
  const handtekening = await tekenTekst(`ai-beleid:concept:${tijd}`, o.sleutel);
  const concept = await post({ actie: "laptop_concept", tijd, handtekening });
  const beleid: AiBeleid = valideerBeleid(concept.inhoud);
  if (beleid.volgnummer !== concept.volgnummer) {
    throw new Error(
      `concept ${concept.volgnummer} draagt volgnummer ${beleid.volgnummer}`,
    );
  }
  log(
    `concept ${beleid.volgnummer} uit Tickbook (uitgegeven ${beleid.uitgegeven}):`,
  );
  for (const w of concept.wijzigingen ?? []) {
    log(`  - v${w.volgnummer}: ${w.reden} (${w.wie})`);
  }
  if (o.droog) {
    log("--droog: niets gepubliceerd");
    return {
      volgnummer: beleid.volgnummer,
      gepubliceerd: false,
      bevestigd: false,
    };
  }

  const envelop = await ondertekenBeleid(publiekBeleid(beleid), o.sleutel);
  await controleerEnvelop(envelop, o.publiekeSleutel); // past bij de publieke sleutel?
  const r = await f(o.beleidUrl ?? BELEID_URL, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelop),
  });
  const antwoord = await r.text();
  log(`beleid.holie.be: ${r.status} ${antwoord}`);
  if (!r.ok) throw new Error(`publiceren mislukt: HTTP ${r.status}`);

  const bevestiging = await post({
    actie: "laptop_bevestig",
    envelop,
    volledig: beleid,
  });
  if (!bevestiging.ok) {
    log(
      `Tickbook bevestigde nog niet (live ${bevestiging.live_volgnummer}, status ${bevestiging.status}); het scherm neemt het over bij de volgende lezing. ${
        (bevestiging.waarschuwingen ?? []).join("; ")
      }`,
    );
  } else log(`Tickbook: versie ${beleid.volgnummer} staat op gepubliceerd`);
  return {
    volgnummer: beleid.volgnummer,
    gepubliceerd: true,
    bevestigd: Boolean(bevestiging.ok),
  };
}

async function publiceerBestand(bron: string | URL, sleutel: string) {
  const beleid = valideerBeleid(JSON.parse(await Deno.readTextFile(bron)));
  const envelop = await ondertekenBeleid(publiekBeleid(beleid), sleutel);
  await controleerEnvelop(envelop); // past bij de publieke sleutel in het pakket?
  const r = await fetch(BELEID_URL, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelop),
  });
  console.log(r.status, await r.text());
  if (!r.ok) Deno.exit(1);
  // Tickbook laten weten (anders mist het elke versie die niet de laatste live is). Mislukt dit,
  // dan is het beleid wel gepubliceerd: enkel melden.
  try {
    const b = await fetch(TICKBOOK_AI_BELEID, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actie: "laptop_bevestig",
        envelop,
        volledig: beleid,
      }),
    });
    const j = await b.json().catch(() => ({}));
    console.log(
      `Tickbook: HTTP ${b.status}, ok=${j?.ok ?? false}, status=${
        j?.status ?? "?"
      }`,
    );
  } catch (e) {
    console.log(`Tickbook niet bereikt: ${(e as Error).message}`);
  }
}

if (import.meta.main) {
  const sleutel = Deno.env.get("HOLIE_AI_BELEID_SLEUTEL");
  if (!sleutel) throw new Error("HOLIE_AI_BELEID_SLEUTEL ontbreekt");
  if (Deno.args.includes("--uit-tickbook")) {
    await publiceerUitTickbook({
      sleutel,
      droog: Deno.args.includes("--droog"),
    });
  } else {
    await publiceerBestand(
      Deno.args[0] ?? new URL("./ai-beleid.json", import.meta.url),
      sleutel,
    );
  }
}
