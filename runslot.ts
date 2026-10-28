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

/** Waarden die een sleutelkolom mag hebben (voor `.eq`). */
type SleutelWaarde = string | number | boolean;

/** Welke rij geclaimd wordt, met welke kolom als rem, en hoe lang de rem geldt. */
export interface ClaimOpties {
  /** Tabel met de remkolom, bv. `client_member`. */
  tabel: string;
  /** Timestamptz-kolom die de rem draagt, bv. `laatste_herstel_op`. */
  kolom: string;
  /**
   * Kolommen die samen de rij aanwijzen (één `.eq` per kolom). Minstens één is
   * verplicht: zonder sleutel zou de claim een hele tabel raken.
   */
  sleutel: Record<string, SleutelWaarde>;
  /**
   * Weglaten = eenmalig: enkel claimbaar zolang de kolom `null` is (zoals
   * `claimMelding`). Met een waarde ook claimbaar als de kolom ouder is dan dit
   * aantal ms. Moet een eindig getal > 0 zijn.
   */
  vensterMs?: number;
  /**
   * Extra filters op dezelfde UPDATE, bv.
   * `(q) => q.eq("actief", true).not("lid_user_id", "is", null)`.
   * Geef de keten terug.
   */
  extra?: (q: Db) => Db;
  /** Kolommen die de UPDATE teruggeeft, standaard `"*"`. */
  select?: string;
}

/**
 * Uitkomst van `claimMetVenster`. `stempel` is exact de waarde die in de kolom
 * gezet werd: geef hem door aan `geefClaimVrij`.
 */
export type Claim<T = Record<string, unknown>> = {
  geclaimd: boolean;
  rijen: T[];
  stempel: string;
};

function controleerSleutel(
  opties: Pick<ClaimOpties, "tabel" | "kolom" | "sleutel">,
): [string, SleutelWaarde][] {
  if (!opties.tabel || !opties.kolom) {
    throw new TypeError("claim: tabel en kolom zijn verplicht");
  }
  const sleutels = Object.entries(opties.sleutel ?? {});
  if (sleutels.length === 0) {
    throw new TypeError(
      "claim: minstens één sleutelkolom is verplicht, nooit een hele tabel claimen",
    );
  }
  for (const [naam, waarde] of sleutels) {
    if (waarde === null || waarde === undefined) {
      throw new TypeError(`claim: sleutelkolom ${naam} heeft geen waarde`);
    }
  }
  return sleutels;
}

/**
 * Claimt een rij atomair, eenmalig of met een venster: de eerste aanroeper
 * krijgt `geclaimd: true`, elke gelijktijdige of latere aanroeper binnen het
 * venster krijgt `false`. Voor "doe dit hoogstens één keer (per X minuten)",
 * zoals een mail versturen.
 *
 * Herkomst, hetzelfde patroon op drie plekken:
 * - `startRun` hierboven: unieke index op `finished_at is null`;
 * - `claimMelding` (billaraapp, `_shared/melding-claim.ts`): `kolom = now`
 *   waar `kolom is null`, eenmalig en zonder venster;
 * - `roundbook-herstel` (billaraapp): `laatste_herstel_op = now` waar leeg of
 *   ouder dan 10 minuten, om hoogstens één herstelmail per 10 minuten te sturen.
 *
 * De poort is één conditionele UPDATE. Postgres serialiseert gelijktijdige
 * UPDATEs op dezelfde rij: de tweede wacht op de eerste, ziet daarna de
 * ingevulde waarde, matcht het filter niet meer en krijgt nul rijen terug. Een
 * "heb ik al?"-check in de functie lost dit NIET op: bij gelijktijdige
 * verzoeken is de schrijfactie van de eerste nog niet zichtbaar als de tweede
 * kijkt.
 *
 * Ketenvolgorde: `update({ [kolom]: stempel })`, de `.eq`'s van `sleutel`,
 * `extra`, het remfilter (`is null`, of `is null` OF ouder dan de grens), en
 * als laatste `.select(...)`.
 *
 * FAIL-CLOSED: bij een databasefout wordt GEGOOID, nooit `geclaimd: true`
 * teruggegeven. Een throw is de veilige uitkomst: de aanroeper doet dan niets
 * (geen mail, geen melding) en een herproef of de volgende tik probeert het
 * opnieuw. "Bij twijfel toch sturen" maakt de poort waardeloos: precies bij een
 * hapering, wanneer verzoeken zich opstapelen en herhalen, zouden er dan
 * dubbele mails uitgaan. Vang de fout dus nooit op om alsnog door te gaan.
 *
 * Voorbeeld (roundbook-herstel: hoogstens één mail per 10 minuten, rem
 * vrijgeven als de mail faalt):
 *
 * ```ts
 * const opties = {
 *   tabel: "client_member",
 *   kolom: "laatste_herstel_op",
 *   sleutel: { email },
 * };
 * const claim = await claimMetVenster(admin, {
 *   ...opties,
 *   vensterMs: 10 * 60 * 1000,
 *   extra: (q) => q.eq("actief", true).not("lid_user_id", "is", null),
 *   select: "naam",
 * });
 * if (!claim.geclaimd) return;
 * try {
 *   await verstuurMail(claim.rijen[0].naam);
 * } catch (e) {
 *   await geefClaimVrij(admin, opties, claim.stempel);
 *   throw e;
 * }
 * ```
 */
