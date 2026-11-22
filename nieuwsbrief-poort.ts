/**
 * Mechanische poort vóór het versturen van een nieuwsbrief, en de beslissing
 * "overslaan, droog draaien of echt versturen".
 *
 * Hoort bij `./nieuwsbrief` (uitschrijfkoppen, verzendregister, batches). Dit
 * bestand bevat enkel pure functies: geen netwerk, geen omgeving, geen logs.
 *
 * - `keurNieuwsbrief`: de toets. Onderwerp en koppen zonder labelwoord of emoji,
 *   een onderwerp dat met een getal begint, elk getal letterlijk uit de bron,
 *   een uitschrijflink in de mail én in `List-Unsubscribe`, HTML onder de grens,
 *   geen sjabloonrest (`${`, `undefined`, `NaN`), geen politiek geladen termen.
 * - `besluitUitgave`: faalt de poort of ontbreekt de inhoud, dan wordt de week
 *   overgeslagen (een goede uitkomst, geen fout). Onder de drempel aan bevestigde
 *   inschrijvers draait de job droog: bouwen en loggen, niet versturen.
 * - `brusselsMoment`: weekdag, uur en datum in Europe/Brussels, zodat een job
 *   die in UTC getikt wordt zijn eigen zomer- en wintertijd kan bewaken.
 *
 * ⚠️ De poort toetst wat de aanroeper aanlevert. Wie de getallen niet uit de
 * bron haalt maar uit een taalmodel, laat de poort niets controleren: lever
 * `toegelatenGetallen` aan uit de rekenroutine, nooit uit de tekst zelf.
 */

/** Eerste woorden die een kop of onderwerp tot een label maken. */
export const LABELWOORDEN: readonly string[] = [
  "ontdek",
  "geniet",
  "even",
  "lekker",
  "nieuw",
  "nieuwe",
  "nieuws",
  "nieuwsbrief",
  "newsletter",
  "weekmail",
];

/** Standaard bovengrens voor de HTML, in bytes (Gmail knipt rond 102 kB). */
export const MAX_HTML_BYTES = 100_000;

/** Standaard drempel aan bevestigde inschrijvers voor een echte verzending. */
export const STANDAARD_DREMPEL = 25;

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}️⃣]/u;

/** Bevat de tekst een emoji, vlag of toetscombinatie? */
export function heeftEmoji(tekst: string): boolean {
  return EMOJI.test(tekst);
}

function zonderAccenten(tekst: string): string {
  return tekst.normalize("NFKD").replace(/\p{M}/gu, "");
}

/** Eerste woord in kleine letters, zonder accenten; leeg als er geen is. */
export function eersteWoord(tekst: string): string {
  const m = zonderAccenten(tekst).match(/[^\W\d_]+/u);
  return m ? m[0].toLowerCase() : "";
}

// ───────────── Getallen ─────────────

const GETAL = /(?<![\w.,])\d+(?:[.,]\d+)*(?![\w])/g;

function normaliseerGetal(token: string): string[] {
  const uit = new Set<string>();
  const dot = (s: string) => {
    const n = Number(s);
    return Number.isFinite(n) ? String(n) : s;
  };
  // Alleen cijfers: 60
  if (/^\d+$/.test(token)) return [String(Number(token))];
  // Duizendtallen: 1.200 of 1,200 of 1.200,5
  if (/^\d{1,3}([.,]\d{3})+([.,]\d+)?$/.test(token)) {
    const zonder = token.replace(/[.,](?=\d{3}(\D|$))/g, "");
    uit.add(dot(zonder.replace(",", ".")));
  }
  // Decimaal: 5,5 of 5.5
  uit.add(dot(token.replace(",", ".")));
  return [...uit];
}

/** Alle getallen in een tekst, als de tekst die er staat ("5,5", "60"). */
export function getallenUit(tekst: string): string[] {
  return [...tekst.matchAll(GETAL)].map((m) => m[0]);
}

