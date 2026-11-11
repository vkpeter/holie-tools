/**
 * Gedeeld gebruikersbeheer voor de apps van Peter (0.32.0, 9 nov 2026).
 *
 * Drie lagen, elk los te gebruiken:
 *
 * 1. **Regels** (puur TS, in het scherm én op de server): `magRolWijzigen`, `magDeactiveren`,
 *    `magVerwijderen`, `statusVan`, `normaliseerNaam`. E-mail gaat door `./velden`.
 * 2. **Server** (Deno en Node): `zoekAccountOpEmail`, `nodigUit`, `wijzigEmail`, `wijzigNaam`,
 *    `zetActief`, `verwijder` en `vereisBeheerder`. Ze krijgen de admin-client (service-role)
 *    mee en lezen zelf geen omgevingsvariabelen. De Postgres-kant staat in `sql/gebruikers.sql`.
 * 3. **Scherm**: `maakGebruikersBeheer(React)`, zelfde patroon als `maakLoginBlok`: de app geeft
 *    haar eigen React mee, en optioneel haar eigen knop, invoerveld, keuzelijst en dialoog.
 *
 * Het rolmodel blijft van de app (enum, rollen per organisatie, abonnementsrollen). Dit pakket
 * krijgt de rollen als instelling: welke rollen het scherm mag toewijzen, welke als beheerder
 * tellen, en of iemand er meer dan één mag dragen.
 *
 * @module
 */
import { bearerToken } from "./auth.ts";
import type { AppComponent, Inhoud, ReactLike } from "./login.ts";
import { sendMail } from "./mail.ts";
import { normaliseerEmail, schoonRegel } from "./velden.ts";

export type { AppComponent, Inhoud, ReactLike } from "./login.ts";

// ───────────── Gegevens ─────────────

/**
 * Status van een account, afgeleid uit GoTrue (`statusVan`):
 * - `uitgenodigd`: nog nooit aangemeld;
 * - `actief`: al eens aangemeld en niet geblokkeerd;
 * - `gedeactiveerd`: geblokkeerd (`banned_until` in de toekomst).
 */
export type GebruikerStatus = "uitgenodigd" | "actief" | "gedeactiveerd";

/** Eén rij in het beheerscherm. */
export interface Gebruiker {
  id: string;
  email: string;
  naam?: string | null;
  /** Alle rollen, ook die het scherm niet toewijst (bv. `key_user`); die verschijnen als label. */
  rollen: readonly string[];
  status: GebruikerStatus;
  aangemaakt?: string | null;
  laatsteLogin?: string | null;
}

/** Het rolmodel van de app, als instelling. */
export interface RolInstelling {
  /** Rollen die het scherm mag toewijzen, in deze volgorde getoond. */
  toewijsbaar: readonly string[];
  /** Rollen die als beheerder tellen, voor "niet de laatste beheerder". */
  beheerders: readonly string[];
  /** Mag iemand meer dan één toewijsbare rol tegelijk dragen? Standaard `false`. */
  meerdere?: boolean;
}

/** De velden van een GoTrue-account die dit pakket leest (`auth.admin.getUserById`). */
export interface AuthAccount {
  id: string;
  email?: string | null;
  banned_until?: string | null;
  last_sign_in_at?: string | null;
  created_at?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

/** Status uit een GoTrue-account. `nu` enkel voor tests. */
export function statusVan(
  account: Pick<AuthAccount, "banned_until" | "last_sign_in_at">,
  nu: Date = new Date(),
): GebruikerStatus {
  const ban = account.banned_until ? Date.parse(account.banned_until) : NaN;
  if (!Number.isNaN(ban) && ban > nu.getTime()) return "gedeactiveerd";
  if (!account.last_sign_in_at) return "uitgenodigd";
  return "actief";
}

/** Langste naam die we bewaren. */
export const NAAM_MAX_LENGTE = 100;

/**
 * Naam van een gebruiker: één regel via `schoonRegel` (onzichtbare tekens weg, spaties samen).
 * `""` is een lege naam (wissen mag); `null` is ongeldig (geen tekst, of langer dan 100 tekens).
 */
export function normaliseerNaam(invoer: unknown): string | null {
  if (typeof invoer !== "string") return null;
  if (invoer.length > NAAM_MAX_LENGTE * 4) return null;
  const naam = schoonRegel(invoer);
  return naam.length > NAAM_MAX_LENGTE ? null : naam;
}

// ───────────── Regels ─────────────

/** Waarom een handeling geweigerd wordt. De teksten staan in `GEBRUIKERS_TEKSTEN`. */
export type Weigering =
  | "zelf"
  | "laatste_beheerder"
  | "onbekende_rol"
  | "geen_rol"
  | "te_veel_rollen"
  | "bevestiging";

/** Uitkomst van een regel. */
export type Oordeel = { ok: true } | { ok: false; reden: Weigering };

const JA: Oordeel = { ok: true };
const nee = (reden: Weigering): Oordeel => ({ ok: false, reden });

function isBeheerder(
  rollen: readonly string[],
  beheerders: readonly string[],
): boolean {
  return rollen.some((r) => beheerders.includes(r));
}

/**
 * Hoeveel beheerders er zijn die nog kunnen aanmelden (niet gedeactiveerd). Voor
 * `aantalBeheerders` in de regels.
 */
export function telBeheerders(
  gebruikers: readonly Pick<Gebruiker, "rollen" | "status">[],
  beheerders: readonly string[],
): number {
  return gebruikers.filter((g) =>
    g.status !== "gedeactiveerd" && isBeheerder(g.rollen, beheerders)
  ).length;
}

/** Invoer van `magRolWijzigen`. */
export interface RolWijziging {
  aanroeperId: string;
  doel: { id: string; rollen: readonly string[] };
  /** De nieuwe toewijsbare rollen (de andere rollen van het doel blijven). */
  nieuweRollen: readonly string[];
  /** Aantal beheerders nu, het doel inbegrepen (`telBeheerders`). */
  aantalBeheerders: number;
  instelling: RolInstelling;
}

/**
 * Mag deze rolwijziging? Niet je eigen rol, minstens één rol, enkel toewijsbare rollen, één rol
 * als `meerdere` uit staat, en nooit de laatste beheerder degraderen.
 *
 * ⚠️ Dit is de regel voor het scherm en de server. De databank moet hem zelf ook afdwingen,
 * atomair (zie `sql/gebruikers.sql`): twee gelijktijdige degradaties zien elk nog een andere
 * beheerder staan.
 */
export function magRolWijzigen(w: RolWijziging): Oordeel {
  if (w.doel.id === w.aanroeperId) return nee("zelf");
  const nieuw = [...new Set(w.nieuweRollen)];
  if (nieuw.length === 0) return nee("geen_rol");
  if (nieuw.some((r) => !w.instelling.toewijsbaar.includes(r))) {
    return nee("onbekende_rol");
  }
  if (!w.instelling.meerdere && nieuw.length > 1) return nee("te_veel_rollen");
  const b = w.instelling.beheerders;
  if (
    isBeheerder(w.doel.rollen, b) && !isBeheerder(nieuw, b) &&
    w.aantalBeheerders <= 1
  ) {
    return nee("laatste_beheerder");
  }
  return JA;
}

/** Invoer van `magDeactiveren`. */
export interface Deactivering {
  aanroeperId: string;
  doel: { id: string; rollen: readonly string[] };
  aantalBeheerders: number;
  beheerders: readonly string[];
}

/** Mag dit account geblokkeerd worden? Niet jezelf, niet de laatste beheerder. */
export function magDeactiveren(d: Deactivering): Oordeel {
  if (d.doel.id === d.aanroeperId) return nee("zelf");
  if (isBeheerder(d.doel.rollen, d.beheerders) && d.aantalBeheerders <= 1) {
    return nee("laatste_beheerder");
  }
  return JA;
}

/** Invoer van `magVerwijderen`. */
export interface Verwijdering {
  aanroeperId: string;
  doel: { id: string; email: string; rollen?: readonly string[] };
  /** Wat de beheerder als bevestiging intypte: het e-mailadres van het doel. */
  bevestiging: unknown;
  /** Met `beheerders` erbij: ook de laatste beheerder beschermen. */
  aantalBeheerders?: number;
  beheerders?: readonly string[];
}

/**
 * Mag dit account weg? Niet jezelf, de bevestiging is het e-mailadres van het doel (na
 * `normaliseerEmail`, dus hoofdletters en plakspaties tellen niet), en niet de laatste beheerder.
 */
export function magVerwijderen(v: Verwijdering): Oordeel {
  if (v.doel.id === v.aanroeperId) return nee("zelf");
  const getypt = normaliseerEmail(v.bevestiging);
  if (!getypt || getypt !== normaliseerEmail(v.doel.email)) {
    return nee("bevestiging");
  }
  if (
    v.beheerders && v.aantalBeheerders !== undefined &&
    isBeheerder(v.doel.rollen ?? [], v.beheerders) && v.aantalBeheerders <= 1
  ) {
    return nee("laatste_beheerder");
  }
  return JA;
}

// ───────────── Server ─────────────

/**
 * Het deel van een supabase-js-client met service-role-sleutel dat de serverfuncties gebruiken.
 * `createClient(url, serviceKey)` past erop, in Deno en in Node. Bewust losse types: zo past
 * elke versie van supabase-js, ook een client met `Database`-types.
 */
export interface AdminClient {
  auth: {
    admin: {
      // deno-lint-ignore no-explicit-any
      generateLink: (...args: any[]) => Promise<any>;
      // deno-lint-ignore no-explicit-any
      getUserById: (...args: any[]) => Promise<any>;
      // deno-lint-ignore no-explicit-any
      updateUserById: (...args: any[]) => Promise<any>;
      // deno-lint-ignore no-explicit-any
      deleteUser: (...args: any[]) => Promise<any>;
    };
  };
  // deno-lint-ignore no-explicit-any
  rpc: (...args: any[]) => any;
}

/** Uitkomst van een serverfunctie. `fout` is een vaste code; `detail` de melding van GoTrue. */
export type Resultaat<T = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; fout: ServerFout; detail?: string };

