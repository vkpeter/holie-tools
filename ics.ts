/**
 * iCalendar-feeds (RFC 5545) bouwen: een kalender met hele-dag- en getimede events.
 *
 * Afkomstig uit Roundbook (28 okt 2026), daar gemaakt voor de agenda-feed die een
 * vakman in Google Agenda toevoegt via "Van URL". Hier de algemene versie met een
 * generiek event-type: de vertaling van een eigen dagdeel of status naar een event
 * blijft in het project zelf. De volgorde van de eigenschappen in een event is
 * dezelfde als in Roundbook, zodat een project na de overstap byte-gelijke uitvoer
 * geeft.
 *
 * Runtime-neutraal en zonder dependencies: enkel `TextEncoder` en `Date`, dus het
 * werkt in Supabase edge functions (Deno) en in een Cloudflare Worker.
 *
 * Privacy, bewust zo ontworpen (zoals `./telegram` en `./mail`):
 * - Deze module leest GEEN omgevingsvariabelen en logt niets. Wat in de feed komt,
 *   is exact wat het project meegeeft; het project beslist dus zelf welke
 *   persoonsgegevens (mail, telefoon) er nooit in mogen.
 * - Waarden die geen TEXT zijn (prodId, tzid, uid, regels van een eigen VTIMEZONE)
 *   worden ontdaan van alle controletekens. Zo kan een CR/LF in een invoerveld
 *   nooit een eigen regel in de feed injecteren.
 */

/** Content-Type voor het antwoord waarin de feed wordt uitgeleverd. */
export const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";

/** Vaste tijdzone-definitie voor Europe/Brussels (CET/CEST), als VTIMEZONE-regels. */
export const VTIMEZONE_BRUSSEL: readonly string[] = Object.freeze([
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Brussels",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
]);

/**
 * Een moment in een event:
 * - `{ datum }`: een hele dag (`'YYYY-MM-DD'`, jaar 1000 t/m 9998).
 * - `{ datum, tijd }`: een lokale tijd (`'HH:MM'` of `'HH:MM:SS'`) in de tijdzone van de
 *   kalender, geschreven als `DTSTART;TZID=...`.
 * - `Date`: een absoluut moment, geschreven in UTC (`...Z`).
 */
export type IcsMoment =
  | { datum: string }
  | { datum: string; tijd: string }
  | Date;

export interface IcsEvent {
  /** Volledige UID, bv. `${id}@roundbook.eu`. Wordt TEXT-geescapet. */
  uid: string;
  begin: IcsMoment;
  /**
   * Einde van het event. Bij een hele dag is dit, zoals in RFC 5545, de EERSTE dag die
   * er niet meer bij hoort. Zonder `einde` en zonder `duur` krijgt een hele dag de
   * volgende dag als einde; een getimed event krijgt dan geen einde. Moet na `begin`
   * liggen en van hetzelfde soort zijn (hele dag met hele dag, tijd met tijd).
   */
  einde?: IcsMoment;
  /** ISO-duur zoals `"PT1H"` of `"P2D"`. Niet samen met `einde` (dan ongeldig). */
  duur?: string;
  /** SUMMARY. */
  titel: string;
  /** DESCRIPTION; regeleinden worden `\n`. */
  beschrijving?: string;
  /** LOCATION. */
  locatie?: string;
  /**
   * URL. Wordt niet TEXT-geescapet; een CR/LF of ander controleteken maakt het event
   * ongeldig. Een lege tekst telt als weggelaten.
   */
  url?: string;
  status?: "TENTATIVE" | "CONFIRMED" | "CANCELLED";
  /**
   * `true` = bezet (TRANSP:OPAQUE), `false` = vrij (TRANSPARENT). Standaard: een hele
   * dag is vrij, een getimed event bezet.
   */
  bezet?: boolean;
  /** LAST-MODIFIED (UTC). Wordt weggelaten als de waarde geen geldige datum is. */
  gewijzigd?: Date | string;
}

