/**
 * POST/GET /verbruik van de beleids-Worker, met een nep-D1 (in het geheugen) en een nep-rate-limit.
 */
import { assertEquals } from "@std/assert";
import worker, { brusselseDag, regelFout } from "./worker.js";

type Rij = Record<string, string | number>;

function nepD1() {
  const rijen = new Map<string, Rij>();
  const storingen = new Map<string, Rij>();
  const db = {
    rijen,
    storingen,
    prepare(sql: string) {
      return {
        sql,
        args: [] as unknown[],
        bind(...args: unknown[]) {
          return { ...this, args };
        },
        all() {
          if (this.sql.includes("FROM storing")) {
            const [dag] = this.args as string[];
            return Promise.resolve({
              results: [...storingen.values()].filter((r) => r.dag === dag),
            });
          }
          const [van, tot] = this.args as string[];
          const results = [...rijen.values()].filter((r) =>
            String(r.dag) >= van && String(r.dag) <= tot
          );
          return Promise.resolve({ results });
        },
      };
    },
    batch(stmts: { sql: string; args: unknown[] }[]) {
      for (const s of stmts) {
        if (s.sql.includes("INTO storing")) {
          const [dag, provider, soort, project, aantal, status, tijd] = s
            .args as [string, string, string, string, number, number, string];
          const k = [dag, provider, soort, project].join("|");
          const oud = storingen.get(k);
          if (!oud) {
            storingen.set(k, {
              dag,
              provider,
              soort,
              project,
              aantal,
              status,
              eerste: tijd,
              laatste: tijd,
            });
          } else {
            oud.aantal = Number(oud.aantal) + aantal;
            oud.status = status;
            oud.laatste = tijd;
          }
          continue;
        }
        const [dag, project, provider, type, aanroepen, usd, t, z, f, tijd] = s
          .args as [
            string,
            string,
            string,
            string,
            number,
            number,
            number,
            number,
            number,
            string,
          ];
        const k = [dag, project, provider, type].join("|");
        const oud = rijen.get(k);
        if (!oud) {
          rijen.set(k, {
            dag,
            project,
            provider,
            type,
            aanroepen,
            usd,
            terugval: t,
            zonder_label: z,
            fouten: f,
            bijgewerkt: tijd,
          });
        } else if (Number(oud.usd) + usd <= 500) {
          oud.aanroepen = Number(oud.aanroepen) + aanroepen;
          oud.usd = Number(oud.usd) + usd;
          oud.terugval = Number(oud.terugval) + t;
          oud.zonder_label = Number(oud.zonder_label) + z;
          oud.fouten = Number(oud.fouten) + f;
        }
      }
      return Promise.resolve([]);
    },
  };
  return db;
}

function env(limiet = true) {
  return {
    VERBRUIK: nepD1(),
    VERBRUIK_LEESSLEUTEL: "lees-geheim",
    VERBRUIK_LIMIET: {
      limit: () => Promise.resolve({ success: limiet }),
    },
  };
}

const regel = (extra: Record<string, unknown> = {}) => ({
  dag: brusselseDag(),
  project: "foodie",
  provider: "anthropic",
  type: "tekst",
  aanroepen: 2,
  usd: 0.01,
  terugval: 0,
  zonder_label: 1,
  fouten: 0,
  ...extra,
});

