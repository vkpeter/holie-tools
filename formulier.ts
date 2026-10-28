/**
 * Publieke formulieren (nieuwsbrief, contact, leads): e-mailadres, klant-IP,
 * atomaire limiet en een vaste antwoordduur.
 *
 * Waarom een eigen module: op 27-28 okt 2026 trok Peter zeven sites op dezelfde
 * lat (N1-N7). Elke site bouwde die stukken apart: holie, Eendje, Phyllox,
 * Eagle-Eye, Billara, Foodie en ESE. Per stuk staat hieronder welke versie de
 * beste was en waarom.
 *
 * Runtime-neutraal: enkel `Request`, Web Crypto en `setTimeout`. Geen
 * supabase-js: `limietHit` krijgt de client van de aanroeper mee, zoals
 * `controleerCronGeheimViaDb` in `./auth`.
 *
 * Alles valt dicht: lukt een controle niet, dan is het antwoord nee.
 */

import type { RpcClient } from "./auth.ts";

export type { RpcClient } from "./auth.ts";

// ───────────── E-mail (N5) ─────────────

/** Langste adres dat SMTP toelaat (RFC 5321: 256 voor het pad, min de haken). */
export const EMAIL_MAX_LENGTE = 254;

/**
 * Lineair e-mailpatroon. Elk deel (tussen punten, voor en na de `@`) sluit de
 * punt en de `@` uit, dus er is maar één manier om te matchen: geen
 * backtracking op `a@.......` (gemeten met 20.000 punten in
 * `formulier_test.ts`).
 *
 * Basis is het patroon `/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/` van holie, strenger
 * gemaakt na de review van 0.18.0:
 * - Zoals bij Eendje (newsletter-subscribe, 28 okt 2026) vallen de tekens weg
 *   die een mailheader of HTML kunnen breken (`<>"(),;:\[]`). Die mogen volgens
 *   RFC 5322 niet zonder aanhalingstekens in een adres staan.
 * - Ook stuurtekens en onzichtbare opmaaktekens (`\p{Cc}`, `\p{Cf}`: zero-width
 *   space, zachte koppelstreep, richtingswissel). Met een zero-width space
 *   omzeilt iemand anders de limiet per adres en de ontdubbeling.
 * - Geen punt vooraan, achteraan of dubbel in het lokale deel.
 * - Het domein enkel `A-Z a-z 0-9 -` per label: een domein met accenten komt
 *   als punycode (`xn--...`), zoals een browser het in `type=email` doorgeeft.
 *
 * De apostrof en letters met accenten in het lokale deel blijven toegelaten
 * (`o'neil@...`, `josé@...`).
 */
export const EMAIL_PATROON =
  /^[^\s@.<>"(),;:\\[\]\p{Cc}\p{Cf}]+(?:\.[^\s@.<>"(),;:\\[\]\p{Cc}\p{Cf}]+)*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;

/**
 * Het adres zoals het in de databank hoort, of `null` als het geen bruikbaar
 * adres is. Volgorde: eerst de lengte, dan het patroon, dan kleine letters. Zo
 * ziet de regex nooit een lange invoer.
 *
 * Neemt `unknown` aan, zodat een JSON-body rechtstreeks door kan: een getal of
 * object geeft `null`.
 */
export function normaliseerEmail(invoer: unknown): string | null {
  if (typeof invoer !== "string") return null;
  if (invoer.length > EMAIL_MAX_LENGTE) return null;
  const adres = invoer.trim();
  if (!EMAIL_PATROON.test(adres)) return null;
  const klein = adres.toLowerCase();
  // Kleine letters kunnen langer zijn (`İ` wordt twee tekens): opnieuw meten.
  return klein.length > EMAIL_MAX_LENGTE ? null : klein;
}

/** Is dit een bruikbaar adres? Zelfde regels als `normaliseerEmail`. */
export function isGeldigEmail(invoer: unknown): boolean {
  return normaliseerEmail(invoer) !== null;
}