/** Foutcodes van de serverfuncties. */
export type ServerFout =
  | "ongeldig_email"
  | "ongeldige_naam"
  | "zoeken"
  | "niet_gevonden"
  | "bezet"
  | "link"
  | "mail"
  | "bijwerken"
  | "verwijderen";

function fout(code: ServerFout, detail?: unknown): Resultaat<never> {
  const tekst = typeof detail === "string"
    ? detail
    : (detail as { message?: unknown } | null)?.message;
  return typeof tekst === "string" && tekst
    ? { ok: false, fout: code, detail: tekst.slice(0, 300) }
    : { ok: false, fout: code };
}

/** Standaardnaam van de opzoekfunctie in de databank (`sql/gebruikers.sql`). */
export const ACCOUNT_OP_EMAIL_RPC = "account_op_email";

/**
 * Id van het account met dit e-mailadres, of `null`. Eén RPC (`account_op_email`, enkel voor de
 * service-role) in plaats van `auth.admin.listUsers` per pagina af te lopen: dat was traag en
 * stond twee keer gekopieerd.
 */
export async function zoekAccountOpEmail(
  admin: AdminClient,
  email: unknown,
  opties: { rpc?: string } = {},
): Promise<Resultaat<{ id: string | null }>> {
  const adres = normaliseerEmail(email);
  if (!adres) return fout("ongeldig_email");
  const { data, error } = await admin.rpc(
    opties.rpc ?? ACCOUNT_OP_EMAIL_RPC,
    { p_email: adres },
  );
  if (error) return fout("zoeken", error);
  return { ok: true, id: typeof data === "string" && data ? data : null };
}

/** Het account met dit id, of de fout `niet_gevonden`. */
export async function haalAccount(
  admin: AdminClient,
  id: string,
): Promise<Resultaat<{ account: AuthAccount }>> {
  const { data, error } = await admin.auth.admin.getUserById(id);
  const account = data?.user as AuthAccount | undefined;
  if (error || !account) return fout("niet_gevonden", error);
  return { ok: true, account };
}

/** De mail van een uitnodiging. De app schrijft haar eigen sjabloon (huisstijl, escapen). */
export interface UitnodigMail {
  /** Resend-sleutel. */
  apiKey: string;
  /** Afzender, bv. `"Tickbook <tickbook@holie.be>"`. */
  from: string;
  onderwerp: string;
  /** HTML met de link. `naam` is de genormaliseerde naam (kan leeg zijn): escape hem zelf. */
  html: (link: string, naam: string) => string;
  text?: (link: string, naam: string) => string;
  replyTo?: string;
  /** Enkel voor tests. */
  apiBasis?: string;
}

/** Opties van `nodigUit`. */
export interface UitnodigOpties {
  email: unknown;
  naam?: unknown;
  /** Waar GoTrue na de link naartoe stuurt. */
  redirectTo: string;
  /**
   * Maakt van de ruwe link van GoTrue de eigen bevestigingslink (bv. `/auth/confirm?token_hash=`),
   * zodat een mailscanner die de link opent het eenmalige token niet verbruikt.
   */
  bevestigLink: (actionLink: string) => string;
  mail: UitnodigMail;
  /** Extra metadata voor een NIEUW account (`raw_user_meta_data`). */
  metadata?: Record<string, unknown>;
  /** Sleutel van de naam in de metadata. Standaard `full_name`. */
  naamSleutel?: string;
  /** Naam van de opzoekfunctie. Standaard `account_op_email`. */
  rpc?: string;
  /**
   * Bestaat het account al en heeft het al aangemeld: toch een loginlink sturen? Standaard
   * `false`: dan komt `status: "bestaat"` terug, zonder link en zonder mail.
   */
  ookBestaand?: boolean;
  /** Alles nagaan, niets aanmaken en niets mailen. */
  droog?: boolean;
  /** Resend-idempotentiesleutel. Standaard `uitnodiging/<id>/<minuut>`: een dubbele klik mailt één keer. */
  idempotentieSleutel?: string;
}

/** Uitkomst van `nodigUit`. */
export type UitnodigUitslag =
  & Resultaat<{
    /**
     * - `uitgenodigd`: nieuw account, uitnodiging gemaild;
     * - `opnieuw`: het account bestond maar meldde nog nooit aan, nieuwe link gemaild;
     * - `bestaat`: het account is al in gebruik, er is niets gemaild (tenzij `ookBestaand`).
     */
    status: "uitgenodigd" | "opnieuw" | "bestaat";
    /** Id van het account; `null` bij een droge run voor een nieuw adres. */
    id: string | null;
    email: string;
    droog?: true;
  }>
  & { id?: string | null };

/**
 * Nodigt iemand uit, of stuurt een nieuwe link naar wie nog nooit aanmeldde. Idempotent: een
 * bestaand account krijgt nooit een tweede account, een account in gebruik krijgt (standaard)
 * geen mail, en dezelfde minuut twee keer klikken mailt één keer.
 *
 * Werkwijze: `generateLink` (type `invite` voor een nieuw adres, `magiclink` voor een bestaand),
 * de link door `bevestigLink`, mail via `./mail`. Het account bestaat zodra de link gemaakt is;
 * mislukt de mail daarna, dan staat het als "uitgenodigd" en kan "opnieuw sturen" het herstellen.
 */
export async function nodigUit(
  admin: AdminClient,
  o: UitnodigOpties,
): Promise<UitnodigUitslag> {
  const email = normaliseerEmail(o.email);
  if (!email) return fout("ongeldig_email");
  const naam = normaliseerNaam(o.naam ?? "");
  if (naam === null) return fout("ongeldige_naam");

  const zoek = await zoekAccountOpEmail(admin, email, { rpc: o.rpc });
  if (!zoek.ok) return zoek;

  let status: "uitgenodigd" | "opnieuw" | "bestaat" = "uitgenodigd";
  if (zoek.id) {
    const acc = await haalAccount(admin, zoek.id);
    if (!acc.ok) return acc;
    const nu = statusVan(acc.account);
    if (nu !== "uitgenodigd" && !o.ookBestaand) {
      return { ok: true, status: "bestaat", id: zoek.id, email };
    }
    status = nu === "uitgenodigd" ? "opnieuw" : "bestaat";
  }
  if (o.droog) return { ok: true, status, id: zoek.id, email, droog: true };

  const sleutel = o.naamSleutel ?? "full_name";
  const { data, error } = await admin.auth.admin.generateLink(
    zoek.id
      ? { type: "magiclink", email, options: { redirectTo: o.redirectTo } }
      : {
        type: "invite",
        email,
        options: {
          redirectTo: o.redirectTo,
          data: { ...o.metadata, ...(naam ? { [sleutel]: naam } : {}) },
        },
      },
  );
  const actionLink = data?.properties?.action_link;
  const id: string | null = zoek.id ?? data?.user?.id ?? null;
  if (error || typeof actionLink !== "string" || !id) {
    return fout("link", error);
  }

  const link = o.bevestigLink(actionLink);
  const naamInMail = naam ||
    String((data?.user?.user_metadata ?? {})[sleutel] ?? "");
  const res = await sendMail({
    apiKey: o.mail.apiKey,
    from: o.mail.from,
    to: email,
    subject: o.mail.onderwerp,
    html: o.mail.html(link, naamInMail),
    text: o.mail.text?.(link, naamInMail),
    replyTo: o.mail.replyTo,
    apiBasis: o.mail.apiBasis,
    idempotencyKey: o.idempotentieSleutel ??
      `uitnodiging/${id}/${Math.floor(Date.now() / 60_000)}`,
  });
  if (!res.ok) return { ...fout("mail", res.fout), id };
  return { ok: true, status, id, email };
}