export interface IcsKalender {
  /** PRODID, bv. `"-//Roundbook//Afspraken//NL"`. Controletekens worden verwijderd. */
  prodId: string;
  /** X-WR-CALNAME (TEXT-geescapet). */
  naam?: string;
  /**
   * Tijdzone voor lokale tijden. Standaard `"Europe/Brussels"` met `VTIMEZONE_BRUSSEL`.
   * Een eigen zone geeft `tzid` plus de volledige VTIMEZONE-regels (inclusief
   * `BEGIN:VTIMEZONE` en `END:VTIMEZONE`). In `tzid` verdwijnen controletekens en de
   * tekens `" ; : ,`, die een parameterwaarde zouden breken.
   */
  tijdzone?: "Europe/Brussels" | { tzid: string; definitie: string[] };
  /** ISO-duur, bv. `"PT1H"`: geeft REFRESH-INTERVAL en X-PUBLISHED-TTL. */
  verversen?: string;
  events: IcsEvent[];
}

export interface IcsOpties {
  /** Het "nu" voor DTSTAMP. Standaard `new Date()`; geef iets vast mee in tests. */
  nu?: Date;
  /**
   * Wat er met een ongeldig event gebeurt. Standaard `"overslaan"`: de feed blijft
   * werken. `"gooi"` gooit een `TypeError` met de reden. Een fout op kalenderniveau
   * (lege prodId, ongeldige `verversen` of `nu`) gooit altijd.
   */
  opOngeldig?: "overslaan" | "gooi";
}

const CRLF = "\r\n";
const MAX_OCTETTEN = 75;
const TEKST = new TextEncoder();

