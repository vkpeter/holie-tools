import { assertEquals, assertRejects } from "@std/assert";
import {
  claimMetVenster,
  eindRun,
  geefClaimVrij,
  RUN_TTL_MS,
  startRun,
} from "./runslot.ts";

/** Een nep-client die de ketting van supabase-js naspeelt en elke stap logt. */
function nepDb(
  insertAntwoord: { data: unknown; error: unknown },
  updateFout: unknown = null,
  updateData: unknown = undefined,
) {
  const log: unknown[] = [];
  const keten = (stappen: unknown[], eind: unknown) => {
    const k: Record<string, unknown> = {};
    for (const m of ["eq", "is", "lt", "or", "not", "select"]) {
      k[m] = (...a: unknown[]) => {
        stappen.push([m, ...a]);
        return k;
      };
    }
    k.single = () => Promise.resolve(eind);
    k.then = (ok: (w: unknown) => unknown) => Promise.resolve(eind).then(ok);
    return k;
  };
  const db = {
    from(tabel: string) {
      return {
        update(velden: unknown) {
          const stappen: unknown[] = [["update", tabel, velden]];
          log.push(stappen);
          return keten(stappen, { data: updateData, error: updateFout });
        },
        insert(rij: unknown) {
          const stappen: unknown[] = [["insert", tabel, rij]];
          log.push(stappen);
          return keten(stappen, insertAntwoord);
        },
      };
    },
  };
  return { db, log };
}

Deno.test("startRun: vrije slot geeft een runId en ruimt eerst afgebroken runs op", async () => {
  const { db, log } = nepDb({ data: { id: "r1" }, error: null });
  const voor = Date.now();
  assertEquals(await startRun(db, "duiden"), { runId: "r1", albezig: false });

  const [opruim, insert] = log as unknown[][][];
  assertEquals(opruim[0][0], "update");
  assertEquals(opruim[0][1], "cron_runs");
  assertEquals(opruim[1], ["eq", "job", "duiden"]);
  assertEquals(opruim[2], ["is", "finished_at", null]);
  const grens = Date.parse((opruim[3] as string[])[2]);
  assertEquals(Math.abs(grens - (voor - RUN_TTL_MS)) < 5000, true);
  assertEquals(insert[0], ["insert", "cron_runs", { job: "duiden" }]);
});

Deno.test("startRun: unieke-sleutelschending is albezig, geen fout", async () => {
  const { db } = nepDb({ data: null, error: { code: "23505" } });
  assertEquals(await startRun(db, "x"), { runId: null, albezig: true });
});

Deno.test("startRun: een andere fout wordt gegooid, niet ingeslikt", async () => {
  const { db } = nepDb({
    data: null,
    error: { code: "42P01", message: "geen tabel" },
  });
  await assertRejects(() => startRun(db, "x"));
});

Deno.test("startRun: eigen tabel en termijn", async () => {
  const { db, log } = nepDb({ data: { id: "r2" }, error: null });
  await startRun(db, "x", { tabel: "podcast_runs", ttlMs: 60_000 });
  const opruim = (log as unknown[][][])[0];
  assertEquals((opruim[0] as unknown[])[1], "podcast_runs");
  assertEquals(
    ((opruim[0] as unknown[])[2] as { note: string }).note,
    "afgebroken: geen finished_at binnen 1 minuten",
  );
});

Deno.test("eindRun zet finished_at en gooit bij een fout", async () => {
  const goed = nepDb({ data: null, error: null });
  await eindRun(goed.db, "r1", { note: "klaar" });
  const stappen = (goed.log as unknown[][][])[0];
  const velden = (stappen[0] as unknown[])[2] as Record<string, unknown>;
  assertEquals(velden.note, "klaar");
  assertEquals(typeof velden.finished_at, "string");
  assertEquals(stappen[1], ["eq", "id", "r1"]);

  const fout = nepDb({ data: null, error: null }, { message: "boem" });
  await assertRejects(() => eindRun(fout.db, "r1"));
});

const OPTIES = {
  tabel: "client_member",
  kolom: "laatste_herstel_op",
  sleutel: { email: "a@b.be" },
};

Deno.test("claimMetVenster: zonder venster is het eenmalig (is null), geen or", async () => {
  const { db, log } = nepDb({ data: null, error: null }, null, [{ id: 1 }]);
  const claim = await claimMetVenster(db, OPTIES);
  assertEquals(claim.geclaimd, true);

  const stappen = (log as unknown[][][])[0];
  assertEquals(stappen[0][0], "update");
  assertEquals(stappen[0][1], "client_member");
  assertEquals(stappen[0][2], { laatste_herstel_op: claim.stempel });
  assertEquals(stappen.some((s) => s[0] === "or"), false);
  assertEquals(stappen.some((s) => s[0] === "lt"), false);
  assertEquals(stappen[stappen.length - 2], ["is", "laatste_herstel_op", null]);
});

Deno.test("claimMetVenster: met venster de juiste or-tekst met aanhalingstekens", async () => {
  const { db, log } = nepDb({ data: null, error: null }, null, [{ id: 1 }]);
  const voor = Date.now();
  const venster = 10 * 60 * 1000;
  await claimMetVenster(db, { ...OPTIES, vensterMs: venster });

  const stappen = (log as unknown[][][])[0];
  assertEquals(stappen.some((s) => s[0] === "is"), false);
  const or = stappen.find((s) => s[0] === "or") as string[];
  const m = or[1].match(
    /^laatste_herstel_op\.is\.null,laatste_herstel_op\.lt\."([^"]+)"$/,
  );
  assertEquals(m !== null, true);
  const grens = Date.parse(m![1]);
  assertEquals(Math.abs(grens - (voor - venster)) < 5000, true);
});