/**
 * Zet een nieuw e-mailadres, meteen bevestigd (een beheerder wijzigt het, niet de gebruiker).
 * Weigert een adres dat al bij een ander account hoort.
 */
export async function wijzigEmail(
  admin: AdminClient,
  id: string,
  email: unknown,
  opties: { rpc?: string } = {},
): Promise<Resultaat<{ email: string }>> {
  const adres = normaliseerEmail(email);
  if (!adres) return fout("ongeldig_email");
  const zoek = await zoekAccountOpEmail(admin, adres, opties);
  if (!zoek.ok) return zoek;
  if (zoek.id && zoek.id !== id) return fout("bezet");
  if (zoek.id === id) return { ok: true, email: adres };
  const { error } = await admin.auth.admin.updateUserById(id, {
    email: adres,
    email_confirm: true,
  });
  if (error) return fout("bijwerken", error);
  return { ok: true, email: adres };
}

/**
 * Zet de naam in de metadata (`user_metadata[sleutel]`, standaard `full_name`). GoTrue voegt de
 * metadata samen: andere sleutels blijven staan. Een lege naam wist de sleutel.
 */
export async function wijzigNaam(
  admin: AdminClient,
  id: string,
  naam: unknown,
  opties: { sleutel?: string } = {},
): Promise<Resultaat<{ naam: string }>> {
  const schoon = normaliseerNaam(naam);
  if (schoon === null) return fout("ongeldige_naam");
  const { error } = await admin.auth.admin.updateUserById(id, {
    user_metadata: { [opties.sleutel ?? "full_name"]: schoon || null },
  });
  if (error) return fout("bijwerken", error);
  return { ok: true, naam: schoon };
}

/** Een blokkade van 100 jaar: GoTrue kent geen "voor altijd". */
export const BAN_DUUR = "876000h";

/**
 * Deactiveert (ban) of activeert (unban) een account. Een geblokkeerd account kan niet meer
 * aanmelden en zijn lopende tokens worden bij de volgende verversing geweigerd. Gegevens blijven.
 */
export async function zetActief(
  admin: AdminClient,
  id: string,
  actief: boolean,
): Promise<Resultaat> {
  const { error } = await admin.auth.admin.updateUserById(id, {
    ban_duration: actief ? "none" : BAN_DUUR,
  });
  if (error) return fout("bijwerken", error);
  return { ok: true };
}

/**
 * Verwijdert het account definitief. ⚠️ Rijen met `on delete cascade` naar `auth.users` gaan
 * mee: ga in de app eerst na of het account eigen gegevens heeft, en deactiveer dan liever.
 */
export async function verwijder(
  admin: AdminClient,
  id: string,
): Promise<Resultaat> {
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) return fout("verwijderen", error);
  return { ok: true };
}

/** Opties van `vereisBeheerder`. */
export interface BeheerderOpties {
  /**
   * De gebruiker bij een access token, of `null`. Bv.
   * `(t) => admin.auth.getUser(t).then((r) => r.data.user)`. Gebruik `getUser` (vraagt GoTrue),
   * niet enkel de handtekening: zo telt ook een afgemelde sessie als niet aangemeld.
   */
  gebruiker: (token: string) => Promise<{ id: string } | null | undefined>;
  /** De rolcheck van de app. Gooi bij een databankfout: dat wordt een 500. */
  isBeheerder: (userId: string) => Promise<boolean>;
  /** Extra headers op het foutantwoord (CORS). */
  headers?: Record<string, string>;
}

/**
 * Poort voor een serverfunctie die enkel een beheerder mag aanroepen. Geeft `{ userId }`, of een
 * antwoord om meteen terug te sturen: 401 zonder geldige sessie, 403 zonder rol, 500 als de
 * rolcheck faalt.
 */
export async function vereisBeheerder(
  req: Request,
  o: BeheerderOpties,
): Promise<{ userId: string } | Response> {
  const weiger = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { ...o.headers, "Content-Type": "application/json" },
    });
  const token = bearerToken(req);
  if (!token) return weiger(401, "Niet aangemeld");
  let gebruiker: { id: string } | null | undefined;
  try {
    gebruiker = await o.gebruiker(token);
  } catch {
    gebruiker = null;
  }
  if (!gebruiker?.id) return weiger(401, "Niet aangemeld");
  let mag: boolean;
  try {
    mag = await o.isBeheerder(gebruiker.id);
  } catch {
    return weiger(500, "Rolcheck mislukt");
  }
  if (!mag) return weiger(403, "Geen toegang");
  return { userId: gebruiker.id };
}

// ───────────── Teksten ─────────────

/** Alle teksten van het beheerscherm. `{x}` wordt ingevuld. */
export interface GebruikersTeksten {
  zoeken: string;
  naam: string;
  email: string;
  rol: string;
  status: string;
  acties: string;
  geenRol: string;
  jij: string;
  uitgenodigd: string;
  actief: string;
  gedeactiveerd: string;
  aangemaakt: string;
  laatsteLogin: string;
  nooit: string;
  uitnodigen: string;
  uitnodigingTitel: string;
  verstuur: string;
  bewerken: string;
  bewerkTitel: string;
  bewaren: string;
  annuleren: string;
  sluiten: string;
  opnieuwSturen: string;
  deactiveren: string;
  activeren: string;
  verwijderen: string;
  verwijderTitel: string;
  /** `{email}` */
  verwijderUitleg: string;
  typEmail: string;
  vorige: string;
  volgende: string;
  /** `{van}`, `{tot}`, `{totaal}` */
  pagina: string;
  geenGebruikers: string;
  laden: string;
  bezig: string;
  opgeslagen: string;
  /** Na verwijderen. */
  verwijderdMelding: string;
  /** Na uitschakelen. */
  gedeactiveerdMelding: string;
  /** Na weer inschakelen. */
  geactiveerdMelding: string;
  uitnodigingVerstuurd: string;
  onbekendeFout: string;
  zelf: string;
  laatste_beheerder: string;
  onbekende_rol: string;
  geen_rol: string;
  te_veel_rollen: string;
  bevestiging: string;
  ongeldigEmail: string;
  ongeldigeNaam: string;
}

/** Standaardteksten in nl, en, fr en de. */
export const GEBRUIKERS_TEKSTEN: Record<
  "nl" | "en" | "fr" | "de",
  GebruikersTeksten