// ───────────── Klant-IP (N3) ─────────────

/** Opties voor `klantIp`. */
export interface KlantIpOpties {
  /**
   * Breng een IPv6-adres terug tot zijn /64-blok (`2001:db8:1:2::/64`). Eén
   * aansluiting krijgt doorgaans een hele /64; per adres tellen geeft een
   * aanvaller dan onbeperkt "IP's". Gebruik dit voor limieten. Standaard uit.
   */
  ipv6Per64?: boolean;
}

/**
 * Het IP van de bezoeker, enkel uit `cf-connecting-ip`, of `null`.
 *
 * Nooit `X-Forwarded-For` of `X-Real-IP`: die zet de client zelf, en een
 * limiet op die kop is met één header te omzeilen. Cloudflare overschrijft
 * `cf-connecting-ip` bij elk verzoek; Supabase edge functions en Workers
 * zitten allebei achter Cloudflare.
 *
 * Een ontbrekende of ongeldige kop geeft `null`. De aanroeper beslist: dicht
 * vallen (Eendje: 503) of een gedeelde emmer (Eagle-Eye: `"onbekend"`).
 *
 * Het resultaat is canoniek (kleine letters, IPv6 volgens RFC 5952), zodat
 * `2001:DB8::1` en `2001:db8:0:0::1` in dezelfde emmer vallen. Een IPv4-adres
 * in IPv6-vorm (`::ffff:1.2.3.4`) wordt gewoon `1.2.3.4`. Het /64-blok is
 * letterlijk wat Postgres toont; een los IPv6-adres met ingebed IPv4 (`::1.2.3.4`)
 * schrijft Postgres anders, dus vergelijk losse adressen niet met `inet::text`.
 *
 * ⚠️ Twee valkuilen bij de inrichting:
 * - Staat in Cloudflare "Pseudo IPv4: Overwrite Headers" aan, dan staat hier
 *   een `240.x`-adres per IPv6-adres, en helpt `ipv6Per64` niet. Zet die
 *   instelling uit (standaard uit).
 * - Een Worker die zelf een Supabase-functie aanroept, stuurt zijn eigen IP:
 *   alle bezoekers vallen dan in één emmer. Tel in de Worker, niet erachter.
 */
export function klantIp(
  req: Request | Headers,
  opties: KlantIpOpties = {},
): string | null {
  const headers = req instanceof Headers ? req : req.headers;
  const ruw = headers.get("cf-connecting-ip")?.trim();
  if (!ruw || ruw.length > 64) return null;

  const v4 = leesIpv4(ruw);
  if (v4) return v4.join(".");

  const groepen = leesIpv6(ruw);
  if (!groepen) return null;
  // ::ffff:a.b.c.d is een IPv4-adres.
  if (groepen.slice(0, 5).every((g) => g === 0) && groepen[5] === 0xffff) {
    return [
      groepen[6] >> 8,
      groepen[6] & 0xff,
      groepen[7] >> 8,
      groepen[7] & 0xff,
    ].join(".");
  }
  if (opties.ipv6Per64) {
    return `${schrijfIpv6([...groepen.slice(0, 4), 0, 0, 0, 0])}/64`;
  }
  return schrijfIpv6(groepen);
}

function leesIpv4(tekst: string): number[] | null {
  const delen = tekst.split(".");
  if (delen.length !== 4) return null;
  const getallen: number[] = [];
  for (const deel of delen) {
    // Geen voorloopnullen: "010" is in sommige parsers octaal.
    if (!/^(0|[1-9]\d{0,2})$/.test(deel)) return null;
    const n = Number(deel);
    if (n > 255) return null;
    getallen.push(n);
  }
  return getallen;
}

