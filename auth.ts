/**
 * Geheimen controleren in edge functions: cron-aanroepen, machine-sleutels en
 * een constante-tijdvergelijking.
 *
 * Waarom een eigen module: op 18-09-2026 stonden er vijf vergelijkingen in vier
 * repo's (podcast-analyse, Eendje, Foodie, Billara). De beste versie kwam uit
 * podcast-analyse en kende als enige de nieuwe `SUPABASE_SECRET_KEYS`; Eendje
 * had die fix niet.
 *
 * Alles is fail-closed: ontbreekt het verwachte geheim, dan is het antwoord nee.
 * Het patroon `if (geheim) { controleer }` laat alles door zodra de env-var
 * ontbreekt, en dat is precies het gat dat Foodie's `requireCronSecret` dichtte.
 *
 * Enkel Web-API's en `Deno.env`, geen supabase-js: de RPC-controle krijgt de
 * client van de aanroeper mee.
 */

/** Leest een env-var. Te vervangen in tests. */
export type EnvLezer = (naam: string) => string | undefined;

const standaardEnv: EnvLezer = (naam) => Deno.env.get(naam);

/**
 * Vergelijkt twee geheimen in constante tijd (bytes, niet UTF-16-eenheden), zodat
 * de responstijd niet verraadt hoeveel tekens er al klopten. De lengte lekt wel:
 * dat is bij een willekeurig gegenereerd geheim geen informatie.
 */
export function geheimenGelijk(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let verschil = 0;
  for (let i = 0; i < x.length; i++) verschil |= x[i] ^ y[i];
  return verschil === 0;
}

/** Het token uit `Authorization: Bearer ...`, of `null`. */
export function bearerToken(req: Request): string | null {
  const kop = req.headers.get("Authorization");
  if (!kop?.startsWith("Bearer ")) return null;
  const token = kop.slice("Bearer ".length).trim();
  return token || null;
}

/**
 * Is `token` een service-role-sleutel van dit project, in beide generaties?
 *
 * ⚠️ `SUPABASE_SERVICE_ROLE_KEY` staat sinds september 2026 als DEPRECATED
 * gemarkeerd en blijft de oude legacy-JWT bevatten, ook als je in het dashboard
 * een nieuwe `sb_secret_...`-sleutel aanmaakt. Wie enkel daartegen vergelijkt,
 * weigert een geldige nieuwe sleutel (gemeten in podcast-analyse, 15-09-2026).
 * `SUPABASE_SECRET_KEYS` is een JSON-dictionary met meerdere sleutels tegelijk,
 * voor rotatie; ongeldige JSON geeft geen crash maar gewoon geen match.
 */
export function isMachineSleutel(
  token: string,
  env: EnvLezer = standaardEnv,
): boolean {
  if (!token) return false;
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (legacy && geheimenGelijk(token, legacy)) return true;

  const ruw = env("SUPABASE_SECRET_KEYS");
  if (!ruw) return false;
  try {
    const sleutels: unknown = JSON.parse(ruw);
    if (!sleutels || typeof sleutels !== "object") return false;
    return Object.values(sleutels as Record<string, unknown>).some((v) =>
      typeof v === "string" && v.trim() !== "" &&
      geheimenGelijk(token, v.trim())
    );
  } catch {
    return false;
  }
}

/** Opties voor de cron-controles. */
export interface CronOpties {
  /** Header met het geheim. Standaard `x-cron-secret`. */
  header?: string;
}

/**
 * Cron-geheim uit een env-var (Foodie-stijl: `CRON_SECRET`). Fail-closed: geen
 * env-var of geen header is nee.
 */
export function controleerCronGeheim(
  req: Request,
  opties: CronOpties & { envNaam?: string; env?: EnvLezer } = {},
): boolean {
  const verwacht = (opties.env ?? standaardEnv)(
    opties.envNaam ?? "CRON_SECRET",
  );
  const gekregen = req.headers.get(opties.header ?? "x-cron-secret");
  return !!verwacht && !!gekregen && geheimenGelijk(verwacht, gekregen);
}

/** Het stukje supabase-js dat de RPC-controle nodig heeft. */
export interface RpcClient {
  // PromiseLike en niet Promise: supabase-js geeft een PostgrestFilterBuilder
  // terug, die wel een then heeft maar geen catch of finally.
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * Cron-geheim dat de database zelf bewaart (podcast-analyse- en Eendje-stijl).
 * pg_net kan geen JWT tonen, dus vraagt de functie `verify_cron_secret` of het
 * klopt; het geheim zelf verlaat de database nooit. Alleen `data === true` telt.
 */
export async function controleerCronGeheimViaDb(
  req: Request,
  db: RpcClient,
  opties: CronOpties & { rpc?: string } = {},
): Promise<boolean> {
  const kandidaat = req.headers.get(opties.header ?? "x-cron-secret");
  if (!kandidaat) return false;
  const { data, error } = await db.rpc(opties.rpc ?? "verify_cron_secret", {
    candidate: kandidaat,
  });
  return !error && data === true;
}
