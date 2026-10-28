import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  BEVESTIG_GELDIG_MS,
  escapeMarkdownV2,
  isDoorgestuurd,
  isPriveAfzender,
  knopWasAangeboden,
  leesBevestigKnop,
  leidWebhookGeheimAf,
  maakBevestigKnop,
  pastAlsCallbackData,
  priveAfzender,
  startParameter,
  TELEGRAM_MAX_CALLBACK_BYTES,
} from "./telegram.ts";

// Verzonnen waarden: nooit een echt token, geheim of chat-id in dit pakket.
const GEHEIM = "test-knopgeheim-niet-echt-0123456789";
const IK = 1000;
const ANDER = 2000;
const UUID = "0b5c3f0e-8d4a-4c1e-9a7b-3f2e1d0c9b8a";
const NU = Date.UTC(2026, 9, 28, 12, 0, 0);

// ───────────── Poort ─────────────

const bericht = (
  chat: Record<string, unknown>,
  from: Record<string, unknown> | undefined,
) => ({
  message: { chat, from, text: "hallo" },
});

Deno.test("priveAfzender: mens in zijn eigen privéchat", () => {
  assertEquals(
    priveAfzender(bericht({ id: IK, type: "private" }, { id: IK })),
    IK,
  );
  assert(isPriveAfzender(bericht({ id: IK, type: "private" }, { id: IK })));
  // Ids als string (sommige parsers) tellen ook.
  assertEquals(
    priveAfzender(bericht({ id: String(IK), type: "private" }, { id: IK })),
    IK,
  );
  assertEquals(
    priveAfzender({
      edited_message: { chat: { id: IK, type: "private" }, from: { id: IK } },
    }),
    IK,
  );
});

Deno.test("priveAfzender: groep, kanaal, ander lid of bot is null", () => {
  assertEquals(
    priveAfzender(bericht({ id: -100123, type: "group" }, { id: IK })),
    null,
  );
  assertEquals(
    priveAfzender(bericht({ id: -100123, type: "supergroup" }, { id: IK })),
    null,
  );
  assertEquals(
    priveAfzender(bericht({ id: -100123, type: "channel" }, undefined)),
    null,
  );
  assertEquals(
    priveAfzender(bericht({ id: IK, type: "private" }, { id: ANDER })),
    null,
  );
  assertEquals(
    priveAfzender(
      bericht({ id: IK, type: "private" }, { id: IK, is_bot: true }),
    ),
    null,
  );
  assertEquals(priveAfzender(bericht({ id: IK }, { id: IK })), null);
  assertEquals(priveAfzender(bericht({ type: "private" }, { id: IK })), null);
  assertEquals(priveAfzender(bericht({ id: IK, type: "private" }, {})), null);
  assertEquals(
    priveAfzender(bericht({ id: "abc", type: "private" }, { id: "abc" })),
    null,
  );
  for (const id of ["", 0, -5]) {
    assertEquals(
      priveAfzender(bericht({ id, type: "private" }, { id })),
      null,
      String(id),
    );
  }
  assertEquals(
    priveAfzender({ channel_post: { chat: { id: IK, type: "private" } } }),
    null,
  );
  assertEquals(priveAfzender({}), null);
  assertEquals(priveAfzender(null), null);
});

Deno.test("priveAfzender: knopklik telt de klikker, niet de chat", () => {
  const klik = (
    chat: Record<string, unknown> | undefined,
    from: Record<string, unknown>,
  ) => ({
    callback_query: { from, data: "x", message: chat ? { chat } : undefined },
  });
  assertEquals(
    priveAfzender(klik({ id: IK, type: "private" }, { id: IK })),
    IK,
  );
  // Een groepslid klikt op de knop onder het bericht van een ander.
  assertEquals(
    priveAfzender(klik({ id: -100123, type: "group" }, { id: ANDER })),
    null,
  );
  assertEquals(
    priveAfzender(klik({ id: IK, type: "private" }, { id: ANDER })),
    null,
  );
  // Inline-bericht zonder message: geen chat, dus nee.
  assertEquals(priveAfzender(klik(undefined, { id: IK })), null);
  // callback_query wint van een meegestuurde message.
  assertEquals(
    priveAfzender({
      message: { chat: { id: IK, type: "private" }, from: { id: IK } },
      callback_query: {
        from: { id: ANDER },
        message: { chat: { id: IK, type: "private" } },
      },
    }),
    null,
  );
});

Deno.test("isDoorgestuurd: nieuwe en oude velden", () => {
  assertEquals(isDoorgestuurd({ text: "gewoon" }), false);
  assertEquals(isDoorgestuurd(null), false);
  assertEquals(isDoorgestuurd("tekst"), false);
  for (
    const veld of [
      { forward_origin: { type: "user" } },
      { forward_from: { id: 1 } },
      { forward_from_chat: { id: -1 } },
      { forward_sender_name: "Verborgen" },
      { forward_date: 1700000000 },
      { is_automatic_forward: true },
    ]
  ) {
    assert(isDoorgestuurd({ text: "x", ...veld }), JSON.stringify(veld));
  }
  assertEquals(isDoorgestuurd({ is_automatic_forward: false }), false);
});