function leesIpv6(tekst: string): number[] | null {
  // Een zone (fe80::1%eth0) komt niet van Cloudflare; weigeren.
  if (!/^[0-9a-fA-F:.]+$/.test(tekst)) return null;
  let staart: number[] = [];
  let rest = tekst;
  // Een ingebed IPv4-adres in de laatste 32 bits.
  if (rest.includes(".")) {
    const plek = rest.lastIndexOf(":");
    const v4 = leesIpv4(rest.slice(plek + 1));
    if (!v4) return null;
    staart = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    rest = rest.slice(0, plek + 1);
    // "::1.2.3.4" laat "::" over; "1::1.2.3.4" laat "1::" over; "1:2:...:6:" eindigt op ":".
    if (rest.endsWith(":") && !rest.endsWith("::")) rest = rest.slice(0, -1);
  }
  const stukken = rest.split("::");
  if (stukken.length > 2) return null;
  const lees = (s: string): number[] | null => {
    if (s === "") return [];
    const uit: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      uit.push(parseInt(g, 16));
    }
    return uit;
  };
  const kop = lees(stukken[0]);
  if (!kop) return null;
  const nodig = 8 - staart.length;
  if (stukken.length === 1) {
    if (kop.length !== nodig) return null;
    return [...kop, ...staart];
  }
  const voet = lees(stukken[1]);
  if (!voet) return null;
  const nullen = nodig - kop.length - voet.length;
  // "::" staat voor minstens één groep nullen.
  if (nullen < 1) return null;
  return [...kop, ...new Array(nullen).fill(0), ...voet, ...staart];
}

