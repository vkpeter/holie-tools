/**
 * Ondertekent `beleid/ai-beleid.json` (of een opgegeven bestand) en zet het op het
 * beleidsadres. De privésleutel komt uit `HOLIE_AI_BELEID_SLEUTEL` (PKCS#8, base64).
 *
 *     deno task publiceer [pad/naar.json]
 *
 * De Worker weigert een volgnummer dat niet hoger is dan het huidige (409).
 */
import {
  BELEID_URL,
  controleerEnvelop,
  ondertekenBeleid,
  valideerBeleid,
} from "../beleid.ts";

const bron = Deno.args[0] ?? new URL("./ai-beleid.json", import.meta.url);
const beleid = valideerBeleid(JSON.parse(await Deno.readTextFile(bron)));
const sleutel = Deno.env.get("HOLIE_AI_BELEID_SLEUTEL");
if (!sleutel) throw new Error("HOLIE_AI_BELEID_SLEUTEL ontbreekt");
const envelop = await ondertekenBeleid(beleid, sleutel);
await controleerEnvelop(envelop); // past bij de publieke sleutel in het pakket?
const r = await fetch(BELEID_URL, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(envelop),
});
console.log(r.status, await r.text());
if (!r.ok) Deno.exit(1);
