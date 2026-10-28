import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  EMAIL_MAX_LENGTE,
  EMAIL_PATROON,
  isGeldigEmail,
  klantIp,
  LIMIET_MAX_VENSTER_MINUTEN,
  limietHit,
  metVasteDuur,
  normaliseerEmail,
  RATE_LIMIT_HIT_SQL,
  type RpcClient,
} from "./formulier.ts";

// ───────────── E-mail ─────────────

Deno.test("normaliseerEmail: trimt en zet in kleine letters", () => {
  assertEquals(
    normaliseerEmail("  Jan.Peeters@Example.BE "),
    "jan.peeters@example.be",
  );
  assertEquals(
    normaliseerEmail("a+b@sub.example.co.uk"),
    "a+b@sub.example.co.uk",
  );
  assertEquals(normaliseerEmail("o'neil@example.ie"), "o'neil@example.ie");
  assertEquals(normaliseerEmail("José.Ñ@Example.ES"), "josé.ñ@example.es");
  assertEquals(normaliseerEmail("a@xn--caf-dma.be"), "a@xn--caf-dma.be");
  assertEquals(normaliseerEmail("a.b.c@my-domain.co"), "a.b.c@my-domain.co");
});

Deno.test("normaliseerEmail: geen string is null", () => {
  for (const x of [undefined, null, 42, {}, [], true]) {
    assertEquals(normaliseerEmail(x), null);
  }
});

Deno.test("normaliseerEmail: ongeldige vormen", () => {
  for (
    const x of [
      "",
      "geen-apenstaart",
      "a@b",
      "a@b.",
      "a@.b",
      "a@b..c",
      "@b.c",
      "a@@b.c",
      "a b@c.de",
      "a@b c.de",
      "a\n@b.de",
      "a@b.de\r\nBcc: x@y.z",
      "<a@b.de>",
      'a"@b.de',
      "a,b@c.de",
      "a;b@c.de",
      "a@b.de;c@d.ef",
      "a\\b@c.de",
      "a@[1.2.3.4]",
      "a\u0000@b.de",
      "a\u007f@b.de",
      // Uit de review van 0.18.0: onzichtbare tekens en URL-tekens.
      "a\u200b@gmail.com",
      "a\u00ad@x.com",
      "a@x\u200b.com",
      "a\u202e@x.com",
      "a\u0085@x.com",
      "a\ufeff@x.com",
      "a@b.c/d?e",
      "a@b.c#d",
      "a@b_c.de",
      "a@café.be",
      ".a@x.yz",
      "a.@x.yz",
      "a..b@x.yz",
    ]
  ) {
    assertEquals(normaliseerEmail(x), null, JSON.stringify(x));
    assertEquals(isGeldigEmail(x), false);
  }
});

Deno.test("normaliseerEmail: lengte eerst, grens 254", () => {
  const lokaal = "a".repeat(64);
  const domein = (n: number) => "b".repeat(n - lokaal.length - 1 - 3) + ".be";
  const precies = `${lokaal}@${domein(EMAIL_MAX_LENGTE)}`;
  assertEquals(precies.length, 254);
  assertEquals(normaliseerEmail(precies), precies);
  const teLang = `${lokaal}@${domein(EMAIL_MAX_LENGTE + 1)}`;
  assertEquals(normaliseerEmail(teLang), null);
  // De lengte telt vóór de trim: geen grote invoer met spaties rond.
  assertEquals(normaliseerEmail(" ".repeat(300) + "a@b.be"), null);
  // En opnieuw na de kleine letters: İ wordt twee tekens.
  const turks = "İ".repeat(200) + "@b.be";
  assert(turks.length <= EMAIL_MAX_LENGTE);
  assertEquals(normaliseerEmail(turks), null);
});

Deno.test("EMAIL_PATROON: 20.000 punten blijven lineair", () => {
  const aanvallen = [
    "a@" + ".".repeat(20_000),
    "a@b" + ".".repeat(20_000),
    "a@" + "b.".repeat(10_000),
    "a@" + "b.".repeat(10_000) + "!",
    "a".repeat(20_000) + "@",
    "a@" + "b".repeat(20_000) + ".",
    "a@b" + ".c".repeat(10_000) + " ",
    "a.".repeat(10_000) + "@b.cd",
    "a." + ".".repeat(20_000) + "@b.cd",
  ];
  const start = performance.now();
  for (const x of aanvallen) {
    // Rechtstreeks op het patroon, zonder de lengtecontrole ervoor.
    EMAIL_PATROON.test(x);
    assertEquals(normaliseerEmail(x), null);
  }
  const duur = performance.now() - start;
  assert(duur < 250, `te traag: ${duur.toFixed(1)} ms`);
});

// ───────────── Klant-IP ─────────────