/** RFC 5952: kleine letters, geen voorloopnullen, de langste reeks nullen (≥ 2) als `::`. */
function schrijfIpv6(groepen: number[]): string {
  let besteStart = -1;
  let besteLengte = 1;
  for (let i = 0; i < 8;) {
    if (groepen[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groepen[j] === 0) j++;
    if (j - i > besteLengte) {
      besteStart = i;
      besteLengte = j - i;
    }
    i = j;
  }
  const hex = groepen.map((g) => g.toString(16));
  if (besteStart < 0) return hex.join(":");
  const links = hex.slice(0, besteStart).join(":");
  const rechts = hex.slice(besteStart + besteLengte).join(":");
  return `${links}::${rechts}`;
}

// ───────────── Limiet (N3) ─────────────

/** Opties voor `limietHit`. */
export interface LimietOpties {
  /** Wie er telt: een IP (`klantIp`), een adres (`normaliseerEmail`), een chat-id. */
  sleutel: string | null | undefined;
  /** Welke teller: `"nieuwsbrief:ip"`, `"contact:adres"`, ... */
  eindpunt: string;
  /** Zoveel hits mogen er binnen het venster zijn. Geheel getal, 1 tot 1.000.000. */
  max: number;
  /** Lengte van het venster, 1 tot 1500 minuten (de opkuis wist na 25 uur). */
  vensterMinuten: number;
  /**
   * Bewaar de sleutel als hash (64 tekens hex) in plaats van leesbaar.
   * Standaard aan. Zet uit als een bestaande tabel al leesbare sleutels telt en
   * de tellers moeten doorlopen.
   *
   * ⚠️ Zonder `peper` is dat SHA-256 zonder geheim: een pseudoniem, geen
   * anonimiteit. Alle IPv4-adressen zijn in seconden na te rekenen, een adres
   * met een woordenlijst. Wie de tabel kan lezen, kan dat dus.
   */
  versluier?: boolean;
  /**
   * Geheim (minstens 32 tekens) voor de hash: dan is de sleutel
   * HMAC-SHA256(peper, sleutel) en zonder het geheim niet na te rekenen. Een
   * eigen env-var, niet de service-role-sleutel.
   */
  peper?: string;
  /** Naam van de RPC. Standaard `rate_limit_hit`. */
  rpc?: string;
}

/** Grootste venster dat `rate_limit_hit` aanvaardt: de opkuis wist na 25 uur. */
export const LIMIET_MAX_VENSTER_MINUTEN = 1500;

const LIMIET_MAX_HITS = 1_000_000;

/**
 * Registreert een hit als er nog plaats is en zegt of dat zo was: `true` =
 * binnen de limiet (en geteld), `false` = erover (niet geteld). Tellen en
 * registreren gebeurt in één stap in de databank, onder een advisory lock (zie
 * `RATE_LIMIT_HIT_SQL`): parallelle verzoeken zien nooit dezelfde telling. Zo
 * was het in holie, Eendje en Foodie nog niet vóór 27 okt.
 *
 * Valt dicht: een databankfout, een ontbrekende sleutel, een te korte peper of
 * ongeldige opties geven `false`. Liever een bezoeker die het straks opnieuw
 * probeert dan een open mailkraan. Gooit nooit.
 *
 * ```ts
 * const ip = klantIp(req, { ipv6Per64: true });
 * if (!await limietHit(admin, { sleutel: ip, eindpunt: "nieuwsbrief:ip", max: 10, vensterMinuten: 60 })) {
 *   return new Response("Te veel aanvragen", { status: 429 });
 * }
 * ```
 */
export async function limietHit(
  client: RpcClient,
  opties: LimietOpties,
): Promise<boolean> {
  const { sleutel, eindpunt, max, vensterMinuten, peper } = opties;
  if (
    typeof sleutel !== "string" || sleutel === "" ||
    typeof eindpunt !== "string" || eindpunt === "" ||
    !Number.isInteger(max) || max < 1 || max > LIMIET_MAX_HITS ||
    !Number.isInteger(vensterMinuten) || vensterMinuten < 1 ||
    vensterMinuten > LIMIET_MAX_VENSTER_MINUTEN ||
    (peper !== undefined && (typeof peper !== "string" || peper.length < 32))
  ) {
    return false;
  }
  try {
    const key = opties.versluier === false
      ? sleutel
      : await hashSleutel(sleutel, peper);
    const { data, error } = await client.rpc(opties.rpc ?? "rate_limit_hit", {
      _key: key,
      _endpoint: eindpunt,
      _max_requests: max,
      _window_minutes: vensterMinuten,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

async function hashSleutel(tekst: string, peper?: string): Promise<string> {
  const enc = new TextEncoder();
  let bytes: ArrayBuffer;
  if (peper === undefined) {
    bytes = await crypto.subtle.digest("SHA-256", enc.encode(tekst));
  } else {
    const sleutel = await crypto.subtle.importKey(
      "raw",
      enc.encode(peper),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    bytes = await crypto.subtle.sign("HMAC", sleutel, enc.encode(tekst));
  }
  return Array.from(
    new Uint8Array(bytes),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * De migratie achter `limietHit`, letterlijk over te nemen in
 * `supabase/migrations/<stempel>_rate_limit_hit.sql`. Staat ook als
 * `sql/rate_limit_hit.sql` in het pakket; een test houdt de twee gelijk.
 *
 * - Tabel `rate_limit_hits`, niet `rate_limits`: die naam is in Foodie, holie,
 *   ESE en Eagle-Eye al bezet, telkens met andere kolommen. `create table if not
 *   exists` zou zo'n tabel stil hergebruiken. Kolommen en indexnaam zijn die van
 *   Foodie (`sleutel`, `endpoint`), dat al een `rate_limit_hits` heeft: daar is
 *   deze migratie een no-op voor de tabel en vervangt ze enkel de functie.
 * - Telt en registreert onder `pg_advisory_xact_lock` per eindpunt en sleutel.
 * - Opkuis in de functie zelf (zoals ESE): na elke toegelaten hit verdwijnen
 *   hoogstens 500 rijen ouder dan 25 uur, met `skip locked`. Geen pg_cron nodig,
 *   en een piek van gisteren laat vandaag geen enkele hit hangen.
 * - `security definer` met `search_path = ''` (zoals Eagle-Eye), enkel
 *   uitvoerbaar door `service_role`. anon en authenticated kunnen de tabel niet
 *   lezen en de functie niet aanroepen.
 * - Idempotent: opnieuw draaien verandert niets.
 */
export const RATE_LIMIT_HIT_SQL =
  `-- rate_limit_hit uit @holie/tools 0.18.0 (lat N3): tellen en registreren in een stap.
-- Idempotent: opnieuw draaien verandert niets.

create table if not exists public.rate_limit_hits (
  id bigint generated always as identity primary key,
  sleutel text not null,
  endpoint text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_hits_endpoint_sleutel_tijd
  on public.rate_limit_hits (endpoint, sleutel, created_at desc);
create index if not exists rate_limit_hits_tijd
  on public.rate_limit_hits (created_at);

-- Enkel de functie hieronder (security definer) raakt deze tabel.
alter table public.rate_limit_hits enable row level security;
revoke all on public.rate_limit_hits from public, anon, authenticated;

create or replace function public.rate_limit_hit(
  _key text,
  _endpoint text,
  _max_requests integer,
  _window_minutes integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _aantal integer;
begin
  if _key is null or _endpoint is null or _max_requests is null or _window_minutes is null then
    raise exception 'rate_limit_hit: argumenten mogen niet null zijn' using errcode = '22004';
  end if;
  -- De opkuis wist alles ouder dan 25 uur: een langer venster zou nooit volledig tellen.
  if _window_minutes < 1 or _window_minutes > 1500 or _max_requests < 1 then
    raise exception 'rate_limit_hit: venster 1..1500 minuten, max_requests >= 1' using errcode = '22023';
  end if;

  -- Serialiseert gelijktijdige hits op dezelfde sleutel tot het einde van de transactie.
  perform pg_advisory_xact_lock(hashtext(_endpoint || ':' || _key));

  select count(*) into _aantal
  from public.rate_limit_hits
  where endpoint = _endpoint
    and sleutel = _key
    and created_at > now() - make_interval(mins => _window_minutes);

  if _aantal < _max_requests then
    insert into public.rate_limit_hits (sleutel, endpoint) values (_key, _endpoint);
    -- Opkuis: rijen ouder dan 25 uur (langer dan het grootste venster), hoogstens 500 per hit.
    -- skip locked: twee hits tegelijk wachten nooit op elkaars opkuis, en na een piek
    -- verdeelt de opkuis zich over de volgende hits in plaats van er een te laten hangen.
    delete from public.rate_limit_hits
    where id in (
      select id from public.rate_limit_hits
      where created_at < now() - interval '25 hours'
      order by created_at
      limit 500
      for update skip locked
    );
    return true;
  end if;

  return false;
end;
$$;

revoke all on function public.rate_limit_hit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, text, integer, integer) to service_role;
`;

// ───────────── Vaste antwoordduur (N4) ─────────────

/**
 * Voert `werk` uit en antwoordt nooit sneller dan `minMs`, ook niet bij een
 * fout (die komt pas na de wachttijd). Zo duurt een bekend adres even lang als
 * een nieuw: geen lidmaatschapsorakel via de responstijd. Uit Eagle-Eye
 * (`slijpdagInschrijven`, 3,5 s).
 *
 * ⚠️ Dat werkt enkel als `werk` altijd korter duurt dan `minMs`. Een mail via
 * Resend kan dat niet beloven: verstuur die na het antwoord
 * (`EdgeRuntime.waitUntil`, `ctx.waitUntil` in een Worker), niet erbinnen.
 *
 * Gooit een `RangeError` als `minMs` geen eindig getal ≥ 0 is.
 */
export async function metVasteDuur<T>(
  minMs: number,
  werk: () => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(minMs) || minMs < 0) {
    throw new RangeError("metVasteDuur: minMs moet een getal >= 0 zijn");
  }
  const start = Date.now();
  const wacht = () =>
    new Promise<void>((klaar) =>
      setTimeout(klaar, Math.max(0, minMs - (Date.now() - start)))
    );
  try {
    const uit = await werk();
    await wacht();
    return uit;
  } catch (e) {
    await wacht();
    throw e;
  }
}