> = {
  nl: {
    zoeken: "Zoek op naam of e-mail…",
    naam: "Naam",
    email: "E-mail",
    rol: "Rol",
    status: "Status",
    acties: "Acties",
    geenRol: "Geen rol",
    jij: "jij",
    uitgenodigd: "Uitgenodigd",
    actief: "Actief",
    gedeactiveerd: "Gedeactiveerd",
    aangemaakt: "Aangemaakt",
    laatsteLogin: "Laatst aangemeld",
    nooit: "nooit",
    uitnodigen: "Gebruiker uitnodigen",
    uitnodigingTitel: "Iemand uitnodigen",
    verstuur: "Uitnodiging sturen",
    bewerken: "Bewerken",
    bewerkTitel: "Gebruiker bewerken",
    bewaren: "Bewaren",
    annuleren: "Annuleren",
    sluiten: "Sluiten",
    opnieuwSturen: "Opnieuw sturen",
    deactiveren: "Deactiveren",
    activeren: "Activeren",
    verwijderen: "Verwijderen",
    verwijderTitel: "Gebruiker verwijderen",
    verwijderUitleg:
      "Het account {email} verdwijnt definitief. Typ het e-mailadres om te bevestigen.",
    typEmail: "E-mailadres ter bevestiging",
    vorige: "Vorige",
    volgende: "Volgende",
    pagina: "{van}-{tot} van {totaal}",
    geenGebruikers: "Geen gebruikers gevonden.",
    laden: "Laden…",
    bezig: "Bezig…",
    opgeslagen: "Opgeslagen.",
    verwijderdMelding: "Gebruiker verwijderd.",
    gedeactiveerdMelding: "Gebruiker uitgeschakeld.",
    geactiveerdMelding: "Gebruiker weer ingeschakeld.",
    uitnodigingVerstuurd: "Uitnodiging verstuurd.",
    onbekendeFout: "Er ging iets mis. Probeer opnieuw.",
    zelf: "Dat kan niet voor je eigen account.",
    laatste_beheerder: "Dit is de laatste beheerder.",
    onbekende_rol: "Deze rol kan hier niet gekozen worden.",
    geen_rol: "Kies minstens één rol.",
    te_veel_rollen: "Kies één rol.",
    bevestiging: "Het getypte adres klopt niet.",
    ongeldigEmail: "Dit e-mailadres klopt niet.",
    ongeldigeNaam: "Deze naam is te lang.",
  },
  en: {
    zoeken: "Search by name or email…",
    naam: "Name",
    email: "Email",
    rol: "Role",
    status: "Status",
    acties: "Actions",
    geenRol: "No role",
    jij: "you",
    uitgenodigd: "Invited",
    actief: "Active",
    gedeactiveerd: "Deactivated",
    aangemaakt: "Created",
    laatsteLogin: "Last sign-in",
    nooit: "never",
    uitnodigen: "Invite user",
    uitnodigingTitel: "Invite someone",
    verstuur: "Send invitation",
    bewerken: "Edit",
    bewerkTitel: "Edit user",
    bewaren: "Save",
    annuleren: "Cancel",
    sluiten: "Close",
    opnieuwSturen: "Resend",
    deactiveren: "Deactivate",
    activeren: "Activate",
    verwijderen: "Delete",
    verwijderTitel: "Delete user",
    verwijderUitleg:
      "The account {email} will be deleted permanently. Type the email address to confirm.",
    typEmail: "Email address to confirm",
    vorige: "Previous",
    volgende: "Next",
    pagina: "{van}-{tot} of {totaal}",
    geenGebruikers: "No users found.",
    laden: "Loading…",
    bezig: "Busy…",
    opgeslagen: "Saved.",
    verwijderdMelding: "User deleted.",
    gedeactiveerdMelding: "User disabled.",
    geactiveerdMelding: "User enabled again.",
    uitnodigingVerstuurd: "Invitation sent.",
    onbekendeFout: "Something went wrong. Please try again.",
    zelf: "Not possible for your own account.",
    laatste_beheerder: "This is the last administrator.",
    onbekende_rol: "This role cannot be chosen here.",
    geen_rol: "Choose at least one role.",
    te_veel_rollen: "Choose one role.",
    bevestiging: "The address you typed does not match.",
    ongeldigEmail: "This email address is not valid.",
    ongeldigeNaam: "This name is too long.",
  },
  fr: {
    zoeken: "Rechercher par nom ou e-mail…",
    naam: "Nom",
    email: "E-mail",
    rol: "Rôle",
    status: "Statut",
    acties: "Actions",
    geenRol: "Aucun rôle",
    jij: "vous",
    uitgenodigd: "Invité",
    actief: "Actif",
    gedeactiveerd: "Désactivé",
    aangemaakt: "Créé",
    laatsteLogin: "Dernière connexion",
    nooit: "jamais",
    uitnodigen: "Inviter un utilisateur",
    uitnodigingTitel: "Inviter quelqu'un",
    verstuur: "Envoyer l'invitation",
    bewerken: "Modifier",
    bewerkTitel: "Modifier l'utilisateur",
    bewaren: "Enregistrer",
    annuleren: "Annuler",
    sluiten: "Fermer",
    opnieuwSturen: "Renvoyer",
    deactiveren: "Désactiver",
    activeren: "Activer",
    verwijderen: "Supprimer",
    verwijderTitel: "Supprimer l'utilisateur",
    verwijderUitleg:
      "Le compte {email} sera supprimé définitivement. Tapez l'adresse e-mail pour confirmer.",
    typEmail: "Adresse e-mail pour confirmer",
    vorige: "Précédent",
    volgende: "Suivant",
    pagina: "{van}-{tot} sur {totaal}",
    geenGebruikers: "Aucun utilisateur trouvé.",
    laden: "Chargement…",
    bezig: "Un instant…",
    opgeslagen: "Enregistré.",
    verwijderdMelding: "Utilisateur supprimé.",
    gedeactiveerdMelding: "Utilisateur désactivé.",
    geactiveerdMelding: "Utilisateur réactivé.",
    uitnodigingVerstuurd: "Invitation envoyée.",
    onbekendeFout: "Une erreur s'est produite. Réessayez.",
    zelf: "Impossible pour votre propre compte.",
    laatste_beheerder: "C'est le dernier administrateur.",
    onbekende_rol: "Ce rôle ne peut pas être choisi ici.",
    geen_rol: "Choisissez au moins un rôle.",
    te_veel_rollen: "Choisissez un seul rôle.",
    bevestiging: "L'adresse saisie ne correspond pas.",
    ongeldigEmail: "Cette adresse e-mail n'est pas valide.",
    ongeldigeNaam: "Ce nom est trop long.",
  },
  de: {
    zoeken: "Nach Name oder E-Mail suchen…",
    naam: "Name",
    email: "E-Mail",
    rol: "Rolle",
    status: "Status",
    acties: "Aktionen",
    geenRol: "Keine Rolle",
    jij: "Sie",
    uitgenodigd: "Eingeladen",
    actief: "Aktiv",
    gedeactiveerd: "Deaktiviert",
    aangemaakt: "Erstellt",
    laatsteLogin: "Zuletzt angemeldet",
    nooit: "nie",
    uitnodigen: "Benutzer einladen",
    uitnodigingTitel: "Jemanden einladen",
    verstuur: "Einladung senden",
    bewerken: "Bearbeiten",
    bewerkTitel: "Benutzer bearbeiten",
    bewaren: "Speichern",
    annuleren: "Abbrechen",
    sluiten: "Schließen",
    opnieuwSturen: "Erneut senden",
    deactiveren: "Deaktivieren",
    activeren: "Aktivieren",
    verwijderen: "Löschen",
    verwijderTitel: "Benutzer löschen",
    verwijderUitleg:
      "Das Konto {email} wird endgültig gelöscht. Geben Sie zur Bestätigung die E-Mail-Adresse ein.",
    typEmail: "E-Mail-Adresse zur Bestätigung",
    vorige: "Zurück",
    volgende: "Weiter",
    pagina: "{van}-{tot} von {totaal}",
    geenGebruikers: "Keine Benutzer gefunden.",
    laden: "Wird geladen…",
    bezig: "Einen Moment…",
    opgeslagen: "Gespeichert.",
    verwijderdMelding: "Benutzer gelöscht.",
    gedeactiveerdMelding: "Benutzer deaktiviert.",
    geactiveerdMelding: "Benutzer wieder aktiviert.",
    uitnodigingVerstuurd: "Einladung gesendet.",
    onbekendeFout: "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
    zelf: "Für Ihr eigenes Konto nicht möglich.",
    laatste_beheerder: "Dies ist der letzte Administrator.",
    onbekende_rol: "Diese Rolle kann hier nicht gewählt werden.",
    geen_rol: "Wählen Sie mindestens eine Rolle.",
    te_veel_rollen: "Wählen Sie eine Rolle.",
    bevestiging: "Die eingegebene Adresse stimmt nicht überein.",
    ongeldigEmail: "Diese E-Mail-Adresse ist ungültig.",
    ongeldigeNaam: "Dieser Name ist zu lang.",
  },
};

function vul(tekst: string, waarden: Record<string, string | number>): string {
  return tekst.replace(/\{(\w+)\}/g, (_, k) => String(waarden[k] ?? `{${k}}`));
}

// ───────────── Scherm ─────────────