Deno.test("knopWasAangeboden: enkel data die onder het bericht stond", () => {
  const message = {
    reply_markup: {
      inline_keyboard: [[{ callback_data: "wis_ja:1" }, {
        callback_data: "wis_nee:1",
      }], [{ url: "https://x" }]],
    },
  };
  assert(knopWasAangeboden({ data: "wis_ja:1", message }));
  assert(knopWasAangeboden({ data: "wis_nee:1", message }));
  assertEquals(knopWasAangeboden({ data: "wis_ja:2", message }), false);
  assertEquals(knopWasAangeboden({ data: "", message }), false);
  assertEquals(knopWasAangeboden({ data: 5, message }), false);
  assertEquals(knopWasAangeboden({ data: "wis_ja:1" }), false);
  assertEquals(knopWasAangeboden({ data: "wis_ja:1", message: {} }), false);
  assertEquals(knopWasAangeboden(null), false);
});

Deno.test("startParameter: deeplink-parameter of null", () => {
  assertEquals(startParameter("/start abc_DEF-123"), "abc_DEF-123");
  assertEquals(startParameter("  /start@Mijn_bot abc  "), "abc");
  assertEquals(startParameter("/start " + "a".repeat(64)), "a".repeat(64));
  assertEquals(startParameter("/start " + "a".repeat(65)), null);
  assertEquals(startParameter("/start"), null);
  assertEquals(startParameter("/start a b"), null);
  assertEquals(startParameter("/start ab$cd"), null);
  assertEquals(startParameter("/starter abc"), null);
  assertEquals(startParameter("hallo /start abc"), null);
  assertEquals(startParameter(42), null);
  assertEquals(startParameter("/start " + " ".repeat(300) + "abc"), null);
});

// ───────────── Bevestigknop ─────────────

const knop = (extra: Partial<Parameters<typeof maakBevestigKnop>[0]> = {}) =>
  maakBevestigKnop({
    actie: "wis_ja",
    id: UUID,
    chatId: IK,
    geheim: GEHEIM,
    nu: NU,
    ...extra,
  });

Deno.test("bevestigknop: heen en terug", async () => {
  const data = await knop();
  assert(pastAlsCallbackData(data));
  assert(/^wis_ja:[0-9a-f-]{36}:[0-9a-z]+:[A-Za-z0-9_-]{8}$/.test(data), data);
  const uit = await leesBevestigKnop(data, {
    geheim: GEHEIM,
    chatId: IK,
    nu: NU + 1000,
  });
  assertEquals(uit.ok, true);
  if (uit.ok) {
    assertEquals(uit.actie, "wis_ja");
    assertEquals(uit.id, UUID);
    assertEquals(uit.vervaltOp.getTime(), NU + BEVESTIG_GELDIG_MS);
  }
  // Ook met het chat-id als string.
  assertEquals(
    (await leesBevestigKnop(data, {
      geheim: GEHEIM,
      chatId: String(IK),
      nu: NU,
    })).ok,
    true,
  );
});

Deno.test("bevestigknop: verlopen op en na de vervaltijd", async () => {
  const data = await knop({ geldigMs: 60_000 });
  const lees = (nu: number) =>
    leesBevestigKnop(data, { geheim: GEHEIM, chatId: IK, nu });
  assertEquals((await lees(NU + 59_000)).ok, true);
  assertEquals(await lees(NU + 60_000), { ok: false, reden: "verlopen" });
  assertEquals(await lees(NU + 24 * 3600_000), {
    ok: false,
    reden: "verlopen",
  });
  // Standaard: 10 minuten.
  const standaard = await knop();
  assertEquals(
    (await leesBevestigKnop(standaard, {
      geheim: GEHEIM,
      chatId: IK,
      nu: NU + 9 * 60_000,
    })).ok,
    true,
  );
  assertEquals(
    await leesBevestigKnop(standaard, {
      geheim: GEHEIM,
      chatId: IK,
      nu: NU + 10 * 60_000,
    }),
    { ok: false, reden: "verlopen" },
  );
  // Zonder `nu` geldt de klok: een knop uit 2026 is nu al verlopen of nog geldig, nooit vorm.
  assert(["verlopen", undefined].includes(
    (await leesBevestigKnop(data, { geheim: GEHEIM, chatId: IK }) as {
      reden?: string;
    }).reden,
  ));
});