/** Zet toegelaten getallen om naar een verzameling vergelijkbare waarden. */
function toegelatenSet(getallen: readonly (string | number)[]): Set<string> {
  const set = new Set<string>();
  for (const g of getallen) {
    for (const n of normaliseerGetal(String(g))) set.add(n);
  }
  return set;
}

// ───────────── Politiek geladen termen ─────────────

const POLITIEK_WOORDEN = [
  "israel\\w*",
  "israeli\\w*",
  "zionis\\w*",
  "palestin\\w*",
  "palestijn\\w*",
  "gaza\\w*",
  "west\\s*bank",
  "westelijke\\s+jordaanoever",
  "cisjordan\\w*",
  "hamas",
  "hezbollah",
  "hizbollah",
  "hizbullah",
  "houthi\\w*",
  "oekrain\\w*",
  "ukrain\\w*",
  "ucrania",
  "kyiv",
  "kiev",
  "zelensk\\w*",
  "kharkiv",
  "charkiv",
  "mariupol",
  "bakhmut",
  "rusland",
  "russia\\w*",
  "russisch\\w*",
  "russen",
  "kremlin",
  "putin",
  "poetin",
  "moskou",
  "moscow",
  "moscou",
  "taiwan\\w*",
  "taipei",
  "falkland\\w*",
  "malvinas",
  "krim",
  "crimea\\w*",
  "donbas\\w*",
  "donbass",
  "donetsk",
  "loehansk",
  "luhansk",
  "tibet\\w*",
  "kashmir\\w*",
  "kasjmir\\w*",
  "western\\s+sahara",
  "westelijke\\s+sahara",
  "sahara\\s+occidental\\w*",
  "polisario",
  "sahrawi\\w*",
  "nagorno\\W?karab\\w*",
  "nagorno",
  "artsach",
  "noord\\W?cyprus",
  "northern\\s+cyprus",
  "chypre\\s+du\\s+nord",
  "intifada",
];

const POLITIEK = new RegExp(
  "(?<![a-z0-9])(?:" + POLITIEK_WOORDEN.join("|") + ")(?![a-z0-9])",
  "i",
);

/** De gevonden politiek geladen term, of `null`. Zelfde lijst als de persona-socials. */
export function politiekGevoelig(tekst: string): string | null {
  if (!tekst) return null;
  const m = zonderAccenten(tekst).match(POLITIEK);
  return m ? m[0] : null;
}

// ───────────── De poort ─────────────

export interface NieuwsbriefPoortInvoer {
  onderwerp: string;
  /** Alle koppen in de mail (h1 tot h3, kaartkoppen). */
  koppen: readonly string[];
  /**
   * De lopende tekst die uit de bron komt (zonder voet, zonder datum), waarin elk
   * getal letterlijk uit `toegelatenGetallen` moet komen.
   */
  inhoudTekst: readonly string[];
  /** De getallen uit de bron of de rekensom, als getal of als tekst ("5,5"). */
  toegelatenGetallen: readonly (string | number)[];
  html: string;
  headers: Readonly<Record<string, string>>;
  /** De persoonlijke uitschrijflink: moet in de HTML staan. */
  uitschrijfUrl: string;
  /**
   * De url in `List-Unsubscribe` als die verschilt van de zichtbare link (een
   * one-click-eindpunt dat een POST aanneemt). Standaard gelijk aan `uitschrijfUrl`.
   */
  headerUrl?: string;
  /** Standaard `true`: het onderwerp begint met een getal. */
  onderwerpBegintMetGetal?: boolean;
  /** Standaard `MAX_HTML_BYTES`. */
  maxHtmlBytes?: number;
  /** Standaard 70 tekens; langer wordt in de inbox afgeknipt. */
  maxOnderwerpTekens?: number;
}

export interface PoortUitkomst {
  ok: boolean;
  fouten: string[];
}