const kop = (waarde: string | null, extra: Record<string, string> = {}) => {
  const h = new Headers(extra);
  if (waarde !== null) h.set("cf-connecting-ip", waarde);
  return new Request("https://voorbeeld.test/", { headers: h });
};

Deno.test("klantIp: enkel cf-connecting-ip, nooit X-Forwarded-For", () => {
  assertEquals(klantIp(kop("203.0.113.7")), "203.0.113.7");
  assertEquals(klantIp(kop(" 203.0.113.7 ")), "203.0.113.7");
  assertEquals(
    klantIp(
      kop(null, { "x-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4" }),
    ),
    null,
  );
  assertEquals(
    klantIp(kop("203.0.113.7", { "x-forwarded-for": "1.2.3.4" })),
    "203.0.113.7",
  );
  // Ook met Headers in plaats van een Request.
  assertEquals(
    klantIp(new Headers({ "cf-connecting-ip": "198.51.100.1" })),
    "198.51.100.1",
  );
});

Deno.test("klantIp: ongeldige invoer is null", () => {
  for (
    const x of [
      "",
      "onbekend",
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      "01.2.3.4",
      "1.2.3.4, 5.6.7.8",
      "1:2:3:4:5:6:7:8:9",
      "1::2::3",
      ":::",
      "1:",
      "12345::",
      "fe80::1%eth0",
      "::1.2.3",
      "1:2:3:4:5:6:7:8::",
      "a".repeat(65),
    ]
  ) {
    assertEquals(klantIp(kop(x)), null, x);
  }
});

Deno.test("klantIp: IPv6 canoniek (RFC 5952)", () => {
  assertEquals(klantIp(kop("2001:DB8:0:0:0:0:0:1")), "2001:db8::1");
  assertEquals(
    klantIp(kop("2001:0db8:0000:0000:0001:0000:0000:0001")),
    "2001:db8::1:0:0:1",
  );
  assertEquals(klantIp(kop("2001:db8:0:1:1:1:1:1")), "2001:db8:0:1:1:1:1:1");
  assertEquals(klantIp(kop("::1")), "::1");
  assertEquals(klantIp(kop("::")), "::");
  assertEquals(klantIp(kop("1:2:3:4:5:6:7::")), "1:2:3:4:5:6:7:0");
  assertEquals(klantIp(kop("64:ff9b::192.0.2.33")), "64:ff9b::c000:221");
});

Deno.test("klantIp: IPv4 in IPv6-vorm wordt IPv4", () => {
  assertEquals(klantIp(kop("::ffff:192.0.2.1")), "192.0.2.1");
  assertEquals(klantIp(kop("::FFFF:c000:0201")), "192.0.2.1");
  assertEquals(
    klantIp(kop("::ffff:192.0.2.1"), { ipv6Per64: true }),
    "192.0.2.1",
  );
});