Deno.test("claimMetVenster: keten loopt update, sleutel-eq's, extra, remfilter, select", async () => {
  const { db, log } = nepDb({ data: null, error: null }, null, [
    { naam: "Piet" },
  ]);
  const claim = await claimMetVenster<{ naam: string }>(db, {
    tabel: "client_member",
    kolom: "laatste_herstel_op",
    sleutel: { email: "a@b.be", site: 7 },
    vensterMs: 60_000,
    extra: (q) => q.eq("actief", true).not("lid_user_id", "is", null),
    select: "naam",
  });
  assertEquals(claim.rijen, [{ naam: "Piet" }]);

  const stappen = (log as unknown[][][])[0];
  assertEquals(stappen.map((s) => s[0]), [
    "update",
    "eq",
    "eq",
    "eq",
    "not",
    "or",
    "select",
  ]);
  assertEquals(stappen[1], ["eq", "email", "a@b.be"]);
  assertEquals(stappen[2], ["eq", "site", 7]);
  assertEquals(stappen[3], ["eq", "actief", true]);
  assertEquals(stappen[4], ["not", "lid_user_id", "is", null]);
  assertEquals(stappen[6], ["select", "naam"]);
});

Deno.test("claimMetVenster: standaard select is *", async () => {
  const { db, log } = nepDb({ data: null, error: null }, null, []);
  await claimMetVenster(db, OPTIES);
  const stappen = (log as unknown[][][])[0];
  assertEquals(stappen[stappen.length - 1], ["select", "*"]);
});

Deno.test("claimMetVenster: geen rij terug is geclaimd false", async () => {
  const leeg = nepDb({ data: null, error: null }, null, []);
  assertEquals((await claimMetVenster(leeg.db, OPTIES)).geclaimd, false);
  const geen = nepDb({ data: null, error: null }, null, null);
  const claim = await claimMetVenster(geen.db, OPTIES);
  assertEquals(claim.geclaimd, false);
  assertEquals(claim.rijen, []);
});

Deno.test("claimMetVenster: een rij terug is geclaimd true met de rijen en de stempel", async () => {
  const { db, log } = nepDb({ data: null, error: null }, null, [
    { naam: "A" },
    { naam: "B" },
  ]);
  const claim = await claimMetVenster(db, OPTIES);
  assertEquals(claim.geclaimd, true);
  assertEquals(claim.rijen, [{ naam: "A" }, { naam: "B" }]);
  assertEquals(new Date(claim.stempel).toISOString(), claim.stempel);
  const velden = ((log as unknown[][][])[0][0] as unknown[])[2];
  assertEquals(velden, { laatste_herstel_op: claim.stempel });
});

Deno.test("claimMetVenster: een databasefout wordt gegooid (fail-closed)", async () => {
  const { db } = nepDb({ data: null, error: null }, { message: "boem" });
  await assertRejects(() => claimMetVenster(db, OPTIES));
});

Deno.test("claimMetVenster: ongeldige invoer geeft TypeError zonder databaseverzoek", async () => {
  const { db, log } = nepDb({ data: null, error: null }, null, [{ id: 1 }]);
  const slecht = [
    { ...OPTIES, sleutel: {} },
    { ...OPTIES, tabel: "" },
    { ...OPTIES, kolom: "" },
    { ...OPTIES, vensterMs: 0 },
    { ...OPTIES, vensterMs: -5 },
    { ...OPTIES, vensterMs: NaN },
    { ...OPTIES, vensterMs: Infinity },
    { ...OPTIES, sleutel: { email: undefined as unknown as string } },
  ];
  for (const o of slecht) {
    await assertRejects(() => claimMetVenster(db, o), TypeError);
  }
  assertEquals(log.length, 0);
});

Deno.test("geefClaimVrij: filtert op sleutel en stempel en zet null", async () => {
  const { db, log } = nepDb({ data: null, error: null }, null, [{ id: 1 }]);
  assertEquals(
    await geefClaimVrij(db, OPTIES, "2026-10-28T10:00:00.000Z"),
    true,
  );
  const stappen = (log as unknown[][][])[0];
  assertEquals(stappen[0], [
    "update",
    "client_member",
    { laatste_herstel_op: null },
  ]);
  assertEquals(stappen[1], ["eq", "email", "a@b.be"]);
  assertEquals(stappen[2], [
    "eq",
    "laatste_herstel_op",
    "2026-10-28T10:00:00.000Z",
  ]);
  assertEquals(stappen[3], ["select", "laatste_herstel_op"]);
});

Deno.test("geefClaimVrij: rem al van iemand anders is false", async () => {
  const { db } = nepDb({ data: null, error: null }, null, []);
  assertEquals(await geefClaimVrij(db, OPTIES, "x"), false);
});

Deno.test("geefClaimVrij: gooit bij een fout, en TypeError bij ongeldige invoer zonder verzoek", async () => {
  const fout = nepDb({ data: null, error: null }, { message: "boem" });
  await assertRejects(() => geefClaimVrij(fout.db, OPTIES, "x"));

  const { db, log } = nepDb({ data: null, error: null }, null, [{ id: 1 }]);
  await assertRejects(
    () => geefClaimVrij(db, { ...OPTIES, sleutel: {} }, "x"),
    TypeError,
  );
  await assertRejects(() => geefClaimVrij(db, OPTIES, ""), TypeError);
  assertEquals(log.length, 0);
});