Deno.test("bevestigknop: andere chat, ander geheim of geen geheim faalt", async () => {
  const data = await knop();
  assertEquals(
    await leesBevestigKnop(data, { geheim: GEHEIM, chatId: ANDER, nu: NU }),
    {
      ok: false,
      reden: "handtekening",
    },
  );
  assertEquals(
    await leesBevestigKnop(data, { geheim: GEHEIM + "x", chatId: IK, nu: NU }),
    {
      ok: false,
      reden: "handtekening",
    },
  );
  for (const geheim of [undefined, null, "", "kort"]) {
    assertEquals(await leesBevestigKnop(data, { geheim, chatId: IK, nu: NU }), {
      ok: false,
      reden: "handtekening",
    });
  }
  for (const chatId of [undefined, null, "abc"]) {
    assertEquals(
      await leesBevestigKnop(data, { geheim: GEHEIM, chatId, nu: NU }),
      {
        ok: false,
        reden: "handtekening",
      },
    );
  }
});

Deno.test("bevestigknop: gesjoemeld met actie, id, vervaltijd of handtekening", async () => {
  const data = await knop();
  const [actie, id, verval, sig] = data.split(":");
  const lees = (d: string) =>
    leesBevestigKnop(d, { geheim: GEHEIM, chatId: IK, nu: NU });
  const later = (parseInt(verval, 36) + 3600).toString(36);
  const andereSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  for (
    const vervalst of [
      `wis_nee:${id}:${verval}:${sig}`,
      `${actie}:${UUID.replace("0b5c", "0b5d")}:${verval}:${sig}`,
      `${actie}:${id}:${later}:${sig}`,
      `${actie}:${id}:${verval}:${andereSig}`,
    ]
  ) {
    assertEquals(
      await lees(vervalst),
      { ok: false, reden: "handtekening" },
      vervalst,
    );
  }
});

Deno.test("bevestigknop: verkeerde vorm", async () => {
  const data = await knop();
  const lees = (d: unknown) =>
    leesBevestigKnop(d, { geheim: GEHEIM, chatId: IK, nu: NU });
  for (
    const fout of [
      undefined,
      42,
      "",
      "wis:ja:1",
      `wis_ja:${UUID}`,
      data + ":extra",
      data.replace("wis_ja", "Wis_ja"),
      data.replace("wis_ja", "1wis"),
      data.slice(0, -1),
      data + "x",
      `wis_ja:id met spatie:abc:ABCDEFGH`,
      `wis_ja:${UUID}:ABC:ABCDEFGH`,
      "x".repeat(TELEGRAM_MAX_CALLBACK_BYTES + 1),
    ]
  ) {
    assertEquals(await lees(fout), { ok: false, reden: "vorm" }, String(fout));
  }
});

Deno.test("bevestigknop: past in 64 bytes, met een uuid 10 tekens actie", async () => {
  const lang = await knop({ actie: "a".repeat(10) });
  assert(new TextEncoder().encode(lang).length <= TELEGRAM_MAX_CALLBACK_BYTES);
  await assertRejects(() => knop({ actie: "a".repeat(16) }), Error, "max 64");
  // Met een kort id mag de actie 16 tekens zijn.
  assert(
    pastAlsCallbackData(await knop({ actie: "a".repeat(16), id: "12345" })),
  );
  // Ook na 2038, als de vervaltijd 7 tekens wordt.
  const ver = await knop({ actie: "a".repeat(10), nu: Date.UTC(2100, 0, 1) });
  assert(pastAlsCallbackData(ver));
});

Deno.test("bevestigknop: maak gooit bij ongeldige velden", async () => {
  for (
    const fout of [
      { actie: "" },
      { actie: "Wis" },
      { actie: "wis:ja" },
      { actie: "a".repeat(17) },
      { id: "" },
      { id: "a:b" },
      { id: "a".repeat(41) },
      { geheim: "kort" },
      { chatId: "abc" },
      { geldigMs: 0 },
      { geldigMs: -1 },
      { geldigMs: Number.NaN },
      { geldigMs: 7 * 24 * 3600_000 + 1 },
      { geldigMs: 1e18 },
    ]
  ) {
    await assertRejects(() =>
      knop(fout as Partial<Parameters<typeof maakBevestigKnop>[0]>)
    );
  }
});

Deno.test("bevestigknop: werkt met een afgeleid geheim", async () => {
  const geheim = await leidWebhookGeheimAf(
    "123456:TEST-token-niet-echt",
    "telegram-knop",
  );
  const data = await maakBevestigKnop({
    actie: "bel_ja",
    id: "42",
    chatId: IK,
    geheim,
    nu: NU,
  });
  assertEquals(
    (await leesBevestigKnop(data, { geheim, chatId: IK, nu: NU })).ok,
    true,
  );
});

// ───────────── MarkdownV2 ─────────────

Deno.test("escapeMarkdownV2: elk opmaakteken krijgt een backslash", () => {
  assertEquals(
    escapeMarkdownV2("_*[]()~`>#+-=|{}.!\\"),
    "\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\",
  );
  assertEquals(
    escapeMarkdownV2("Prijs: 3.50 euro (incl. btw)!"),
    "Prijs: 3\\.50 euro \\(incl\\. btw\\)\\!",
  );
  assertEquals(escapeMarkdownV2("gewone tekst"), "gewone tekst");
  assertEquals(escapeMarkdownV2(""), "");
});
