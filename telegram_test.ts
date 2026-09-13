import { assert, assertEquals } from "@std/assert";
import { createHash } from "node:crypto";
import {
  controleerWebhookGeheim,
  escapeHtml,
  gelijkeTekst,
  knipTekst,
  leidWebhookGeheimAf,
  stuurNaarChats,
  stuurTelegramBericht,
  TELEGRAM_GEHEIM_HEADER,
} from "./telegram.ts";

// Verzonnen waarden: nooit een echt token of chat-id in dit pakket.
const TOKEN = "123456:TEST-token-niet-echt";
const CHAT = "1000";

type Antwoord = {
  status?: number;
  body?: unknown;
  gooi?: Error;
};

function metAntwoorden(...antwoorden: Antwoord[]) {
  const aanroepen: { url: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const origineel = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    aanroepen.push({ url, body: JSON.parse(String(init.body)) });
    const a = antwoorden[Math.min(i++, antwoorden.length - 1)];
    if (a.gooi) return Promise.reject(a.gooi);
    return Promise.resolve(
      new Response(
        JSON.stringify(
          a.body ?? { ok: true, result: { message_id: 100 + i } },
        ),
        { status: a.status ?? 200 },
      ),
    );
  }) as typeof fetch;
  return { aanroepen, herstel: () => (globalThis.fetch = origineel) };
}

Deno.test("escapeHtml escapet &, <, > en aanhalingstekens", () => {
  assertEquals(
    escapeHtml(`<b>"a" & b</b>`),
    "&lt;b&gt;&quot;a&quot; &amp; b&lt;/b&gt;",
  );
});

Deno.test("knipTekst knipt bij voorkeur op een regeleinde", () => {
  assertEquals(knipTekst("aaaa\nbbbb\ncc", 9), ["aaaa\nbbbb", "cc"]);
  assertEquals(knipTekst("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assertEquals(knipTekst("", 10), [""]);
});

Deno.test("stuurt standaard HTML zonder linkvoorbeeld", async () => {
  const f = metAntwoorden({});
  try {
    const r = await stuurTelegramBericht(TOKEN, CHAT, "hoi", {
      apiBasis: "https://tg.test",
    });
    assert(r.ok);
    assertEquals(r.messageIds, [101]);
    assertEquals(f.aanroepen[0].url, `https://tg.test/bot${TOKEN}/sendMessage`);
    assertEquals(f.aanroepen[0].body.parse_mode, "HTML");
    assertEquals(f.aanroepen[0].body.disable_web_page_preview, true);
    assertEquals(f.aanroepen[0].body.chat_id, CHAT);
  } finally {
    f.herstel();
  }
});

Deno.test("parseMode null stuurt platte tekst", async () => {
  const f = metAntwoorden({});
  try {
    await stuurTelegramBericht(TOKEN, CHAT, "hoi", { parseMode: null });
    assertEquals("parse_mode" in f.aanroepen[0].body, false);
  } finally {
    f.herstel();
  }
});

Deno.test("een lang bericht gaat in delen, knoppen onder het laatste, antwoord op het eerste", async () => {
  const f = metAntwoorden({});
  try {
    const tekst = "a".repeat(4096) + "\n" + "b".repeat(10);
    const r = await stuurTelegramBericht(TOKEN, CHAT, tekst, {
      antwoordOp: 7,
      knoppen: [[{ text: "Ja", callback_data: "ja" }]],
    });
    assert(r.ok);
    assertEquals(f.aanroepen.length, 2);
    assertEquals(f.aanroepen[0].body.reply_to_message_id, 7);
    assertEquals("reply_markup" in f.aanroepen[0].body, false);
    assertEquals("reply_to_message_id" in f.aanroepen[1].body, false);
    assert("reply_markup" in f.aanroepen[1].body);
  } finally {
    f.herstel();
  }
});

Deno.test("een 429 met korte retry_after krijgt één herkansing", async () => {
  const f = metAntwoorden(
    {
      status: 429,
      body: { ok: false, parameters: { retry_after: 0 } },
    },
    {},
  );
  try {
    const r = await stuurTelegramBericht(TOKEN, CHAT, "hoi");
    assert(r.ok);
    assertEquals(f.aanroepen.length, 2);
  } finally {
    f.herstel();
  }
});

Deno.test("een 429 met lange retry_after geeft op", async () => {
  const f = metAntwoorden({
    status: 429,
    body: {
      ok: false,
      description: "Too Many",
      parameters: { retry_after: 60 },
    },
  });
  try {
    const r = await stuurTelegramBericht(TOKEN, CHAT, "hoi");
    assertEquals(r.ok, false);
    assertEquals(r.status, 429);
    assertEquals(f.aanroepen.length, 1);
  } finally {
    f.herstel();
  }
});

Deno.test("een foutmelding bevat nooit het token", async () => {
  const f = metAntwoorden({
    gooi: new TypeError(
      `error sending request for url (https://api.telegram.org/bot${TOKEN}/sendMessage)`,
    ),
  });
  try {
    const r = await stuurTelegramBericht(TOKEN, CHAT, "hoi");
    assertEquals(r.ok, false);
    assert(r.fout);
    assertEquals(r.fout.includes(TOKEN), false);
    assert(r.fout.includes("<token>"));
  } finally {
    f.herstel();
  }
});

Deno.test("zonder token of chat-id wordt er niets verstuurd", async () => {
  const f = metAntwoorden({});
  try {
    assertEquals((await stuurTelegramBericht("", CHAT, "x")).ok, false);
    assertEquals((await stuurTelegramBericht(TOKEN, "", "x")).ok, false);
    assertEquals(f.aanroepen.length, 0);
  } finally {
    f.herstel();
  }
});

Deno.test("stuurNaarChats telt enkel de bereikte chats", async () => {
  const f = metAntwoorden({}, { status: 403, body: { ok: false } }, {});
  try {
    const r = await stuurNaarChats(TOKEN, ["1", "2", "3"], "hoi");
    assertEquals(r.bereikt, 2);
    assertEquals(r.resultaten[1].status, 403);
  } finally {
    f.herstel();
  }
});

Deno.test("controleerWebhookGeheim: juist, fout, ontbrekend", () => {
  const req = (geheim?: string) =>
    new Request("https://x.test", {
      method: "POST",
      headers: geheim ? { [TELEGRAM_GEHEIM_HEADER]: geheim } : {},
    });
  assert(controleerWebhookGeheim(req("abc"), "abc"));
  assertEquals(controleerWebhookGeheim(req("abd"), "abc"), false);
  assertEquals(controleerWebhookGeheim(req(), "abc"), false);
  // Zonder verwacht geheim nooit open, ook niet met een lege header.
  assertEquals(controleerWebhookGeheim(req(), ""), false);
  assertEquals(controleerWebhookGeheim(req("x"), undefined), false);
});

Deno.test("gelijkeTekst vergelijkt ook verschillende lengtes correct", () => {
  assert(gelijkeTekst("abc", "abc"));
  assertEquals(gelijkeTekst("abc", "abcd"), false);
  assertEquals(gelijkeTekst("", "a"), false);
});

Deno.test("leidWebhookGeheimAf is gelijk aan de Node-afleiding van Eagle-Eye", async () => {
  const verwacht = createHash("sha256")
    .update(`telegram-webhook:${TOKEN}`)
    .digest("base64url");
  const geheim = await leidWebhookGeheimAf(TOKEN);
  assertEquals(geheim, verwacht);
  assert(/^[A-Za-z0-9_-]{1,256}$/.test(geheim));
});
