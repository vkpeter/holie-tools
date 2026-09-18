/**
 * Eén run per job tegelijk, voor cron-functies die niet mogen overlappen.
 *
 * Uit podcast-analyse (`_shared/podcast-run.ts`), waar het gemeten geval
 * vandaan komt: op 27-08-2026 startten vier runs binnen 0,1 seconde, pakten
 * dezelfde batch van 25 items en lieten die vier keer door een LLM betalen.
 *
 * De poort staat in de DATABASE, niet in de functie. Een check "loopt er al een
 * run?" vangt dit niet: bij starts binnen 0,1 s heeft de eerste zijn rij nog
 * niet gecommit als de tweede kijkt. Nodig per project, eenmalig:
 *
 * ```sql
 * create table if not exists cron_runs (
 *   id uuid primary key default gen_random_uuid(),
 *   job text not null,
 *   started_at timestamptz not null default now(),
 *   finished_at timestamptz,
 *   note text
 * );
 * create unique index if not exists cron_runs_een_actief
 *   on cron_runs (job) where finished_at is null;
 * ```
 *
 * ⚠️ Negeer de insert-fout nooit. In podcast-analyse deed één functie
 * `const { data: run }` zonder `error`, werkte bij een bezette slot gewoon door
 * en maakte de poort zo waardeloos.
 */

/**
 * Standaard-vervaltermijn: 8 minuten.
 *
 * ⚠️ Hou hem ONDER de cron-interval. Een edge function die afgekapt wordt, komt
 * niet meer aan `finished_at` toe; met een termijn boven de interval weigert de
 * volgende tik en halveert de capaciteit (gemeten: ritme van 20 i.p.v. 10 minuten
 * met 15 minuten termijn op een cron van 10). Wel ruim boven de echte looptijd.
 */
export const RUN_TTL_MS = 8 * 60 * 1000;

// deno-lint-ignore no-explicit-any
type Db = any;

/** Opties voor `startRun` en `eindRun`. */
export interface RunOpties {
  /** Tabelnaam, standaard `cron_runs`. */
  tabel?: string;
  /** Na hoeveel ms een run zonder `finished_at` als afgebroken geldt. */
  ttlMs?: number;
}

/** Uitkomst van `startRun`. */
export type RunStart =
  | { runId: string; albezig: false }
  | { runId: null; albezig: true };

/**
 * Meldt een run aan. `albezig: true` betekent dat er al een loopt: stop dan met
 * een 200, niet met een fout, zodat de cron er zonder alarm overheen loopt.
 *
 * Sluit eerst afgebroken runs van deze job (ouder dan de termijn). Andere fouten
 * dan een unieke-sleutelschending worden gegooid.
 */
export async function startRun(
  db: Db,
  job: string,
  opties: RunOpties = {},
): Promise<RunStart> {
  const tabel = opties.tabel ?? "cron_runs";
  const ttl = opties.ttlMs ?? RUN_TTL_MS;

  await db.from(tabel)
    .update({
      finished_at: new Date().toISOString(),
      note: `afgebroken: geen finished_at binnen ${
        Math.round(ttl / 60000)
      } minuten`,
    })
    .eq("job", job)
    .is("finished_at", null)
    .lt("started_at", new Date(Date.now() - ttl).toISOString());

  const { data, error } = await db.from(tabel).insert({ job }).select("id")
    .single();
  if (error) {
    // 23505 = unique_violation: de bedoeling, geen fout.
    if ((error as { code?: string }).code === "23505") {
      return { runId: null, albezig: true };
    }
    throw error;
  }
  return { runId: (data as { id: string }).id, albezig: false };
}

/**
 * Sluit een run af, met extra kolommen naar keuze (bv. tellers of `note`). Gooit
 * bij een fout: een run die open blijft, blokkeert zijn job tot de termijn om is.
 */
export async function eindRun(
  db: Db,
  runId: string,
  velden: Record<string, unknown> = {},
  opties: Pick<RunOpties, "tabel"> = {},
): Promise<void> {
  const { error } = await db.from(opties.tabel ?? "cron_runs")
    .update({ ...velden, finished_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) throw error;
}