const SJABLOONRESTEN = [
  "${",
  "{{",
  "undefined",
  "[object ",
  "NaN",
];

function heeftHeader(
  headers: Readonly<Record<string, string>>,
  naam: string,
): string | undefined {
  const sleutel = Object.keys(headers).find((k) =>
    k.toLowerCase() === naam.toLowerCase()
  );
  return sleutel ? headers[sleutel] : undefined;
}

/**
 * Toetst één mail voor hij de deur uit gaat. `ok` is alleen `true` als `fouten`
 * leeg is. Elke fout is een zin die in een log of melding kan staan.
 */
export function keurNieuwsbrief(invoer: NieuwsbriefPoortInvoer): PoortUitkomst {
  const fouten: string[] = [];
  const onderwerp = invoer.onderwerp.trim();

  // Onderwerp
  if (!onderwerp) fouten.push("onderwerp is leeg");
  if (heeftEmoji(onderwerp)) fouten.push("onderwerp bevat een emoji");
  if (LABELWOORDEN.includes(eersteWoord(onderwerp))) {
    fouten.push(
      `onderwerp opent met het labelwoord '${eersteWoord(onderwerp)}'`,
    );
  }
  if (invoer.onderwerpBegintMetGetal !== false && !/^\s*\d/.test(onderwerp)) {
    fouten.push("onderwerp begint niet met een getal");
  }
  const maxOnderwerp = invoer.maxOnderwerpTekens ?? 70;
  if ([...onderwerp].length > maxOnderwerp) {
    fouten.push(`onderwerp is langer dan ${maxOnderwerp} tekens`);
  }

  // Lopende tekst: ook daar geen emoji (een titel uit de bron kan er een bevatten)
  for (const tekst of invoer.inhoudTekst) {
    if (heeftEmoji(tekst)) {
      fouten.push(`tekst bevat een emoji: '${tekst.slice(0, 60)}'`);
    }
  }

  // Koppen
  for (const kop of invoer.koppen) {
    if (heeftEmoji(kop)) fouten.push(`kop bevat een emoji: '${kop}'`);
    if (LABELWOORDEN.includes(eersteWoord(kop))) {
      fouten.push(
        `kop opent met het labelwoord '${eersteWoord(kop)}': '${kop}'`,
      );
    }
  }

  // Getallen letterlijk uit de bron
  const toegelaten = toegelatenSet(invoer.toegelatenGetallen);
  const teToetsen = [onderwerp, ...invoer.koppen, ...invoer.inhoudTekst];
  const reedsGemeld = new Set<string>();
  for (const tekst of teToetsen) {
    for (const token of getallenUit(tekst)) {
      const waarden = normaliseerGetal(token);
      if (!waarden.some((w) => toegelaten.has(w)) && !reedsGemeld.has(token)) {
        reedsGemeld.add(token);
        fouten.push(`getal ${token} staat niet in de rekensom of de bron`);
      }
    }
  }

  // Uitschrijven
  const url = invoer.uitschrijfUrl;
  if (!url) {
    fouten.push("uitschrijflink ontbreekt");
  } else {
    const inHtml = invoer.html.includes(url) ||
      invoer.html.includes(url.replaceAll("&", "&amp;"));
    if (!inHtml) fouten.push("uitschrijflink staat niet in de mail");
    const lu = heeftHeader(invoer.headers, "List-Unsubscribe");
    if (!lu) fouten.push("List-Unsubscribe-header ontbreekt");
    else if (!lu.includes(`<${invoer.headerUrl ?? url}>`)) {
      fouten.push("List-Unsubscribe wijst niet naar de uitschrijflink");
    }
    const post = heeftHeader(invoer.headers, "List-Unsubscribe-Post");
    if (post !== "List-Unsubscribe=One-Click") {
      fouten.push("List-Unsubscribe-Post (one-click) ontbreekt");
    }
  }

  // Grootte en sjabloonresten
  const bytes = new TextEncoder().encode(invoer.html).length;
  const max = invoer.maxHtmlBytes ?? MAX_HTML_BYTES;
  if (bytes > max) fouten.push(`HTML is ${bytes} bytes, grens ${max}`);
  for (const rest of SJABLOONRESTEN) {
    if (invoer.html.includes(rest) || onderwerp.includes(rest)) {
      fouten.push(`sjabloonrest in de uitvoer: '${rest}'`);
    }
  }

  // Politiek
  for (const tekst of teToetsen) {
    const term = politiekGevoelig(tekst);
    if (term) fouten.push(`politiek geladen term: '${term}'`);
  }

  return { ok: fouten.length === 0, fouten };
}