const post = (e: unknown, body: unknown) =>
  worker.fetch(
    new Request("https://beleid.holie.be/verbruik", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e,
    { waitUntil() {} },
  );

const lees = (e: unknown, sleutel?: string) =>
  worker.fetch(
    new Request("https://beleid.holie.be/verbruik", {
      headers: sleutel ? { authorization: `Bearer ${sleutel}` } : {},
    }),
    e,
    { waitUntil() {} },
  );

Deno.test("POST /verbruik telt op per dag, project, provider en type", async () => {
  const e = env();
  assertEquals((await post(e, { v: "0.26.0", regels: [regel()] })).status, 200);
  assertEquals((await post(e, { regels: [regel()] })).status, 200);
  const rij = [...e.VERBRUIK.rijen.values()];
  assertEquals(rij.length, 1);
  assertEquals(rij[0].aanroepen, 4);
  assertEquals(rij[0].zonder_label, 2);
});

Deno.test("POST /verbruik weigert onzin", async () => {
  const e = env();
  for (
    const slecht of [
      "geen json",
      {},
      { regels: [] },
      { regels: Array(51).fill(regel()) },
      { regels: [regel({ project: "Foodie!" })] },
      { regels: [regel({ type: "telepathie" })] },
      { regels: [regel({ usd: 51 })] },
      { regels: [regel({ usd: -1 })] },
      { regels: [regel({ aanroepen: 0 })] },
      { regels: [regel({ fouten: 3 })] },
      { regels: [regel({ dag: "2020-01-01" })] },
    ]
  ) {
    assertEquals((await post(e, slecht)).status, 400, JSON.stringify(slecht));
  }
  assertEquals(e.VERBRUIK.rijen.size, 0);
});

Deno.test("POST /verbruik: te groot en rate limit", async () => {
  const e = env();
  const groot = JSON.stringify({
    regels: [regel()],
    vulsel: "x".repeat(17000),
  });
  assertEquals((await post(e, groot)).status, 413);
  assertEquals((await post(env(false), { regels: [regel()] })).status, 429);
});

Deno.test("plafond per dag: boven USD 500 telt niets meer bij", async () => {
  const e = env();
  for (let i = 0; i < 12; i++) {
    await post(e, { regels: [regel({ usd: 50 })] });
  }
  const rij = [...e.VERBRUIK.rijen.values()][0];
  assertEquals(rij.usd, 500);
});

Deno.test("GET /verbruik vraagt de leessleutel", async () => {
  const e = env();
  await post(e, { regels: [regel()] });
  assertEquals((await lees(e)).status, 401);
  assertEquals((await lees(e, "fout")).status, 401);
  const r = await lees(e, "lees-geheim");
  assertEquals(r.status, 200);
  const data = await r.json();
  assertEquals(data.regels.length, 1);
  // zonder ingestelde sleutel: dicht
  assertEquals(
    (await lees({ ...e, VERBRUIK_LEESSLEUTEL: "" }, "")).status,
    401,
  );
});

const leesStoring = (e: unknown, sleutel?: string, query = "") =>
  worker.fetch(
    new Request(`https://beleid.holie.be/storing${query}`, {
      headers: sleutel ? { authorization: `Bearer ${sleutel}` } : {},
    }),
    e,
    { waitUntil() {} },
  );

Deno.test("POST /verbruik met storingen schrijft in de tabel storing", async () => {
  const e = env();
  const st = [
    { provider: "anthropic", soort: "tegoed", status: 400, aantal: 2 },
    { provider: "deepseek", soort: "fout", status: 0, aantal: 1 },
  ];
  assertEquals(
    (await post(e, { regels: [regel({ storingen: st })] })).status,
    200,
  );
  const nog = {
    provider: "anthropic",
    soort: "tegoed",
    status: 402,
    aantal: 3,
  };
  assertEquals(
    (await post(e, { regels: [regel({ storingen: [nog] })] })).status,
    200,
  );
  assertEquals(e.VERBRUIK.storingen.size, 2);
  const a = e.VERBRUIK.storingen.get(
    [brusselseDag(), "anthropic", "tegoed", "foodie"].join("|"),
  )!;
  assertEquals(a.aantal, 5);
  assertEquals(a.status, 402);
  // zonder storingen blijft de tabel leeg en de regel werkt gewoon
  const e2 = env();
  assertEquals((await post(e2, { regels: [regel()] })).status, 200);
  assertEquals(e2.VERBRUIK.storingen.size, 0);
});

Deno.test("POST /verbruik weigert slechte storingen", async () => {
  const e = env();
  const goed = { provider: "anthropic", soort: "fout", status: 429, aantal: 1 };
  for (
    const slecht of [
      "geen array",
      [{ ...goed, provider: "Anthropic!" }],
      [{ ...goed, provider: 5 }],
      [{ ...goed, soort: "boos" }],
      [{ ...goed, aantal: 0 }],
      [{ ...goed, aantal: 100001 }],
      [{ ...goed, aantal: 1.5 }],
      [{ ...goed, status: 1000 }],
      [{ ...goed, status: -1 }],
      Array(11).fill(goed),
      [null],
    ]
  ) {
    assertEquals(
      (await post(e, { regels: [regel({ storingen: slecht })] })).status,
      400,
      JSON.stringify(slecht),
    );
  }
  assertEquals(e.VERBRUIK.rijen.size, 0);
  assertEquals(e.VERBRUIK.storingen.size, 0);
});

Deno.test("GET /storing vraagt de leessleutel en geeft de rijen van de dag", async () => {
  const e = env();
  const st = { provider: "anthropic", soort: "tegoed", status: 400, aantal: 2 };
  await post(e, { regels: [regel({ storingen: [st] })] });
  assertEquals((await leesStoring(e)).status, 401);
  assertEquals((await leesStoring(e, "fout")).status, 401);
  const r = await leesStoring(e, "lees-geheim");
  assertEquals(r.status, 200);
  const data = await r.json();
  assertEquals(data.storingen.length, 1);
  assertEquals(data.storingen[0].provider, "anthropic");
  assertEquals(data.storingen[0].aantal, 2);
  const leeg = await (await leesStoring(e, "lees-geheim", "?dag=2020-01-01"))
    .json();
  assertEquals(leeg.storingen, []);
  assertEquals(
    (await leesStoring(e, "lees-geheim", "?dag=morgen")).status,
    400,
  );
});

Deno.test("regelFout: venster van twee dagen terug tot morgen", () => {
  const nu = Date.parse("2026-11-01T12:00:00Z");
  assertEquals(regelFout(regel({ dag: "2026-10-30" }), nu), null);
  assertEquals(regelFout(regel({ dag: "2026-11-02" }), nu), null);
  assertEquals(
    regelFout(regel({ dag: "2026-10-29" }), nu),
    "dag buiten venster",
  );
  assertEquals(
    regelFout(regel({ dag: "2026-11-03" }), nu),
    "dag buiten venster",
  );
});

Deno.test("/lezers en /historie vragen de leessleutel, / toont geen padenlijst", async () => {
  const kv = new Map<string, string>([["historie:14", "{}"], [
    "lezer:x",
    '{"project":"x"}',
  ]]);
  const env = {
    VERBRUIK_LEESSLEUTEL: "geheim",
    BELEID: {
      get: (k: string) => Promise.resolve(kv.get(k) ?? null),
      list: () => Promise.resolve({ keys: [{ name: "lezer:x" }] }),
    },
  };
  const ctx = { waitUntil() {} };
  const vraag = (pad: string, h: Record<string, string> = {}) =>
    worker.fetch(
      new Request(`https://beleid.test${pad}`, { headers: h }),
      env,
      ctx,
    );
  for (const pad of ["/lezers", "/historie/14"]) {
    assertEquals((await vraag(pad)).status, 401);
    assertEquals(
      (await vraag(pad, { authorization: "Bearer fout" })).status,
      401,
    );
    assertEquals(
      (await vraag(pad, { authorization: "Bearer geheim" })).status,
      200,
    );
  }
  const wortel = await vraag("/");
  assertEquals(wortel.status, 404);
  assertEquals((await wortel.text()).includes("lezers"), false);
});
