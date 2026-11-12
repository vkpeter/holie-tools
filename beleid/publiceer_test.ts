// `deno task publiceer --uit-tickbook` tegen een nep-Tickbook en een nep-beleidsadres.
// Er gaat geen aanroep naar beleid.holie.be of api.tickbook.eu.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { AI_BELEID } from "../ai-beleid.ts";
import { type BeleidEnvelop, controleerEnvelop } from "../beleid.ts";
import { publiceerUitTickbook } from "./publiceer.ts";

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

async function opzet(opties: { putStatus?: number } = {}) {
  const paar = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const publiek = b64(await crypto.subtle.exportKey("raw", paar.publicKey));
  const prive = b64(await crypto.subtle.exportKey("pkcs8", paar.privateKey));
  const concept = { ...structuredClone(AI_BELEID), volgnummer: 9 };
  const nep = { puts: [] as BeleidEnvelop[], bevestigd: 0, conceptGevraagd: 0 };
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url === "https://nep-tickbook.test") {
      if (body.actie === "laptop_concept") {
        const sleutel = await crypto.subtle.importKey(
          "raw",
          Uint8Array.from(atob(publiek), (c) => c.charCodeAt(0)),
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        const ok = await crypto.subtle.verify(
          { name: "Ed25519" },
          sleutel,
          Uint8Array.from(atob(body.handtekening), (c) => c.charCodeAt(0)),
          new TextEncoder().encode(`ai-beleid:concept:${body.tijd}`),
        );
        if (!ok) {
          return Response.json({ error: "handtekening" }, { status: 401 });
        }
        nep.conceptGevraagd++;
        return Response.json({
          volgnummer: 9,
          inhoud: concept,
          wijzigingen: [{ volgnummer: 9, reden: "toets", wie: "Peter" }],
        });
      }
      if (body.actie === "laptop_bevestig") {
        await controleerEnvelop(body.envelop, publiek);
        nep.bevestigd++;
        return Response.json({
          ok: true,
          live_volgnummer: 9,
          status: "gepubliceerd",
        });
      }
    }
    if (
      url === "https://nep-beleid.test/ai-beleid.json" && init?.method === "PUT"
    ) {
      nep.puts.push(body);
      return Response.json({ ok: true }, { status: opties.putStatus ?? 200 });
    }
    throw new Error(`onverwachte fetch naar ${url}`);
  }) as typeof fetch;
  const run = (droog = false) =>
    publiceerUitTickbook({
      sleutel: prive,
      publiekeSleutel: publiek,
      fetch: f,
      tickbook: "https://nep-tickbook.test",
      beleidUrl: "https://nep-beleid.test/ai-beleid.json",
      droog,
      log: () => {},
    });
  return { nep, run, publiek };
}

Deno.test("--uit-tickbook: concept ophalen met handtekening, tekenen, PUT, bevestigen", async () => {
  const { nep, run, publiek } = await opzet();
  const uit = await run();
  assertEquals(uit, { volgnummer: 9, gepubliceerd: true, bevestigd: true });
  assertEquals(nep.puts.length, 1);
  assertEquals((await controleerEnvelop(nep.puts[0], publiek)).volgnummer, 9);
  assertEquals(nep.bevestigd, 1);
});

Deno.test("--uit-tickbook --droog publiceert niets", async () => {
  const { nep, run } = await opzet();
  const uit = await run(true);
  assertEquals(uit.gepubliceerd, false);
  assertEquals(nep.conceptGevraagd, 1);
  assertEquals(nep.puts.length, 0);
});

Deno.test("--uit-tickbook: weigering van het adres = fout, geen bevestiging", async () => {
  const { nep, run } = await opzet({ putStatus: 409 });
  await assertRejects(() => run(), Error, "HTTP 409");
  assertEquals(nep.bevestigd, 0);
  assert(nep.puts.length === 1);
});
