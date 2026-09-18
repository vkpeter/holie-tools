import { assertEquals, assertRejects } from "@std/assert";
import { eindRun, RUN_TTL_MS, startRun } from "./runslot.ts";

/** Een nep-client die de ketting van supabase-js naspeelt en elke stap logt. */
function nepDb(
  insertAntwoord: { data: unknown; error: unknown },
  updateFout: unknown = null,
) {
  const log: unknown[] = [];
  const keten = (stappen: unknown[], eind: unknown) => {
    const k: Record<string, unknown> = {};
    for (const m of ["eq", "is", "lt", "select"]) {
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
          return keten(stappen, { error: updateFout });
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
