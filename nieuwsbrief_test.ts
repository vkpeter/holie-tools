import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  controleerResendHandtekening,
  isOneClickUitschrijving,
  leesResendGebeurtenis,
  uitgaveSleutel,
  uitschrijfKoppen,
  verdeelInBatches,
  verwerkResendWebhook,
} from "./nieuwsbrief.ts";

// Verzonnen geheim: 24 bytes, base64. Nooit een echt geheim in dit pakket.
const GEHEIM = "whsec_" + btoa("niet-echt-svix-geheim-24");
const NU = 1_793_530_000;

async function teken(id: string, tijd: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(GEHEIM.slice(6)), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      k,
      new TextEncoder().encode(`${id}.${tijd}.${body}`),
    ),
  );
  return "v1," + btoa(String.fromCharCode(...sig));
}

async function koppen(body: string, tijd = String(NU)): Promise<Headers> {
  return new Headers({
    "svix-id": "msg_1",
    "svix-timestamp": tijd,
    "svix-signature": await teken("msg_1", tijd, body),
  });
}

Deno.test("uitschrijfKoppen: https-link en one-click", () => {
  const k = uitschrijfKoppen("https://api.example.com/u?id=1&code=abc");
  assertEquals(
    k["List-Unsubscribe"],
    "<https://api.example.com/u?id=1&code=abc>",
  );
  assertEquals(k["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

Deno.test("uitschrijfKoppen: met mailto", () => {
  const k = uitschrijfKoppen("https://x.example/u", {
    mailto: "uit@example.com",
  });
  assertEquals(
    k["List-Unsubscribe"],
    "<https://x.example/u>, <mailto:uit@example.com?subject=uitschrijven>",
  );
});

Deno.test("uitschrijfKoppen: weigert http, kapotte url en vreemd mailto", () => {
  assertThrows(() => uitschrijfKoppen("http://x.example/u"));
  assertThrows(() => uitschrijfKoppen("geen url"));
  assertThrows(() =>
    uitschrijfKoppen("https://x.example/u", { mailto: "a@b>\r\nX: y" })
  );
});

Deno.test("isOneClickUitschrijving: formulier van de mailclient", () => {
  assert(
    isOneClickUitschrijving(
      "application/x-www-form-urlencoded",
      "List-Unsubscribe=One-Click",
    ),
  );
  assert(
    isOneClickUitschrijving(
      "multipart/form-data; boundary=x",
      '--x\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--x--',
    ),
  );
  assertFalse(
    isOneClickUitschrijving("application/json", "List-Unsubscribe=One-Click"),
  );
  assertFalse(
    isOneClickUitschrijving("application/x-www-form-urlencoded", "iets=anders"),
  );
  assertFalse(isOneClickUitschrijving(null, ""));
});

Deno.test("uitgaveSleutel: vast, volgorde telt, delen lopen niet in elkaar", async () => {
  const a = await uitgaveSleutel("digest", ["1", "2"]);
  assertEquals(a, await uitgaveSleutel("digest", ["1", "2"]));
  assert(/^digest:[0-9a-f]{24}$/.test(a));
  assert(a !== (await uitgaveSleutel("digest", ["2", "1"])));
  assert(
    (await uitgaveSleutel("x", ["a|b"])) !==
      (await uitgaveSleutel("x", ["a", "b"])),
  );
  let gegooid = false;
  try {
    await uitgaveSleutel("Met Spatie", []);
  } catch {
    gegooid = true;
  }
  assert(gegooid);
});

Deno.test("verdeelInBatches: stukken van 100 en geldige grootte", () => {
  const items = Array.from({ length: 250 }, (_, i) => i);
  assertEquals(verdeelInBatches(items).map((b) => b.length), [100, 100, 50]);
  assertEquals(verdeelInBatches([], 10), []);
  assertThrows(() => verdeelInBatches(items, 0));
});

Deno.test("controleerResendHandtekening: juist, fout, oud, zonder koppen", async () => {
  const body = '{"type":"email.bounced"}';
  assert(
    await controleerResendHandtekening(GEHEIM, await koppen(body), body, {
      nu: NU,
    }),
  );
  assertFalse(
    await controleerResendHandtekening(GEHEIM, await koppen(body), body + " ", {
      nu: NU,
    }),
  );
  assertFalse(
    await controleerResendHandtekening(
      GEHEIM,
      await koppen(body, String(NU - 400)),
      body,
      {
        nu: NU,
      },
    ),
  );
  assertFalse(
    await controleerResendHandtekening(GEHEIM, new Headers(), body, { nu: NU }),
  );
  assertFalse(
    await controleerResendHandtekening(undefined, await koppen(body), body, {
      nu: NU,
    }),
  );
  assertFalse(
    await controleerResendHandtekening("geen-whsec", await koppen(body), body, {
      nu: NU,
    }),
  );
});

Deno.test("controleerResendHandtekening: een van meerdere handtekeningen volstaat", async () => {
  const body = "{}";
  const h = await koppen(body);
  h.set("svix-signature", `v1,ongeldig ${h.get("svix-signature")}`);
  assert(await controleerResendHandtekening(GEHEIM, h, body, { nu: NU }));
});

Deno.test("leesResendGebeurtenis: bounce, tijdelijke bounce, klacht, andere", () => {
  assertEquals(
    leesResendGebeurtenis({
      type: "email.bounced",
      data: {
        to: ["A@Example.com"],
        email_id: "m1",
        bounce: { type: "Permanent" },
      },
    }),
    {
      type: "email.bounced",
      soort: "bounce",
      adressen: ["a@example.com"],
      mailId: "m1",
    },
  );
  assertEquals(
    leesResendGebeurtenis({
      type: "email.bounced",
      data: { to: ["a@example.com"], bounce: { type: "Transient" } },
    })?.soort,
    "andere",
  );
  assertEquals(
    leesResendGebeurtenis({
      type: "email.complained",
      data: { to: "b@example.com" },
    }),
    {
      type: "email.complained",
      soort: "klacht",
      adressen: ["b@example.com"],
      mailId: undefined,
    },
  );
  assertEquals(
    leesResendGebeurtenis({ type: "email.delivered", data: {} })?.soort,
    "andere",
  );
  assertEquals(leesResendGebeurtenis(null), null);
  assertEquals(leesResendGebeurtenis({ data: {} }), null);
});

Deno.test("verwerkResendWebhook: 401 zonder geldige handtekening, anders de gebeurtenis", async () => {
  const body = JSON.stringify({
    type: "email.complained",
    data: { to: ["c@example.com"] },
  });
  const goed = new Request("https://x.example/w", {
    method: "POST",
    headers: await koppen(body),
    body,
  });
  const r = await verwerkResendWebhook(goed, GEHEIM, { nu: NU });
  assert(r.ok);
  if (r.ok) assertEquals(r.gebeurtenis.adressen, ["c@example.com"]);

  const fout = new Request("https://x.example/w", { method: "POST", body });
  const r2 = await verwerkResendWebhook(fout, GEHEIM, { nu: NU });
  assertFalse(r2.ok);
  if (!r2.ok) assertEquals(r2.status, 401);
});
