import { assert, assertEquals } from "@std/assert";
import { createHash } from "node:crypto";
import {
  beantwoordKlik,
  bewerkTelegramBericht,
  controleerKnoppen,
  controleerWebhookGeheim,
  escapeHtml,
  gelijkeTekst,
  knipTekst,
  leidWebhookGeheimAf,
  pastAlsCallbackData,
  stuurNaarChats,
  stuurTelegramBericht,
  TELEGRAM_GEHEIM_HEADER,
  TELEGRAM_MAX_KLIKTEKST,
  telegramApi,
  zetTelegramKnoppen,
  zetWebhook,
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

// ── Knoppen toetsen (H8) ──

Deno.test("pastAlsCallbackData telt bytes, niet tekens", () => {
  assert(pastAlsCallbackData("a".repeat(64)));
  assertEquals(pastAlsCallbackData("a".repeat(65)), false);
  assertEquals(pastAlsCallbackData(""), false);
  // 16 emoji = 16 tekens maar 64 bytes; 17 is er een te veel.
  assert(pastAlsCallbackData("😀".repeat(16)));
  assertEquals(pastAlsCallbackData("😀".repeat(17)), false);
  // Een uuid met voorvoegsel, zoals Roundbook codeert: ruim binnen de grens.
  assert(pastAlsCallbackData("rba:11111111-2222-3333-4444-555555555555:j"));
});

Deno.test("controleerKnoppen: tekst, precies één doel, lengte", () => {
  assertEquals(
    controleerKnoppen([[{ text: "Ja", callback_data: "ja" }]]),
    null,
  );
  assertEquals(
    controleerKnoppen([[{ text: "Site", url: "https://x.test" }]]),
    null,
  );
  assert(controleerKnoppen([[{ text: "", callback_data: "x" }]]));
  assert(controleerKnoppen([[{ text: "Leeg" }]]));
  assert(
    controleerKnoppen([[{
      text: "Twee",
      callback_data: "x",
      url: "https://x.test",
    }]]),
  );
  const fout = controleerKnoppen([
    [{ text: "Ok", callback_data: "ok" }],
    [{ text: "Lang", callback_data: "x".repeat(65) }],
  ]);
  assert(fout?.includes("knop 2.1"));
  assert(fout?.includes("65 bytes"));
});

Deno.test("stuurTelegramBericht weigert een te lange callback_data zonder verzoek", async () => {
  const f = metAntwoorden({});
  try {
    const r = await stuurTelegramBericht(TOKEN, CHAT, "hoi", {
      knoppen: [[{ text: "Lang", callback_data: "x".repeat(65) }]],
    });
    assertEquals(r.ok, false);
    assertEquals(r.status, 0);
    assert(r.fout?.includes("callback_data"));
    assertEquals(f.aanroepen.length, 0);
  } finally {
    f.herstel();
  }
});

// ── Vast toetsenbord ──

Deno.test("toetsenbord gaat mee als reply_markup van het laatste deel", async () => {
  const f = metAntwoorden({});
  try {
    const toetsenbord = {
      keyboard: [[{ text: "📍 Hier", request_location: true }, {
        text: "Stop",
      }]],
      is_persistent: true,
      resize_keyboard: true,
    };
    const tekst = "a".repeat(4096) + "\n" + "b";
    const r = await stuurTelegramBericht(TOKEN, CHAT, tekst, { toetsenbord });
    assert(r.ok);
    assertEquals("reply_markup" in f.aanroepen[0].body, false);
    assertEquals(f.aanroepen[1].body.reply_markup, toetsenbord);
  } finally {
    f.herstel();
  }
});

Deno.test('toetsenbord "weg" verwijdert het vaste toetsenbord', async () => {
  const f = metAntwoorden({});
  try {
    await stuurTelegramBericht(TOKEN, CHAT, "klaar", { toetsenbord: "weg" });
    assertEquals(f.aanroepen[0].body.reply_markup, { remove_keyboard: true });
  } finally {
    f.herstel();
  }
});

Deno.test("knoppen en toetsenbord samen of een lege toetsenbordknop: geen verzoek", async () => {
  const f = metAntwoorden({});
  try {
    const samen = await stuurTelegramBericht(TOKEN, CHAT, "x", {
      knoppen: [[{ text: "a", callback_data: "a" }]],
      toetsenbord: { keyboard: [[{ text: "b" }]] },
    });
    assertEquals(samen.ok, false);
    const leeg = await stuurTelegramBericht(TOKEN, CHAT, "x", {
      toetsenbord: { keyboard: [[{ text: "" }]] },
    });
    assertEquals(leeg.ok, false);
    assertEquals(f.aanroepen.length, 0);
  } finally {
    f.herstel();
  }
});

// ── telegramApi (H9) ──

Deno.test("telegramApi geeft result terug en roept de juiste methode", async () => {
  const f = metAntwoorden({
    body: { ok: true, result: { url: "https://w.test" } },
  });
  try {
    const r = await telegramApi<{ url: string }>(TOKEN, "getWebhookInfo", {}, {
      apiBasis: "https://tg.test",
    });
    assert(r.ok);
    assertEquals(r.result?.url, "https://w.test");
    assertEquals(
      f.aanroepen[0].url,
      `https://tg.test/bot${TOKEN}/getWebhookInfo`,
    );
  } finally {
    f.herstel();
  }
});

Deno.test("telegramApi: geen token, rare methode, en een fout zonder token", async () => {
  const f = metAntwoorden({
    status: 401,
    body: { ok: false, description: `Unauthorized ${TOKEN}` },
  });
  try {
    assertEquals((await telegramApi("", "getMe", {})).ok, false);
    assertEquals((await telegramApi(TOKEN, "../getMe", {})).ok, false);
    assertEquals(f.aanroepen.length, 0);
    const r = await telegramApi(TOKEN, "getMe", {});
    assertEquals(r.ok, false);
    assertEquals(r.status, 401);
    assertEquals(r.fout?.includes(TOKEN), false);
    assert(r.fout?.includes("getMe"));
  } finally {
    f.herstel();
  }
});

Deno.test("telegramApi herkanst één keer na een korte 429", async () => {
  const f = metAntwoorden(
    { status: 429, body: { ok: false, parameters: { retry_after: 0 } } },
    { body: { ok: true, result: true } },
  );
  try {
    const r = await telegramApi(TOKEN, "answerCallbackQuery", {});
    assert(r.ok);
    assertEquals(f.aanroepen.length, 2);
  } finally {
    f.herstel();
  }
});

// ── Bewerken ──

Deno.test("bewerkTelegramBericht: HTML, knoppen standaard weg", async () => {
  const f = metAntwoorden({ body: { ok: true, result: {} } });
  try {
    const r = await bewerkTelegramBericht(TOKEN, CHAT, 55, "<b>Bevestigd</b>");
    assert(r.ok);
    assertEquals(f.aanroepen[0].url.endsWith("/editMessageText"), true);
    assertEquals(f.aanroepen[0].body.message_id, 55);
    assertEquals(f.aanroepen[0].body.parse_mode, "HTML");
    assertEquals(f.aanroepen[0].body.reply_markup, { inline_keyboard: [] });
  } finally {
    f.herstel();
  }
});

Deno.test("bewerkTelegramBericht houdt knoppen die je meegeeft", async () => {
  const f = metAntwoorden({ body: { ok: true, result: {} } });
  try {
    const knoppen = [[{ text: "Terug", callback_data: "terug" }]];
    await bewerkTelegramBericht(TOKEN, CHAT, 1, "x", {
      knoppen,
      parseMode: null,
    });
    assertEquals(f.aanroepen[0].body.reply_markup, {
      inline_keyboard: knoppen,
    });
    assertEquals("parse_mode" in f.aanroepen[0].body, false);
  } finally {
    f.herstel();
  }
});

Deno.test('bewerken: "message is not modified" telt als gelukt', async () => {
  const f = metAntwoorden({
    status: 400,
    body: {
      ok: false,
      description:
        "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
    },
  });
  try {
    const r = await bewerkTelegramBericht(TOKEN, CHAT, 1, "zelfde");
    assert(r.ok);
    assertEquals(r.ongewijzigd, true);
    const k = await zetTelegramKnoppen(TOKEN, CHAT, 1);
    assert(k.ok);
    assertEquals(k.ongewijzigd, true);
  } finally {
    f.herstel();
  }
});

Deno.test("bewerken: andere 400 is een fout; te lange of lege tekst gaat niet weg", async () => {
  const f = metAntwoorden({
    status: 400,
    body: { ok: false, description: "Bad Request: message to edit not found" },
  });
  try {
    const r = await bewerkTelegramBericht(TOKEN, CHAT, 1, "x");
    assertEquals(r.ok, false);
    assert(r.fout?.includes("not found"));
    assertEquals(f.aanroepen.length, 1);
    assertEquals((await bewerkTelegramBericht(TOKEN, CHAT, 1, "")).ok, false);
    assertEquals(
      (await bewerkTelegramBericht(TOKEN, CHAT, 1, "a".repeat(4097))).ok,
      false,
    );
    assertEquals(f.aanroepen.length, 1);
  } finally {
    f.herstel();
  }
});

Deno.test("zetTelegramKnoppen: standaard leeg, en toetst de knoppen", async () => {
  const f = metAntwoorden({ body: { ok: true, result: {} } });
  try {
    const r = await zetTelegramKnoppen(TOKEN, CHAT, 9);
    assert(r.ok);
    assertEquals(f.aanroepen[0].url.endsWith("/editMessageReplyMarkup"), true);
    assertEquals(f.aanroepen[0].body.reply_markup, { inline_keyboard: [] });
    const fout = await zetTelegramKnoppen(TOKEN, CHAT, 9, [[{ text: "x" }]]);
    assertEquals(fout.ok, false);
    assertEquals(f.aanroepen.length, 1);
  } finally {
    f.herstel();
  }
});

// ── Klik beantwoorden en webhook ──

Deno.test("beantwoordKlik: kaal, met tekst, geknipt op 200 tekens", async () => {
  const f = metAntwoorden({ body: { ok: true, result: true } });
  try {
    assert((await beantwoordKlik(TOKEN, "cb1")).ok);
    assertEquals(f.aanroepen[0].body, { callback_query_id: "cb1" });
    await beantwoordKlik(TOKEN, "cb2", { tekst: "x".repeat(300), alert: true });
    const tekst = f.aanroepen[1].body.text as string;
    assertEquals(tekst.length, TELEGRAM_MAX_KLIKTEKST);
    assert(tekst.endsWith("…"));
    assertEquals(f.aanroepen[1].body.show_alert, true);
    assertEquals((await beantwoordKlik(TOKEN, "")).ok, false);
    assertEquals(f.aanroepen.length, 2);
  } finally {
    f.herstel();
  }
});

Deno.test("zetWebhook: geheim, updates, en weigeringen zonder verzoek", async () => {
  const f = metAntwoorden({ body: { ok: true, result: true } });
  try {
    const geheim = await leidWebhookGeheimAf(TOKEN);
    const r = await zetWebhook(TOKEN, "https://w.test/hook", {
      geheim,
      updates: ["message", "callback_query"],
      wisWachtrij: true,
    });
    assert(r.ok);
    assertEquals(f.aanroepen[0].body, {
      url: "https://w.test/hook",
      secret_token: geheim,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    assertEquals((await zetWebhook(TOKEN, "http://w.test")).ok, false);
    assertEquals(
      (await zetWebhook(TOKEN, "https://w.test", { geheim: "met spatie" })).ok,
      false,
    );
    assertEquals(f.aanroepen.length, 1);
  } finally {
    f.herstel();
  }
});
