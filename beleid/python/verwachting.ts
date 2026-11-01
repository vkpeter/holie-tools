/**
 * Maakt `verwachting.json`: wat `kiesProviders` (TypeScript) zegt over een reeks vragen, plus
 * een ondertekend envelop met een wegwerpsleutel. De Python-toets moet exact hetzelfde geven.
 *
 *   deno run --allow-read --allow-write beleid/python/verwachting.ts
 */
import {
  BeleidLeeg,
  type KeuzeVraag,
  kiesProviders,
  ondertekenBeleid,
} from "../../beleid.ts";
import { AI_BELEID } from "../../ai-beleid.ts";

const nu = new Date("2026-11-15T12:00:00Z");
const later = new Date("2027-03-01T12:00:00Z");
const projecten = [
  undefined,
  "foodie",
  "eendje",
  "billara",
  "roundbook",
  "domus",
  "phyllox",
  "onbekend",
];
const types = [
  "tekst",
  "tools",
  "beeld-in",
  "audio-in",
  "beeld-uit",
  "tts",
] as const;
const gegevens = [undefined, "publiek", "persoon", "gezondheid"] as const;

const gevallen: unknown[] = [];
for (const moment of [nu, later]) {
  for (const project of projecten) {
    for (const type of types) {
      for (const g of gegevens) {
        for (const context of [undefined, "roundbook"]) {
          const vraag: KeuzeVraag = {
            type,
            project,
            gegevens: g,
            context,
            nu: moment,
          };
          let uitkomst: unknown;
          try {
            const u = kiesProviders(AI_BELEID, vraag);
            uitkomst = {
              volgorde: u.volgorde,
              gegevens: u.gegevens,
              voorrang: u.voorrang,
            };
          } catch (e) {
            if (!(e instanceof BeleidLeeg)) throw e;
            uitkomst = { leeg: e.stap };
          }
          gevallen.push({
            vraag: { type, project, gegevens: g, context },
            nu: moment.getTime() / 1000,
            uitkomst,
          });
        }
      }
    }
  }
}

const sleutels = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
]) as CryptoKeyPair;
const pkcs8 = btoa(
  String.fromCharCode(
    ...new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", sleutels.privateKey),
    ),
  ),
);
const publiek = btoa(
  String.fromCharCode(
    ...new Uint8Array(await crypto.subtle.exportKey("raw", sleutels.publicKey)),
  ),
);
const envelop = await ondertekenBeleid(AI_BELEID, pkcs8);

await Deno.writeTextFile(
  new URL("./verwachting.json", import.meta.url),
  JSON.stringify({ gevallen, publiek, envelop }) + "\n",
);
console.log(`${gevallen.length} gevallen geschreven`);