export async function claimMetVenster<T = Record<string, unknown>>(
  db: Db,
  opties: ClaimOpties,
): Promise<Claim<T>> {
  const sleutels = controleerSleutel(opties);
  const { vensterMs } = opties;
  if (
    vensterMs !== undefined && (!Number.isFinite(vensterMs) || vensterMs <= 0)
  ) {
    throw new TypeError("claim: vensterMs moet een eindig getal > 0 zijn");
  }

  const nu = Date.now();
  const stempel = new Date(nu).toISOString();
  const kolom = opties.kolom;

  let q = db.from(opties.tabel).update({ [kolom]: stempel });
  for (const [naam, waarde] of sleutels) q = q.eq(naam, waarde);
  if (opties.extra) {
    q = opties.extra(q);
    if (!q) throw new TypeError("claim: extra moet de keten teruggeven");
  }
  if (vensterMs === undefined) {
    q = q.is(kolom, null);
  } else {
    // ISO-tijd tussen dubbele aanhalingstekens: PostgREST leest `.` en `:`
    // anders als scheidingstekens mee.
    const grens = new Date(nu - vensterMs).toISOString();
    q = q.or(`${kolom}.is.null,${kolom}.lt."${grens}"`);
  }

  const { data, error } = await q.select(opties.select ?? "*");
  if (error) throw error;
  const rijen = Array.isArray(data) ? (data as T[]) : [];
  return { geclaimd: rijen.length > 0, rijen, stempel };
}

/**
 * Geeft een claim van `claimMetVenster` vrij: zet `kolom` terug op `null`, maar
 * enkel als de rem nog van ons is (`kolom = stempel`). Een latere claim van
 * iemand anders heeft een andere stempel en blijft dus staan.
 *
 * Bedoeld voor "de mail faalde, laat de gebruiker meteen opnieuw proberen" in
 * plaats van hem een heel venster te laten wachten op niets. Geeft `true` als er
 * een rij vrijgegeven werd, `false` als de rem al verlopen of overgenomen was.
 * Gooit bij een databasefout (de rem blijft dan hoogstens tot het einde van het
 * venster staan, wat de veilige kant is).
 */
export async function geefClaimVrij(
  db: Db,
  opties: Pick<ClaimOpties, "tabel" | "kolom" | "sleutel">,
  stempel: string,
): Promise<boolean> {
  const sleutels = controleerSleutel(opties);
  if (!stempel) throw new TypeError("claim: stempel is verplicht");

  let q = db.from(opties.tabel).update({ [opties.kolom]: null });
  for (const [naam, waarde] of sleutels) q = q.eq(naam, waarde);
  const { data, error } = await q.eq(opties.kolom, stempel).select(
    opties.kolom,
  );
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}
