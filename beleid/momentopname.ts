/**
 * Schrijft `ai-beleid.ts` (de momentopname die met het pakket meegaat) uit
 * `beleid/ai-beleid.json`, of uit een opgegeven bestand:
 *
 *     deno task beleid                 # uit beleid/ai-beleid.json
 *     deno task beleid pad/naar.json   # uit een ander bestand
 *
 * De test `momentopname is gelijk aan het beleidsbestand` faalt als de twee uiteenlopen.
 */
import { valideerBeleid } from "../beleid.ts";

const bron = Deno.args[0] ?? new URL("./ai-beleid.json", import.meta.url);
const beleid = valideerBeleid(JSON.parse(await Deno.readTextFile(bron)));
const doel = new URL("../ai-beleid.ts", import.meta.url);
await Deno.writeTextFile(doel, bouwMomentopname(beleid));
console.log(
  `ai-beleid.ts geschreven: volgnummer ${beleid.volgnummer}, uitgegeven ${beleid.uitgegeven}`,
);

export function bouwMomentopname(beleid: unknown): string {
  return `/**
 * Momentopname van het AI-beleid, meegeleverd met het pakket als terugval wanneer het
 * beleidsadres onbereikbaar is. GEGENEREERD door \`deno task beleid\` uit
 * \`beleid/ai-beleid.json\`; niet met de hand bewerken.
 *
 * Gebruik: \`stelAiBeleidIn({ project: "foodie", momentopname: AI_BELEID })\`.
 *
 * @module
 */
import type { AiBeleid } from "./beleid.ts";

export const AI_BELEID: AiBeleid = ${JSON.stringify(beleid, null, 2)};
`;
}