Deno.test("klantIp: ipv6Per64 geeft het /64-blok, zoals Postgres network()", () => {
  const blok = "2001:db8:1:2::/64";
  assertEquals(
    klantIp(kop("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), { ipv6Per64: true }),
    blok,
  );
  assertEquals(klantIp(kop("2001:DB8:1:2::1"), { ipv6Per64: true }), blok);
  assertEquals(
    klantIp(kop("2001:db8:0:0:1::"), { ipv6Per64: true }),
    "2001:db8::/64",
  );
  assertEquals(klantIp(kop("::1"), { ipv6Per64: true }), "::/64");
  // IPv4 blijft een enkel adres.
  assertEquals(klantIp(kop("203.0.113.7"), { ipv6Per64: true }), "203.0.113.7");
});

// ───────────── Limiet ─────────────

type Oproep = { fn: string; args: Record<string, unknown> };

function nepClient(
  antwoord: { data: unknown; error: unknown } | Error,
): RpcClient & { oproepen: Oproep[] } {
  const oproepen: Oproep[] = [];
  return {
    oproepen,
    rpc(fn, args) {
      oproepen.push({ fn, args });
      if (antwoord instanceof Error) throw antwoord;
      return Promise.resolve(antwoord);
    },
  };
}

const opties = {
  sleutel: "jan@example.be",
  eindpunt: "nieuwsbrief:adres",
  max: 3,
  vensterMinuten: 24 * 60,
};

Deno.test("limietHit: roept rate_limit_hit aan met een versluierde sleutel", async () => {
  const db = nepClient({ data: true, error: null });
  assertEquals(await limietHit(db, opties), true);
  assertEquals(db.oproepen.length, 1);
  const { fn, args } = db.oproepen[0];
  assertEquals(fn, "rate_limit_hit");
  assertEquals(args._endpoint, "nieuwsbrief:adres");
  assertEquals(args._max_requests, 3);
  assertEquals(args._window_minutes, 1440);
  // sha256("jan@example.be")
  const verwacht = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("jan@example.be"),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  assertEquals(args._key, verwacht);
});

Deno.test("limietHit: versluier uit en een eigen rpc-naam", async () => {
  const db = nepClient({ data: true, error: null });
  await limietHit(db, { ...opties, versluier: false, rpc: "eigen_limiet" });
  assertEquals(db.oproepen[0].fn, "eigen_limiet");
  assertEquals(db.oproepen[0].args._key, "jan@example.be");
});

Deno.test("limietHit: met peper is de sleutel een HMAC", async () => {
  const peper = "test-peper-niet-echt-0123456789abcdef";
  const db = nepClient({ data: true, error: null });
  assertEquals(await limietHit(db, { ...opties, peper }), true);
  const { createHmac } = await import("node:crypto");
  assertEquals(
    db.oproepen[0].args._key,
    createHmac("sha256", peper).update("jan@example.be").digest("hex"),
  );
});

Deno.test("limietHit: erover is false", async () => {
  assertEquals(
    await limietHit(nepClient({ data: false, error: null }), opties),
    false,
  );
});

Deno.test("limietHit: valt dicht bij fout, gooien of vreemd antwoord", async () => {
  for (
    const antwoord of [
      { data: true, error: { message: "boem" } },
      { data: null, error: null },
      { data: "true", error: null },
      { data: 1, error: null },
      new Error("netwerk weg"),
    ]
  ) {
    assertEquals(await limietHit(nepClient(antwoord), opties), false);
  }
});

Deno.test("limietHit: ongeldige opties zijn false zonder databank", async () => {
  const db = nepClient({ data: true, error: null });
  for (
    const fout of [
      { sleutel: null },
      { sleutel: undefined },
      { sleutel: "" },
      { eindpunt: "" },
      { max: 0 },
      { max: 2.5 },
      { max: Number.NaN },
      { vensterMinuten: 0 },
      { vensterMinuten: LIMIET_MAX_VENSTER_MINUTEN + 1 },
      { vensterMinuten: 1.5 },
      { max: 1_000_001 },
      { peper: "kort" },
      { peper: "" },
    ]
  ) {
    assertEquals(
      await limietHit(db, { ...opties, ...fout }),
      false,
      JSON.stringify(fout),
    );
  }
  assertEquals(db.oproepen.length, 0);
  // De grens zelf mag wel.
  assertEquals(
    await limietHit(db, {
      ...opties,
      vensterMinuten: LIMIET_MAX_VENSTER_MINUTEN,
    }),
    true,
  );
});

Deno.test("RATE_LIMIT_HIT_SQL is gelijk aan sql/rate_limit_hit.sql", async () => {
  const bestand = await Deno.readTextFile(
    new URL("./sql/rate_limit_hit.sql", import.meta.url),
  );
  assertEquals(bestand.replace(/\r\n/g, "\n"), RATE_LIMIT_HIT_SQL);
});

Deno.test("RATE_LIMIT_HIT_SQL: de afspraken staan erin", () => {
  const sql = RATE_LIMIT_HIT_SQL;
  for (
    const stuk of [
      "create table if not exists public.rate_limit_hits",
      "enable row level security",
      "security definer",
      "set search_path = ''",
      "pg_advisory_xact_lock(hashtext(_endpoint || ':' || _key))",
      "interval '25 hours'",
      "for update skip locked",
      "limit 500",
      "insert into public.rate_limit_hits (sleutel, endpoint)",
      "_window_minutes > 1500",
      "from public, anon, authenticated",
      "to service_role",
    ]
  ) {
    assert(sql.includes(stuk), stuk);
  }
  // Het venster in TS en in SQL blijft gelijk.
  assert(sql.includes(`_window_minutes > ${LIMIET_MAX_VENSTER_MINUTEN}`));
  // Geen em-dashes in wat een site letterlijk overneemt.
  assert(!sql.includes("—"));
});

// ───────────── Vaste duur ─────────────

Deno.test("metVasteDuur: wacht tot de minimumduur", async () => {
  const start = performance.now();
  assertEquals(await metVasteDuur(60, () => Promise.resolve("klaar")), "klaar");
  assert(performance.now() - start >= 55);
});

Deno.test("metVasteDuur: een fout komt pas na de wachttijd", async () => {
  const start = performance.now();
  await assertRejects(
    () => metVasteDuur(60, () => Promise.reject(new Error("mis"))),
    Error,
    "mis",
  );
  assert(performance.now() - start >= 55);
});

Deno.test("metVasteDuur: ongeldige minMs gooit", async () => {
  for (const ms of [Number.NaN, -1, Infinity]) {
    await assertRejects(
      () => metVasteDuur(ms, () => Promise.resolve(1)),
      RangeError,
    );
  }
});

Deno.test("metVasteDuur: traag werk wacht niet extra", async () => {
  const start = performance.now();
  await metVasteDuur(10, () => new Promise((r) => setTimeout(r, 50)));
  assert(performance.now() - start < 200);
});