/** Props die het scherm aan een eigen knop geeft. De varianten zijn die van shadcn `Button`. */
export interface BeheerKnopProps {
  type: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "outline" | "destructive" | "ghost";
  size?: "sm" | "default";
  className?: string;
  "aria-label"?: string;
  children?: string;
}

/** Props die het scherm aan een eigen invoerveld geeft (past op shadcn `Input`). */
export interface BeheerInvoerProps {
  id?: string;
  name: string;
  type: string;
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoComplete?: string;
  className?: string;
  "aria-label"?: string;
}

/** Een keuzelijst. shadcn `Select` is samengesteld: de app schrijft er een kleine omslag rond. */
export interface BeheerKeuzeProps {
  value: string;
  onChange: (waarde: string) => void;
  opties: readonly { waarde: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  "aria-label": string;
  className?: string;
}

/** Een dialoog. shadcn `Dialog` is samengesteld: de app schrijft er een kleine omslag rond. */
export interface BeheerDialoogProps {
  open: boolean;
  onSluit: () => void;
  titel: string;
  children?: Inhoud;
}

/** Eigen componenten van de app. Zonder: gewone HTML met `holie-gb`-klassen. */
export interface BeheerOnderdelen {
  Knop?: AppComponent<BeheerKnopProps>;
  Invoer?: AppComponent<BeheerInvoerProps>;
  Keuze?: AppComponent<BeheerKeuzeProps>;
  Dialoog?: AppComponent<BeheerDialoogProps>;
}

/** Een extra kolom van de app (bv. key-user-toegang, abonnement). */
export interface ExtraKolom {
  kop: Inhoud;
  cel: (g: Gebruiker) => Inhoud;
  /**
   * Kolom verbergen onder 640px (klasse `holie-gb-verberg`). Standaard altijd zichtbaar.
   */
  verbergSmal?: boolean;
}

/**
 * Een handeling van de app. Een string als antwoord is een foutmelding; een geweigerde promise
 * ook. Niets (of `null`) is gelukt; de app ververst daarna zelf `gebruikers`.
 */
export type Handeling<A extends unknown[]> = (...args: A) => unknown;

/** Props van het beheerscherm. */
export interface GebruikersBeheerProps {
  gebruikers: readonly Gebruiker[];
  /** Id van wie het scherm gebruikt: die rij is beschermd. */
  huidigeId: string;
  instelling: RolInstelling;
  /** Leesbare naam per rol. Standaard de rol zelf. */
  rolLabels?: Record<string, string>;
  laden?: boolean;
  /** Een foutmelding van het laden. */
  fout?: Inhoud;
  taal?: keyof typeof GEBRUIKERS_TEKSTEN;
  teksten?: Partial<GebruikersTeksten>;
  /** Rijen per pagina. Standaard 25. */
  perPagina?: number;
  onRol?: Handeling<[Gebruiker, string[]]>;
  onUitnodigen?: Handeling<[{ email: string; naam: string; rollen: string[] }]>;
  onOpnieuw?: Handeling<[Gebruiker]>;
  onActief?: Handeling<[Gebruiker, boolean]>;
  onVerwijder?: Handeling<[Gebruiker]>;
  onBewaar?: Handeling<[Gebruiker, { naam: string; email: string }]>;
  extraKolom?: ExtraKolom;
  /** Datum leesbaar maken. Standaard `toLocaleDateString` in de taal. */
  datum?: (iso: string) => string;
  onderdelen?: BeheerOnderdelen;
  /** Klasse op het buitenste element. */
  className?: string;
}

/** Het stukje DOM dat de ingebouwde dialoog nodig heeft (de module draait ook zonder DOM-typen). */
type DomEl = {
  focus(): void;
  isConnected: boolean;
  contains(el: unknown): boolean;
  hasAttribute(naam: string): boolean;
  getAttribute(naam: string): string | null;
  querySelector(kies: string): DomEl | null;
  querySelectorAll(kies: string): ArrayLike<DomEl>;
};
const doc = () =>
  (globalThis as { document?: { activeElement: DomEl | null } }).document;

const FOCUSBAAR =
  'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';

/** De opmaak zonder eigen componenten. Geen Tailwind: werkt overal. */
export const GEBRUIKERS_CSS = `
.holie-gb{display:flex;flex-direction:column;gap:1rem;width:100%}
.holie-gb-balk{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between}
.holie-gb-invoer,.holie-gb-keuze{min-height:2.5rem;padding:.375rem .625rem;border:1px solid #9ca3af;border-radius:var(--radius,.375rem);background:transparent;color:inherit;font:inherit;max-width:100%}
.holie-gb-balk .holie-gb-invoer{flex:1 1 14rem;max-width:22rem}
.holie-gb-knop{min-height:2.5rem;padding:.375rem .875rem;border:1px solid #1f1f1f;border-radius:var(--radius,.375rem);background:#1f1f1f;color:#fff;font:inherit;font-size:.875rem;cursor:pointer}
.holie-gb-knop[data-variant="outline"],.holie-gb-knop[data-variant="ghost"]{background:transparent;color:inherit;border-color:#9ca3af}
.holie-gb-knop[data-variant="ghost"]{border-color:transparent}
.holie-gb-knop[data-variant="destructive"]{background:#b3261e;border-color:#b3261e}
.holie-gb-knop:disabled{opacity:.5;cursor:default}
.holie-gb-tabel{width:100%;border-collapse:collapse;font-size:.875rem}
.holie-gb-tabel th{text-align:left;font-weight:600;padding:.5rem;border-bottom:1px solid rgba(127,127,127,.35)}
.holie-gb-tabel td{padding:.5rem;border-bottom:1px solid rgba(127,127,127,.2);vertical-align:top}
.holie-gb-naam{font-weight:600}
.holie-gb-sub{font-size:.8125rem;opacity:.75;word-break:break-all}
.holie-gb-label{display:inline-block;margin:.125rem .25rem .125rem 0;padding:.0625rem .5rem;border:1px solid rgba(127,127,127,.45);border-radius:999px;font-size:.75rem}
.holie-gb-status[data-status="uitgenodigd"]{border-color:#b26a00;color:#b26a00}
.holie-gb-status[data-status="actief"]{border-color:#1e7d32;color:#1e7d32}
.holie-gb-status[data-status="gedeactiveerd"]{opacity:.7}
.holie-gb-acties{display:flex;flex-wrap:wrap;gap:.25rem}
.holie-gb-rollen{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.holie-gb-vink{display:inline-flex;gap:.25rem;align-items:center}
.holie-gb-pagina{display:flex;gap:.5rem;align-items:center;justify-content:flex-end;font-size:.875rem}
.holie-gb-melding{padding:.5rem .75rem;border:1px solid;border-radius:var(--radius,.375rem);font-size:.875rem}
.holie-gb-melding[data-soort="fout"]{color:#b3261e;border-color:rgba(179,38,30,.4)}
.holie-gb-scherm{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(0,0,0,.45)}
.holie-gb-paneel{width:100%;max-width:28rem;max-height:90vh;overflow:auto;padding:1.25rem;border-radius:var(--radius,.5rem);background:#fff;color:#1f1f1f}
.dark .holie-gb-paneel,[data-theme="dark"] .holie-gb-paneel{background:#1f1f20;color:#e3e3e3;color-scheme:dark}
.dark .holie-gb-paneel .holie-gb-knop[data-variant="default"],[data-theme="dark"] .holie-gb-paneel .holie-gb-knop[data-variant="default"]{background:#e3e3e3;border-color:#e3e3e3;color:#1f1f20}
@media (prefers-color-scheme:dark){
:root:not(.light):not([data-theme="light"]) .holie-gb-paneel{background:#1f1f20;color:#e3e3e3;color-scheme:dark}
:root:not(.light):not([data-theme="light"]) .holie-gb-paneel .holie-gb-knop[data-variant="default"]{background:#e3e3e3;border-color:#e3e3e3;color:#1f1f20}
}
.holie-gb-paneel h2{margin:0 0 1rem;font-size:1.125rem}
.holie-gb-form{display:flex;flex-direction:column;gap:.75rem}
.holie-gb-veld{display:flex;flex-direction:column;gap:.25rem;font-size:.875rem}
.holie-gb-knoppen{display:flex;gap:.5rem;justify-content:flex-end;flex-wrap:wrap}
@media (max-width:640px){.holie-gb-verberg{display:none}}
`;

type Blad =
  | null
  | { soort: "uitnodig" }
  | { soort: "bewerk"; g: Gebruiker }
  | { soort: "verwijder"; g: Gebruiker };

type Melding = { soort: "fout" | "info"; tekst: string } | null;

/**
 * Maakt het beheerscherm met de React van de app.
 *
 * ```tsx
 * import * as React from "react";
 * import { maakGebruikersBeheer } from "@holie/tools/gebruikers";
 * const GebruikersBeheer = maakGebruikersBeheer(React);
 *
 * <GebruikersBeheer
 *   gebruikers={rijen}
 *   huidigeId={user.id}
 *   instelling={{ toewijsbaar: ["admin", "user"], beheerders: ["admin"] }}
 *   onRol={(g, [rol]) => zetRol(g.id, rol)}
 *   onActief={(g, actief) => roep("actief", { id: g.id, actief })}
 *   onderdelen={{ Knop: Button, Invoer: Input, Keuze: MijnSelect, Dialoog: MijnDialoog }}
 * />
 * ```
 */
export function maakGebruikersBeheer<R extends ReactLike>(
  React: R,
): (props: GebruikersBeheerProps) => ReturnType<R["createElement"]> {
  const h = React.createElement;

  /** Focusbare elementen binnen een container. */
  const focusbaar = (el: DomEl) =>
    Array.from(el.querySelectorAll(FOCUSBAAR)).filter((e) =>
      !e.hasAttribute("disabled") && e.getAttribute("aria-hidden") !== "true"
    );

  /**
   * De ingebouwde dialoog met focusbeheer: focus erin bij openen, Tab blijft binnen het paneel,
   * Escape sluit, en bij sluiten gaat de focus terug naar waar hij was. Bestaat dat element niet
   * meer, dan naar `terugval`. Alleen aangekoppeld terwijl de dialoog open is.
   */
  function Paneel(props: {
    titelId: string;
    titel: string;
    onSluit: () => void;
    terugval: () => DomEl | null;
    children?: Inhoud;
  }) {
    type Staat = {
      paneel: DomEl | null;
      vorig: DomEl | null;
      terugval: () => DomEl | null;
    };
    // Het element met focus vóór het openen: de eerste render komt voor elke focusverplaatsing.
    const [s] = React.useState((): Staat => ({
      paneel: null,
      vorig: (doc()?.activeElement ?? null) as
        | DomEl
        | null,
      terugval: props.terugval,
    })) as [Staat, unknown];
    s.terugval = props.terugval;
    React.useEffect(() => {
      const paneel = s.paneel;
      if (paneel) (focusbaar(paneel)[0] ?? paneel).focus();
      return () => {
        const vorig = s.vorig;
        if (vorig && vorig.isConnected) {
          vorig.focus();
          if (doc()?.activeElement === vorig) return;
        }
        s.terugval()?.focus();
      };
    }, []);
    return h(
      "div",
      {
        className: "holie-gb-scherm",
        onClick: (e: { target: unknown; currentTarget: unknown }) => {
          if (e.target === e.currentTarget) props.onSluit();
        },
        onKeyDown: (
          e: { key: string; shiftKey: boolean; preventDefault(): void },
        ) => {
          if (e.key === "Escape") {
            props.onSluit();
            return;
          }
          const paneel = s.paneel;
          if (e.key !== "Tab" || !paneel) return;
          const lijst = focusbaar(paneel);
          if (lijst.length === 0) {
            e.preventDefault();
            paneel.focus();
            return;
          }
          const eerste = lijst[0];
          const laatste = lijst[lijst.length - 1];
          const actief = doc()?.activeElement;
          if (!paneel.contains(actief) || actief === paneel) {
            e.preventDefault();
            (e.shiftKey ? laatste : eerste).focus();
          } else if (e.shiftKey && actief === eerste) {
            e.preventDefault();
            laatste.focus();
          } else if (!e.shiftKey && actief === laatste) {
            e.preventDefault();
            eerste.focus();
          }
        },
      },
      h(
        "div",
        {
          className: "holie-gb-paneel",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": props.titelId,
          tabIndex: -1,
          ref: (el: DomEl | null) => {
            s.paneel = el;
          },
        },
        h("h2", { id: props.titelId }, props.titel),
        props.children,
      ),
    );
  }

  return function GebruikersBeheer(
    props: GebruikersBeheerProps,
  ): ReturnType<R["createElement"]> {
    const {
      gebruikers,
      huidigeId,
      instelling,
      rolLabels = {},
      laden,
      taal = "nl",
      perPagina = 25,
      extraKolom,
      onderdelen = {},
    } = props;
    const t: GebruikersTeksten = {
      ...GEBRUIKERS_TEKSTEN[taal],
      ...props.teksten,
    };
    const eigenId = React.useId();
    const [zoek, setZoek] = React.useState("") as [string, (v: string) => void];
    const [pagina, setPagina] = React.useState(0) as [
      number,
      (v: number) => void,
    ];
    const [bezig, setBezig] = React.useState(null) as [
      string | null,
      (v: string | null) => void,
    ];
    const [melding, setMelding] = React.useState(null) as [
      Melding,
      (v: Melding) => void,
    ];
    const [blad, setBlad] = React.useState(null) as [Blad, (v: Blad) => void];
    const [veld, setVeld] = React.useState({
      email: "",
      naam: "",
      rollen: [] as string[],
      bevestiging: "",
    }) as [
      { email: string; naam: string; rollen: string[]; bevestiging: string },
      (v: {
        email: string;
        naam: string;
        rollen: string[];
        bevestiging: string;
      }) => void,
    ];

    // Het beheerscherm zelf: terugval voor de focus als het element van vóór de dialoog weg is.
    const [wortel] = React.useState(() => ({
      el: null as DomEl | null,
    })) as [
      { el: DomEl | null },
      unknown,
    ];
    const terugvalFocus = () =>
      wortel.el?.querySelector('input[type="search"]') ??
        wortel.el;

    const label = (rol: string) => rolLabels[rol] ?? rol;
    const datum = props.datum ??
      ((iso: string) => {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(taal);
      });
    const aantalBeheerders = telBeheerders(gebruikers, instelling.beheerders);
    const weigerTekst = (o: Oordeel) => (o.ok ? "" : t[o.reden]);

    async function doe(
      sleutel: string,
      werk: () => unknown,
      gelukt: string,
    ): Promise<boolean> {
      if (bezig) return false;
      setBezig(sleutel);
      setMelding(null);
      try {
        const antwoord = await werk();
        if (typeof antwoord === "string") {
          setMelding({ soort: "fout", tekst: antwoord || t.onbekendeFout });
          return false;
        }
        setMelding({ soort: "info", tekst: gelukt });
        return true;
      } catch (e) {
        const tekst = e instanceof Error && e.message
          ? e.message
          : typeof e === "string" && e
          ? e
          : t.onbekendeFout;
        setMelding({ soort: "fout", tekst });
        return false;
      } finally {
        setBezig(null);
      }
    }

    // ── Bouwstenen: eigen component van de app, of gewone HTML ──
    const { Knop, Invoer, Keuze, Dialoog } = onderdelen;
    const knop = (p: BeheerKnopProps, sleutel?: string) =>
      Knop ? h(Knop, { key: sleutel, size: "sm", ...p }) : h("button", {
        key: sleutel,
        type: p.type,
        onClick: p.onClick,
        disabled: p.disabled,
        "aria-label": p["aria-label"],
        className: p.className ?? "holie-gb-knop",
        "data-variant": p.variant ?? "default",
      }, p.children);
    const invoer = (p: BeheerInvoerProps) =>
      Invoer ? h(Invoer, p) : h("input", {
        ...p,
        className: p.className ?? "holie-gb-invoer",
      });
    const keuze = (p: BeheerKeuzeProps) =>
      Keuze ? h(Keuze, p) : h(
        "select",
        {
          value: p.value,
          disabled: p.disabled,
          "aria-label": p["aria-label"],
          className: p.className ?? "holie-gb-keuze",
          onChange: (e: { target: { value: string } }) =>
            p.onChange(e.target.value),
        },
        ...p.opties.map((o) =>
          h(
            "option",
            { key: o.waarde, value: o.waarde, disabled: o.disabled },
            o.label,
          )
        ),
      );
    const dialoog = (p: BeheerDialoogProps) => {
      if (Dialoog) return h(Dialoog, p);
      if (!p.open) return null;
      return h(Paneel, {
        titelId: `${eigenId}-titel`,
        titel: p.titel,
        onSluit: p.onSluit,
        terugval: terugvalFocus,
        children: p.children,
      });
    };
    const veldBlok = (id: string, tekst: string, inhoud: Inhoud) =>
      h(
        "div",
        { className: "holie-gb-veld" },
        h("label", { htmlFor: id }, tekst),
        inhoud,
      );

    // ── Filter en pagina ──
    const zoekterm = zoek.trim().toLowerCase();
    const gefilterd = zoekterm
      ? gebruikers.filter((g) =>
        g.email.toLowerCase().includes(zoekterm) ||
        (g.naam ?? "").toLowerCase().includes(zoekterm)
      )
      : gebruikers;
    const aantalPaginas = Math.max(1, Math.ceil(gefilterd.length / perPagina));
    const p = Math.min(pagina, aantalPaginas - 1);
    const zichtbaar = gefilterd.slice(p * perPagina, (p + 1) * perPagina);

    // ── Handelingen ──
    const toewijsbareRollen = (g: Gebruiker) =>
      g.rollen.filter((r) => instelling.toewijsbaar.includes(r));

    function rolWijzigen(g: Gebruiker, rollen: string[]) {
      const oordeel = magRolWijzigen({
        aanroeperId: huidigeId,
        doel: g,
        nieuweRollen: rollen,
        aantalBeheerders,
        instelling,
      });
      if (!oordeel.ok) {
        setMelding({ soort: "fout", tekst: weigerTekst(oordeel) });
        return;
      }
      void doe(`rol:${g.id}`, () => props.onRol?.(g, rollen), t.opgeslagen);
    }

    function actiefZetten(g: Gebruiker, actief: boolean) {
      if (!actief) {
        const oordeel = magDeactiveren({
          aanroeperId: huidigeId,
          doel: g,
          aantalBeheerders,
          beheerders: instelling.beheerders,
        });
        if (!oordeel.ok) {
          setMelding({ soort: "fout", tekst: weigerTekst(oordeel) });
          return;
        }
      }
      void doe(
        `actief:${g.id}`,
        () => props.onActief?.(g, actief),
        actief ? t.geactiveerdMelding : t.gedeactiveerdMelding,
      );
    }

    function open(nieuw: Blad) {
      setMelding(null);
      setVeld({
        email: nieuw && nieuw.soort === "bewerk" ? nieuw.g.email : "",
        naam: nieuw && nieuw.soort === "bewerk" ? nieuw.g.naam ?? "" : "",
        rollen: instelling.toewijsbaar.length
          ? [instelling.toewijsbaar[instelling.toewijsbaar.length - 1]]
          : [],
        bevestiging: "",
      });
      setBlad(nieuw);
    }
    const sluit = () => setBlad(null);

    async function bewaar(e: { preventDefault(): void }) {
      e.preventDefault();
      if (!blad || blad.soort !== "bewerk") return;
      const email = normaliseerEmail(veld.email);
      if (!email) {
        setMelding({ soort: "fout", tekst: t.ongeldigEmail });
        return;
      }
      const naam = normaliseerNaam(veld.naam);
      if (naam === null) {
        setMelding({ soort: "fout", tekst: t.ongeldigeNaam });
        return;
      }
      const g = blad.g;
      if (
        await doe(
          `bewerk:${g.id}`,
          () => props.onBewaar?.(g, { naam, email }),
          t.opgeslagen,
        )
      ) sluit();
    }

    async function uitnodigen(e: { preventDefault(): void }) {
      e.preventDefault();
      const email = normaliseerEmail(veld.email);
      if (!email) {
        setMelding({ soort: "fout", tekst: t.ongeldigEmail });
        return;
      }
      const naam = normaliseerNaam(veld.naam);
      if (naam === null) {
        setMelding({ soort: "fout", tekst: t.ongeldigeNaam });
        return;
      }
      if (veld.rollen.length === 0) {
        setMelding({ soort: "fout", tekst: t.geen_rol });
        return;
      }
      if (
        await doe(
          "uitnodig",
          () => props.onUitnodigen?.({ email, naam, rollen: veld.rollen }),
          t.uitnodigingVerstuurd,
        )
      ) sluit();
    }

    async function verwijderen(e: { preventDefault(): void }) {
      e.preventDefault();
      if (!blad || blad.soort !== "verwijder") return;
      const g = blad.g;
      const oordeel = magVerwijderen({
        aanroeperId: huidigeId,
        doel: g,
        bevestiging: veld.bevestiging,
        aantalBeheerders,
        beheerders: instelling.beheerders,
      });
      if (!oordeel.ok) {
        setMelding({ soort: "fout", tekst: weigerTekst(oordeel) });
        return;
      }
      if (
        await doe(
          `verwijder:${g.id}`,
          () => props.onVerwijder?.(g),
          t.verwijderdMelding,
        )
      ) sluit();
    }

    // ── Rolkeuze ──
    function rolCel(g: Gebruiker) {
      const zelf = g.id === huidigeId;
      const huidige = toewijsbareRollen(g);
      const anders = g.rollen.filter((r) =>
        !instelling.toewijsbaar.includes(r)
      );
      const uit = zelf || !props.onRol || bezig !== null;
      let kiezer: Inhoud;
      if (instelling.meerdere) {
        kiezer = h(
          "div",
          { className: "holie-gb-rollen", role: "group", "aria-label": t.rol },
          ...instelling.toewijsbaar.map((rol) =>
            h(
              "label",
              { key: rol, className: "holie-gb-vink" },
              h("input", {
                type: "checkbox",
                checked: huidige.includes(rol),
                disabled: uit,
                onChange: () =>
                  rolWijzigen(
                    g,
                    huidige.includes(rol)
                      ? huidige.filter((r) => r !== rol)
                      : [...huidige, rol],
                  ),
              }),
              label(rol),
            )
          ),
        );
      } else {
        const waarde = huidige[0] ?? "";
        kiezer = keuze({
          value: waarde,
          disabled: uit,
          "aria-label": `${t.rol}: ${g.email}`,
          onChange: (w) => {
            if (w && w !== waarde) rolWijzigen(g, [w]);
          },
          opties: [
            ...(waarde
              ? []
              : [{ waarde: "", label: t.geenRol, disabled: true }]),
            ...instelling.toewijsbaar.map((r) => ({
              waarde: r,
              label: label(r),
            })),
          ],
        });
      }
      return h(
        "td",
        null,
        kiezer,
        anders.length
          ? h(
            "div",
            null,
            ...anders.map((r) =>
              h("span", { key: r, className: "holie-gb-label" }, label(r))
            ),
          )
          : null,
      );
    }

    function rij(g: Gebruiker) {
      const zelf = g.id === huidigeId;
      const acties: Inhoud[] = [];
      const vrij = bezig === null;
      if (props.onBewaar) {
        acties.push(knop({
          type: "button",
          variant: "outline",
          disabled: !vrij,
          onClick: () => open({ soort: "bewerk", g }),
          "aria-label": `${t.bewerken}: ${g.email}`,
          children: t.bewerken,
        }, "bewerk"));
      }
      if (props.onOpnieuw && g.status === "uitgenodigd") {
        acties.push(knop({
          type: "button",
          variant: "outline",
          disabled: !vrij,
          onClick: () =>
            void doe(
              `opnieuw:${g.id}`,
              () => props.onOpnieuw?.(g),
              t.uitnodigingVerstuurd,
            ),
          "aria-label": `${t.opnieuwSturen}: ${g.email}`,
          children: t.opnieuwSturen,
        }, "opnieuw"));
      }
      if (props.onActief && !zelf) {
        const isUit = g.status === "gedeactiveerd";
        acties.push(knop({
          type: "button",
          variant: "outline",
          disabled: !vrij,
          onClick: () => actiefZetten(g, isUit),
          "aria-label": `${isUit ? t.activeren : t.deactiveren}: ${g.email}`,
          children: isUit ? t.activeren : t.deactiveren,
        }, "actief"));
      }
      if (props.onVerwijder && !zelf) {
        acties.push(knop({
          type: "button",
          variant: "destructive",
          disabled: !vrij,
          onClick: () => open({ soort: "verwijder", g }),
          "aria-label": `${t.verwijderen}: ${g.email}`,
          children: t.verwijderen,
        }, "verwijder"));
      }
      return h(
        "tr",
        { key: g.id, "data-gebruiker": g.id },
        h(
          "td",
          null,
          h(
            "div",
            { className: "holie-gb-naam" },
            g.naam || g.email,
            zelf ? ` (${t.jij})` : null,
          ),
          g.naam ? h("div", { className: "holie-gb-sub" }, g.email) : null,
          h(
            "div",
            { className: "holie-gb-sub" },
            `${t.laatsteLogin}: ${
              g.laatsteLogin ? datum(g.laatsteLogin) : t.nooit
            }`,
          ),
        ),
        rolCel(g),
        h(
          "td",
          null,
          h(
            "span",
            {
              className: "holie-gb-label holie-gb-status",
              "data-status": g.status,
            },
            t[g.status],
          ),
        ),
        extraKolom
          ? h(
            "td",
            extraKolom.verbergSmal ? { className: "holie-gb-verberg" } : null,
            extraKolom.cel(g),
          )
          : null,
        h("td", null, h("div", { className: "holie-gb-acties" }, ...acties)),
      );
    }

    // ── Bladen ──
    let bladInhoud: Inhoud = null;
    let bladTitel = "";
    const knoppen = (bevestig: BeheerKnopProps) =>
      h(
        "div",
        { className: "holie-gb-knoppen" },
        knop({
          type: "button",
          variant: "outline",
          onClick: sluit,
          children: t.annuleren,
        }, "annuleer"),
        knop(bevestig, "ok"),
      );
    const zet =
      (k: "email" | "naam" | "bevestiging") =>
      (e: { target: { value: string } }) =>
        setVeld({ ...veld, [k]: e.target.value });
    const meldingBlok = melding
      ? h(
        "div",
        {
          className: "holie-gb-melding",
          "data-soort": melding.soort,
          role: melding.soort === "fout" ? "alert" : "status",
        },
        melding.tekst,
      )
      : null;

    if (blad?.soort === "bewerk") {
      bladTitel = t.bewerkTitel;
      bladInhoud = h(
        "form",
        { className: "holie-gb-form", onSubmit: bewaar },
        meldingBlok,
        veldBlok(
          `${eigenId}-naam`,
          t.naam,
          invoer({
            id: `${eigenId}-naam`,
            name: "naam",
            type: "text",
            autoComplete: "off",
            value: veld.naam,
            onChange: zet("naam"),
          }),
        ),
        veldBlok(
          `${eigenId}-email`,
          t.email,
          invoer({
            id: `${eigenId}-email`,
            name: "email",
            type: "email",
            autoComplete: "off",
            required: true,
            value: veld.email,
            onChange: zet("email"),
          }),
        ),
        knoppen({
          type: "submit",
          disabled: bezig !== null,
          children: bezig ? t.bezig : t.bewaren,
        }),
      );
    } else if (blad?.soort === "uitnodig") {
      bladTitel = t.uitnodigingTitel;
      const rolKiezer = instelling.meerdere
        ? h(
          "div",
          { className: "holie-gb-rollen", role: "group", "aria-label": t.rol },
          ...instelling.toewijsbaar.map((rol) =>
            h(
              "label",
              { key: rol, className: "holie-gb-vink" },
              h("input", {
                type: "checkbox",
                checked: veld.rollen.includes(rol),
                onChange: () =>
                  setVeld({
                    ...veld,
                    rollen: veld.rollen.includes(rol)
                      ? veld.rollen.filter((r) => r !== rol)
                      : [...veld.rollen, rol],
                  }),
              }),
              label(rol),
            )
          ),
        )
        : keuze({
          value: veld.rollen[0] ?? "",
          "aria-label": t.rol,
          onChange: (w) => setVeld({ ...veld, rollen: w ? [w] : [] }),
          opties: instelling.toewijsbaar.map((r) => ({
            waarde: r,
            label: label(r),
          })),
        });
      bladInhoud = h(
        "form",
        { className: "holie-gb-form", onSubmit: uitnodigen },
        meldingBlok,
        veldBlok(
          `${eigenId}-nemail`,
          t.email,
          invoer({
            id: `${eigenId}-nemail`,
            name: "email",
            type: "email",
            autoComplete: "off",
            required: true,
            value: veld.email,
            onChange: zet("email"),
          }),
        ),
        veldBlok(
          `${eigenId}-nnaam`,
          t.naam,
          invoer({
            id: `${eigenId}-nnaam`,
            name: "naam",
            type: "text",
            autoComplete: "off",
            value: veld.naam,
            onChange: zet("naam"),
          }),
        ),
        h(
          "div",
          { className: "holie-gb-veld" },
          h("span", null, t.rol),
          rolKiezer,
        ),
        knoppen({
          type: "submit",
          disabled: bezig !== null,
          children: bezig ? t.bezig : t.verstuur,
        }),
      );
    } else if (blad?.soort === "verwijder") {
      bladTitel = t.verwijderTitel;
      const klopt = normaliseerEmail(veld.bevestiging) ===
        normaliseerEmail(blad.g.email);
      bladInhoud = h(
        "form",
        { className: "holie-gb-form", onSubmit: verwijderen },
        meldingBlok,
        h("p", null, vul(t.verwijderUitleg, { email: blad.g.email })),
        veldBlok(
          `${eigenId}-bevestig`,
          t.typEmail,
          invoer({
            id: `${eigenId}-bevestig`,
            name: "bevestiging",
            type: "email",
            autoComplete: "off",
            value: veld.bevestiging,
            onChange: zet("bevestiging"),
          }),
        ),
        knoppen({
          type: "submit",
          variant: "destructive",
          disabled: !klopt || bezig !== null,
          children: bezig ? t.bezig : t.verwijderen,
        }),
      );
    }

    const kolommen = 4 + (extraKolom ? 1 : 0);
    const van = gefilterd.length ? p * perPagina + 1 : 0;
    const tot = Math.min((p + 1) * perPagina, gefilterd.length);

    return h(
      "div",
      {
        className: props.className ?? "holie-gb",
        "data-holie-gebruikers": "",
        tabIndex: -1,
        ref: (el: DomEl | null) => {
          wortel.el = el;
        },
      },
      h("style", null, GEBRUIKERS_CSS),
      h(
        "div",
        { className: "holie-gb-balk" },
        invoer({
          name: "zoeken",
          type: "search",
          value: zoek,
          placeholder: t.zoeken,
          "aria-label": t.zoeken,
          onChange: (e) => {
            setZoek(e.target.value);
            setPagina(0);
          },
        }),
        props.onUitnodigen
          ? knop({
            type: "button",
            disabled: bezig !== null,
            onClick: () => open({ soort: "uitnodig" }),
            children: t.uitnodigen,
          }, "uitnodig")
          : null,
      ),
      blad ? null : meldingBlok,
      props.fout
        ? h(
          "div",
          {
            className: "holie-gb-melding",
            "data-soort": "fout",
            role: "alert",
          },
          props.fout,
        )
        : null,
      h(
        "div",
        { style: { overflowX: "auto" } },
        h(
          "table",
          { className: "holie-gb-tabel" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", null, t.naam),
              h("th", null, t.rol),
              h("th", null, t.status),
              extraKolom
                ? h(
                  "th",
                  extraKolom.verbergSmal
                    ? { className: "holie-gb-verberg" }
                    : null,
                  extraKolom.kop,
                )
                : null,
              h("th", null, t.acties),
            ),
          ),
          h(
            "tbody",
            null,
            laden
              ? h("tr", null, h("td", { colSpan: kolommen }, t.laden))
              : zichtbaar.length === 0
              ? h("tr", null, h("td", { colSpan: kolommen }, t.geenGebruikers))
              : zichtbaar.map(rij),
          ),
        ),
      ),
      gefilterd.length > perPagina
        ? h(
          "div",
          { className: "holie-gb-pagina" },
          h(
            "span",
            null,
            vul(t.pagina, { van, tot, totaal: gefilterd.length }),
          ),
          knop({
            type: "button",
            variant: "outline",
            disabled: p === 0,
            onClick: () => setPagina(p - 1),
            children: t.vorige,
          }, "vorige"),
          knop({
            type: "button",
            variant: "outline",
            disabled: p >= aantalPaginas - 1,
            onClick: () => setPagina(p + 1),
            children: t.volgende,
          }, "volgende"),
        )
        : null,
      dialoog({
        open: blad !== null,
        onSluit: sluit,
        titel: bladTitel,
        children: bladInhoud,
      }),
    );
  };
}