// ISO 8601-duur zoals RFC 5545 die kent: weken, of dagen en/of uren, minuten, seconden.
const DUUR =
  /^P(?:\d+W|(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/;
// Bij een hele dag zijn enkel weken en dagen toegestaan.
const DUUR_DAGEN = /^P(?:\d+W|\d+D)$/;
const TIJD = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

class IcsOngeldig extends TypeError {
  constructor(bericht: string) {
    super(bericht);
    this.name = "IcsOngeldig";
  }
}

/** Verwijdert alle controletekens (CR, LF, tab, NUL, DEL, ...) uit een niet-TEXT-waarde. */
function zonderControle(tekst: string): string {
  // deno-lint-ignore no-control-regex
  return tekst.replace(/[\u0000-\u001f\u007f]/g, "");
}

/**
 * Escapet een TEXT-waarde volgens RFC 5545: backslash eerst, dan `;` en `,`, en
 * regeleinden worden `\n`. Overige controletekens (behalve tab) verdwijnen.
 */
export function escapeIcsTekst(tekst: string): string {
  return tekst
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/**
 * Vouwt een regel op 75 octetten (UTF-8-bytes), nooit midden in een teken. Een
 * vervolgregel begint met een spatie en telt die mee in de 75.
 */
export function vouwIcsRegel(regel: string): string {
  if (TEKST.encode(regel).length <= MAX_OCTETTEN) return regel;
  const delen: string[] = [];
  let huidig = "";
  let bytes = 0;
  let limiet = MAX_OCTETTEN;
  for (const teken of regel) {
    const n = TEKST.encode(teken).length;
    if (bytes + n > limiet) {
      delen.push(huidig);
      huidig = "";
      bytes = 0;
      limiet = MAX_OCTETTEN - 1;
    }
    huidig += teken;
    bytes += n;
  }
  delen.push(huidig);
  return delen.join(CRLF + " ");
}

function utcBasis(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function pad(n: number, lengte: number): string {
  return String(n).padStart(lengte, "0");
}

interface Moment {
  soort: "dag" | "lokaal" | "utc";
  /** `DTSTART`-waarde zonder eigenschapsnaam: `YYYYMMDD`, `YYYYMMDDTHHMMSS` of met `Z`. */
  waarde: string;
  /** Sorteerbare sleutel binnen hetzelfde soort. */
  sleutel: string | number;
  j: number;
  m: number;
  d: number;
}

function leesMoment(
  moment: IcsMoment | undefined,
  naam: string,
  fout: (reden: string) => never,
): Moment {
  if (moment instanceof Date) {
    const ms = moment.getTime();
    const jaar = new Date(ms).getUTCFullYear();
    if (isNaN(ms) || jaar < 1000 || jaar > 9998) {
      fout(`${naam} is geen geldige Date`);
    }
    const w = utcBasis(moment);
    return {
      soort: "utc",
      waarde: w,
      sleutel: ms,
      j: jaar,
      m: moment.getUTCMonth() + 1,
      d: moment.getUTCDate(),
    };
  }
  if (
    typeof moment !== "object" || moment === null ||
    typeof moment.datum !== "string"
  ) {
    return fout(`${naam} ontbreekt of heeft geen datum`);
  }
  const dag = /^(\d{4})-(\d{2})-(\d{2})$/.exec(moment.datum);
  if (!dag) return fout(`${naam}: datum "${moment.datum}" is niet YYYY-MM-DD`);
  const j = Number(dag[1]);
  const m = Number(dag[2]);
  const d = Number(dag[3]);
  const controle = new Date(Date.UTC(j, m - 1, d));
  if (
    j < 1000 || j > 9998 || controle.getUTCFullYear() !== j ||
    controle.getUTCMonth() !== m - 1 || controle.getUTCDate() !== d
  ) {
    return fout(`${naam}: datum "${moment.datum}" bestaat niet`);
  }
  const ymd = `${pad(j, 4)}${pad(m, 2)}${pad(d, 2)}`;
  if ("tijd" in moment && moment.tijd !== undefined) {
    const t = typeof moment.tijd === "string" ? TIJD.exec(moment.tijd) : null;
    if (!t) {
      return fout(`${naam}: tijd "${moment.tijd}" is niet HH:MM of HH:MM:SS`);
    }
    const hms = `${t[1]}${t[2]}${t[3] ?? "00"}`;
    return {
      soort: "lokaal",
      waarde: `${ymd}T${hms}`,
      sleutel: `${ymd}T${hms}`,
      j,
      m,
      d,
    };
  }
  return { soort: "dag", waarde: ymd, sleutel: ymd, j, m, d };
}

/** De dag na `m` als `YYYYMMDD`, met UTC-rekenwerk zodat maand- en jaarwissel kloppen. */
function volgendeDag(m: Moment): string {
  const v = new Date(Date.UTC(m.j, m.m - 1, m.d + 1));
  return `${pad(v.getUTCFullYear(), 4)}${pad(v.getUTCMonth() + 1, 2)}${
    pad(v.getUTCDate(), 2)
  }`;
}

const STATUSSEN = ["TENTATIVE", "CONFIRMED", "CANCELLED"];

function bouwEvent(e: IcsEvent, stempel: string, tzid: string): string[] {
  const uid = zonderControle(typeof e?.uid === "string" ? e.uid : "");
  const fout = (reden: string): never => {
    throw new IcsOngeldig(
      `ongeldig event ${uid ? `"${uid}"` : "(zonder uid)"}: ${reden}`,
    );
  };
  if (uid.trim() === "") fout("uid ontbreekt of is leeg");
  if (typeof e.titel !== "string") fout("titel ontbreekt");

  const begin = leesMoment(e.begin, "begin", fout);
  const hele = begin.soort === "dag";

  if (e.duur !== undefined && e.einde !== undefined) {
    fout("duur en einde samen zijn niet toegestaan");
  }
  let einde: Moment | undefined;
  if (e.einde !== undefined) {
    einde = leesMoment(e.einde, "einde", fout);
    if ((einde.soort === "dag") !== hele) {
      fout(
        "begin en einde moeten allebei een hele dag zijn, of allebei een tijd",
      );
    }
    if (einde.soort === begin.soort && einde.sleutel <= begin.sleutel) {
      fout("einde ligt niet na begin");
    }
  }
  if (e.duur !== undefined) {
    if (typeof e.duur !== "string" || !DUUR.test(e.duur)) {
      fout(`duur "${e.duur}" is geen ISO-duur zoals PT1H`);
    }
    if (hele && !DUUR_DAGEN.test(e.duur)) {
      fout(`duur "${e.duur}" bij een hele dag moet in dagen of weken zijn`);
    }
  }
  if (e.status !== undefined && !STATUSSEN.includes(e.status)) {
    fout(`status "${e.status}" is onbekend`);
  }
  let url: string | undefined;
  if (e.url !== undefined && e.url !== "") {
    // deno-lint-ignore no-control-regex
    if (typeof e.url !== "string" || /[\u0000-\u001f\u007f]/.test(e.url)) {
      fout("url bevat een regeleinde of ander controleteken");
    }
    url = e.url;
  }

  const regels: string[] = [
    "BEGIN:VEVENT",
    `UID:${escapeIcsTekst(uid)}`,
    `DTSTAMP:${stempel}`,
  ];
  if (e.gewijzigd !== undefined) {
    const g = new Date(e.gewijzigd);
    if (!isNaN(g.getTime())) regels.push(`LAST-MODIFIED:${utcBasis(g)}`);
  }

  if (begin.soort === "dag") {
    regels.push(`DTSTART;VALUE=DATE:${begin.waarde}`);
  } else if (begin.soort === "lokaal") {
    regels.push(`DTSTART;TZID=${tzid}:${begin.waarde}`);
  } else {
    regels.push(`DTSTART:${begin.waarde}`);
  }

  if (e.duur !== undefined) {
    regels.push(`DURATION:${e.duur}`);
  } else if (einde) {
    if (einde.soort === "dag") regels.push(`DTEND;VALUE=DATE:${einde.waarde}`);
    else if (einde.soort === "lokaal") {
      regels.push(`DTEND;TZID=${tzid}:${einde.waarde}`);
    } else regels.push(`DTEND:${einde.waarde}`);
  } else if (hele) {
    regels.push(`DTEND;VALUE=DATE:${volgendeDag(begin)}`);
  }

  const bezet = e.bezet ?? !hele;
  regels.push(`TRANSP:${bezet ? "OPAQUE" : "TRANSPARENT"}`);
  if (e.status) regels.push(`STATUS:${e.status}`);
  regels.push(`SUMMARY:${escapeIcsTekst(e.titel)}`);
  if (e.locatie) regels.push(`LOCATION:${escapeIcsTekst(e.locatie)}`);
  if (e.beschrijving) {
    regels.push(`DESCRIPTION:${escapeIcsTekst(e.beschrijving)}`);
  }
  if (url) regels.push(`URL:${url}`);
  regels.push("END:VEVENT");
  return regels;
}

/**
 * Bouwt de volledige feed als tekst: VCALENDAR, VTIMEZONE en de events, elke regel
 * gevouwen en met CRLF ertussen en na de laatste regel. Een ongeldig event wordt
 * standaard overgeslagen, zodat een slechte rij de hele feed niet breekt; zie
 * `IcsOpties.opOngeldig`.
 */
export function bouwIcs(
  kalender: IcsKalender,
  opties: IcsOpties = {},
): string {
  const nu = opties.nu ?? new Date();
  if (isNaN(nu.getTime())) throw new TypeError("nu is geen geldige Date");
  const prodId = zonderControle(kalender.prodId ?? "");
  if (prodId.trim() === "") throw new TypeError("prodId ontbreekt of is leeg");
  if (kalender.verversen !== undefined && !DUUR.test(kalender.verversen)) {
    throw new TypeError(
      `verversen "${kalender.verversen}" is geen ISO-duur zoals PT1H`,
    );
  }

  const zone = kalender.tijdzone ?? "Europe/Brussels";
  let tzid: string;
  let definitie: readonly string[];
  if (zone === "Europe/Brussels") {
    tzid = "Europe/Brussels";
    definitie = VTIMEZONE_BRUSSEL;
  } else {
    tzid = zonderControle(zone.tzid ?? "").replace(/[";:,]/g, "");
    if (tzid === "") throw new TypeError("tzid ontbreekt of is leeg");
    definitie = (zone.definitie ?? []).map(zonderControle);
  }

  const stempel = utcBasis(nu);
  const regels: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  if (kalender.naam) {
    regels.push(`X-WR-CALNAME:${escapeIcsTekst(kalender.naam)}`);
  }
  regels.push(`X-WR-TIMEZONE:${tzid}`);
  if (kalender.verversen) {
    regels.push(
      `REFRESH-INTERVAL;VALUE=DURATION:${kalender.verversen}`,
      `X-PUBLISHED-TTL:${kalender.verversen}`,
    );
  }
  regels.push(...definitie);

  for (const event of kalender.events) {
    try {
      regels.push(...bouwEvent(event, stempel, tzid));
    } catch (fout) {
      if (fout instanceof IcsOngeldig && opties.opOngeldig !== "gooi") continue;
      throw fout;
    }
  }
  regels.push("END:VCALENDAR");
  return regels.map(vouwIcsRegel).join(CRLF) + CRLF;
}