// ───────────── Overslaan, droog of verzenden ─────────────

export type Besluit =
  | { actie: "overslaan"; reden: string }
  | { actie: "droog"; reden: string }
  | { actie: "verzenden"; reden: string };

export interface BesluitInvoer {
  /** Is er deze week een rekensom (of andere bron) om mee te beginnen? */
  heeftInhoud: boolean;
  /** Uitkomst van `keurNieuwsbrief`; `null` als er niets te keuren viel. */
  poort: PoortUitkomst | null;
  /** Aantal bevestigde inschrijvers. */
  bevestigd: number;
  /** Standaard `STANDAARD_DREMPEL`. */
  drempel?: number;
}

/**
 * Overslaan is een goede uitkomst: een zwakke of foute week gaat niet de deur uit
 * en wordt ook niet aangevuld. Onder de drempel wordt de mail gebouwd en gelogd,
 * maar nooit verstuurd.
 */
export function besluitUitgave(invoer: BesluitInvoer): Besluit {
  if (!invoer.heeftInhoud) {
    return { actie: "overslaan", reden: "geen rekensom deze week" };
  }
  if (!invoer.poort) {
    return { actie: "overslaan", reden: "niets om te keuren" };
  }
  if (!invoer.poort.ok) {
    return {
      actie: "overslaan",
      reden: `poort geweigerd: ${invoer.poort.fouten.join("; ")}`,
    };
  }
  const drempel = invoer.drempel ?? STANDAARD_DREMPEL;
  if (!Number.isInteger(drempel) || drempel < 1) {
    return { actie: "droog", reden: "ongeldige drempel, dus niet versturen" };
  }
  if (invoer.bevestigd < drempel) {
    return {
      actie: "droog",
      reden: `${invoer.bevestigd} bevestigde inschrijvers, drempel ${drempel}`,
    };
  }
  return {
    actie: "verzenden",
    reden: `${invoer.bevestigd} bevestigde inschrijvers, drempel ${drempel}`,
  };
}

// ───────────── Brusselse tijd ─────────────

export interface BrusselsMoment {
  /** 1 = maandag ... 7 = zondag. */
  weekdag: number;
  uur: number;
  /** JJJJ-MM-DD in Brussel. */
  datum: string;
}

const WEEKDAGEN: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Weekdag, uur en datum in Europe/Brussels voor een tijdstip. */
export function brusselsMoment(nu: Date = new Date()): BrusselsMoment {
  const delen = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Brussels",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(nu);
  const g = (t: string) => delen.find((d) => d.type === t)?.value ?? "";
  return {
    weekdag: WEEKDAGEN[g("weekday")] ?? 0,
    uur: Number(g("hour")),
    datum: `${g("year")}-${g("month")}-${g("day")}`,
  };
}

/** ISO-weeknummer (JJJJ-Www) van een datum JJJJ-MM-DD, voor een uitgavesleutel. */
export function isoWeek(datum: string): string {
  const [j, m, d] = datum.split("-").map(Number);
  const t = new Date(Date.UTC(j, m - 1, d));
  const dag = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dag);
  const jaarStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - jaarStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
