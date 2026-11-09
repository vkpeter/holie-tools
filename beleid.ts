/**
 * ai-beleid: welke AI-provider een aanroep mag en in welke volgorde.
 *
 * Eén beleidsbestand voor alle Holie-projecten (ontwerp "centraal AI-beleid in Tickbook",
 * panelreview 1 nov 2026). Het beleid zegt per provider wat hij kan (types), welke soorten
 * gegevens hij mag verwerken (toelatingen, met status onderbouwd / testfase / uitgesloten),
 * binnen welke verwerkerscontext, wat een project verbiedt of enkel toelaat, en wie tijdelijk
 * voorrang krijgt.
 *
 * De keuze volgt ÉÉN rangorde (panel #12):
 *
 *     uitsluiting > projectverbod > witte lijst > voorrang > basis
 *
 * Een uitsluiting wint dus altijd, ook van `vast: true` en van een volgorde die de aanroeper
 * zelf meegeeft. Blijft er geen provider over, dan faalt de aanroep met een `AiBeleidFout` die
 * zegt WELKE stap de lijst leegmaakte, in plaats van stil naar een uitgesloten provider te gaan.
 *
 * @module
 */

/** Soorten aansturing. Niet elke provider kan elk type (zie `ProviderInfo.capaciteiten`). */
export const AI_TYPES = [
  "tekst",
  "tools",
  "beeld-in",
  "audio-in",
  "beeld-uit",
  "tts",
  "embeddings",
  "live-spraak",
] as const;
export type AiType = typeof AI_TYPES[number];

/** Soorten gegevens, van minst naar meest gevoelig. */
export const GEGEVENS = [
  "publiek",
  "prive-peter",
  "persoon",
  "gezondheid",
] as const;
export type Gegevens = typeof GEGEVENS[number];

export type ToelatingStatus = "onderbouwd" | "testfase" | "uitgesloten";

/** Wie, wanneer en waarom: elke regel in het beleid draagt dit. */
export interface Beslissing {
  reden: string;
  wie: string;
  /** ISO-datum van de beslissing. */
  datum: string;
  /** Wanneer of bij welke gebeurtenis herzien, bv. "commerciële lancering". */
  herzien?: string;
  /** Waar het op steunt: notitie, ticket, voorwaarden + datum van nameting. */
  bron?: string;
}

export interface Dataprofiel {
  /** Waar de verwerking gebeurt: EU, VS, China, ... */
  regio?: string;
  /** Verwerkersovereenkomst: ja, nee of onbekend. */
  dpa?: "ja" | "nee" | "onbekend";
  /** Standaardcontractbepalingen voor doorgifte buiten de EER. */
  scc?: "ja" | "nee" | "onbekend" | "nvt";
  /** Traint de provider op onze gegevens? */
  training?: "ja" | "nee" | "onbekend";
  bewaartermijn?: string;
  /** Bron + datum van nameting. */
  bron?: string;
}

export interface ProviderInfo {
  naam: string;
  capaciteiten: AiType[];
  /** Overal uitgezet (account geblokt, storing). `null` of afwezig = aan. */
  uit?: Beslissing | null;
  dataprofiel?: Dataprofiel;
  /** Beperkingen van onze tier, bv. "gratis: beeld-uit quotum nul". */
  tier?: string;
  /** Kan `@holie/tools` deze provider vandaag aanroepen? Zo niet, waarschuwt het scherm. */
  aanroepbaar?: boolean;
}

/**
 * Provider x soort gegevens (optioneel x project) = status. Een regel met `project` gaat voor
 * een algemene. Na `geldig_tot` slaat de status vanzelf om naar `uitgesloten` (panel #4).
 */
export interface Toelating extends Beslissing {
  provider: string;
  gegevens: Gegevens;
  status: ToelatingStatus;
  project?: string;
  /** Rechtsgrond, bv. "toestemming (art. 9.2.a)". */
  grondslag?: string;
  /** ISO-datum of -tijdstip; daarna geldt `uitgesloten`. */
  geldig_tot?: string | null;
  /** Enkel toegelaten als de aanroep `toestemming` met deze provider meegeeft. */
  toestemming_vereist?: boolean;
}

/**
 * Een verwerkerscontext is een afspraak met een klant (bv. de verwerkersovereenkomst van
 * Roundbook): enkel providers die aan die klant gemeld zijn, mogen. Panel #3.
 */
export interface Verwerkerscontext {
  omschrijving: string;
  providers: { provider: string; gemeld_aan_klant: string; bron?: string }[];
}

/** Tijdelijk vooraan, voor bepaalde types, tot een datum. */
export interface Voorrang extends Beslissing {
  provider: string;
  /** Zonder types: elk type dat de provider kan. */
  types?: AiType[];
  van?: string;
  tot?: string;
  /** Enkel voor dit project; zonder project globaal. */
  project?: string;
}

export interface ProjectVerbod extends Beslissing {
  provider: string;
  /** Zonder types: elk type. */
  types?: AiType[];
}

export interface WitteLijst extends Beslissing {
  providers: string[];
  /**
   * `zacht` ("zo ver als mogelijk"): kan geen enkele provider van de lijst het type, dan de
   * gewone kandidaten. `strikt`: dan faalt de aanroep.
   */
  modus: "zacht" | "strikt";
  /** Zonder types: elk type. */
  types?: AiType[];
}

export interface ProjectRegels {
  omschrijving?: string;
  /** Standaard soort gegevens voor dit project; een aanroep kan het overschrijven. */
  gegevens?: Gegevens;
  /** Standaard verwerkerscontext; een aanroep kan het overschrijven. */
  context?: string;
  verboden?: ProjectVerbod[];
  wittelijst?: WitteLijst | null;
}

export interface AiBeleid {
  schema: 1;
  /** Stijgt bij elke wijziging. Een ouder bestand wordt nooit verkozen boven een nieuwer. */
  volgnummer: number;
  /** ISO-tijdstip van uitgifte. */
  uitgegeven: string;
  providers: Record<string, ProviderInfo>;
  /** Prijsbewuste volgorde per type, als er niets bijzonders loopt. */
  basis: Partial<Record<AiType, string[]>>;
  voorrang: Voorrang[];
  toelatingen: Toelating[];
  contexten: Record<string, Verwerkerscontext>;
  projecten: Record<string, ProjectRegels>;
  /** Als een project geen standaard heeft en de aanroep niets zegt. */
  standaard_gegevens?: Gegevens;
}

/** De stappen van de keuze, in de volgorde waarin ze de lijst filteren. */
export type KeuzeStap =
  | "capaciteit"
  | "uit"
  | "uitsluiting"
  | "verwerkerscontext"
  | "projectverbod"
  | "witte lijst"
  | "sleutel"
  | "tegoed op";

export interface StapVerslag {
  stap: KeuzeStap;
  /** Wat er na deze stap overbleef. */
  over: string[];
  /** Wat deze stap wegnam, en waarom. */
  weg: { provider: string; reden: string }[];
}

export interface KeuzeVraag {
  type: AiType;
  project?: string;
  gegevens?: Gegevens;
  context?: string;
  /** Buiten voorrang, maar NIET buiten de uitsluitingen. */
  vast?: boolean;
  /** Volgorde van de aanroeper: de kandidaten en hun basisvolgorde. Anders `basis[type]`. */
  volgorde?: readonly string[];
  /** Providers waarvoor de gebruiker toestemming gaf (zie `toestemming_vereist`). */
  toestemming?: readonly string[];
  /** Providers die de aanroepende functie technisch kan aanspreken. */
  pakket?: readonly string[];
  heeftSleutel?: (provider: string) => boolean;
  /** Provider staat in de negatieve cache (tegoed op). */
  tegoedOp?: (provider: string) => boolean;
  nu?: Date;
}

export interface KeuzeUitslag {
  volgorde: string[];
  type: AiType;
  gegevens: Gegevens;
  gegevensBron: "aanroep" | "project" | "standaard";
  context?: string;
  /** Welke providers door voorrang naar voren kwamen. */
  voorrang: string[];
  stappen: StapVerslag[];
  waarschuwingen: string[];
}

/**
 * Geen provider over na het beleid. Erft van `AiOnbeschikbaar`-achtige fouten via `status`
 * 0, maar staat los zodat dit bestand geen afhankelijkheid heeft; `ai.ts` gooit een eigen
 * subklasse van `AiOnbeschikbaar` met dezelfde gegevens.
 */
export class BeleidLeeg extends Error {
  readonly stap: KeuzeStap;
  readonly stappen: StapVerslag[];
  constructor(stap: KeuzeStap, stappen: StapVerslag[], vraag: string) {
    const laatste = stappen[stappen.length - 1];
    const redenen = laatste?.weg.map((w) => `${w.provider}: ${w.reden}`)
      .join("; ");
    super(
      `AI-beleid laat geen provider over voor ${vraag}: stap "${stap}" maakte de lijst leeg` +
        (redenen ? ` (${redenen})` : ""),
    );
    this.name = "BeleidLeeg";
    this.stap = stap;
    this.stappen = stappen;
  }
}

function tijd(waarde: string | undefined | null, eindeVanDag: boolean): number {
  if (!waarde) return NaN;
  // Een kale datum geldt de hele dag (Brussel ligt op UTC+1/+2; een dag speling is
  // bewust ruim in plaats van te vroeg om te slaan).
  if (/^\d{4}-\d{2}-\d{2}$/.test(waarde)) {
    return Date.parse(`${waarde}T${eindeVanDag ? "23:59:59" : "00:00:00"}Z`);
  }
  return Date.parse(waarde);
}

/** Is een voorrang op dit moment actief? */
export function voorrangActief(v: Voorrang, nu: Date = new Date()): boolean {
  const t = nu.getTime();
  const van = tijd(v.van, false);
  const tot = tijd(v.tot, true);
  if (!Number.isNaN(van) && t < van) return false;
  if (!Number.isNaN(tot) && t > tot) return false;
  return true;
}

/**
 * De geldende toelating voor provider x gegevens in een project. Een projectregel gaat voor
 * een algemene. Geen regel = uitgesloten (wat niet beslist is, mag niet).
 */
export function geldendeToelating(
  beleid: AiBeleid,
  provider: string,
  gegevens: Gegevens,
  project: string | undefined,
  nu: Date = new Date(),
): { status: ToelatingStatus; regel?: Toelating; verlopen: boolean } {
  const passend = beleid.toelatingen.filter((t) =>
    t.provider === provider && t.gegevens === gegevens &&
    (!t.project || t.project === project)
  );
  const regel = passend.find((t) => t.project && t.project === project) ??
    passend.find((t) => !t.project);
  if (!regel) return { status: "uitgesloten", verlopen: false };
  const tot = tijd(regel.geldig_tot, true);
  if (!Number.isNaN(tot) && nu.getTime() > tot) {
    return { status: "uitgesloten", regel, verlopen: true };
  }
  return { status: regel.status, regel, verlopen: false };
}

function geldtVoorType(types: readonly AiType[] | undefined, type: AiType) {
  return !types || types.length === 0 || types.includes(type);
}

/**
 * Kiest de providers voor één aanroep, volgens de rangorde in de modulekop. Gooit
 * `BeleidLeeg` als er niets overblijft.
 */
export function kiesProviders(
  beleid: AiBeleid,
  vraag: KeuzeVraag,
): KeuzeUitslag {
  const nu = vraag.nu ?? new Date();
  const project = vraag.project;
  const regels = project ? beleid.projecten[project] : undefined;
  const waarschuwingen: string[] = [];
  if (project && !regels) {
    waarschuwingen.push(`project "${project}" staat niet in het beleid`);
  }

  let gegevens: Gegevens;
  let gegevensBron: KeuzeUitslag["gegevensBron"];
  if (vraag.gegevens) {
    gegevens = vraag.gegevens;
    gegevensBron = "aanroep";
  } else if (regels?.gegevens) {
    gegevens = regels.gegevens;
    gegevensBron = "project";
  } else {
    gegevens = beleid.standaard_gegevens ?? "persoon";
    gegevensBron = "standaard";
    waarschuwingen.push(
      `geen gegevens-label: "${gegevens}" aangenomen (veilige standaard)`,
    );
  }
  const context = vraag.context ?? regels?.context;

  const stappen: StapVerslag[] = [];
  const omschrijving = `${vraag.type}/${gegevens}${
    project ? ` in ${project}` : ""
  }${context ? ` (context ${context})` : ""}`;

  let lijst = [
    ...new Set(
      vraag.volgorde ?? beleid.basis[vraag.type] ??
        Object.keys(beleid.providers).filter((p) =>
          beleid.providers[p].capaciteiten.includes(vraag.type)
        ),
    ),
  ];

  const filter = (
    stap: KeuzeStap,
    weg: (p: string) => string | undefined,
  ) => {
    const verslag: StapVerslag = { stap, over: [], weg: [] };
    for (const p of lijst) {
      const reden = weg(p);
      if (reden) verslag.weg.push({ provider: p, reden });
      else verslag.over.push(p);
    }
    stappen.push(verslag);
    lijst = verslag.over;
    if (lijst.length === 0) throw new BeleidLeeg(stap, stappen, omschrijving);
  };

  // 1. Wat kan het type, en wat kan de aanroepende functie aanspreken.
  filter("capaciteit", (p) => {
    const info = beleid.providers[p];
    if (!info) return "onbekend in het beleid";
    if (!info.capaciteiten.includes(vraag.type)) {
      return `kan geen ${vraag.type}`;
    }
    if (vraag.pakket && !vraag.pakket.includes(p)) {
      return `niet aanroepbaar via deze functie van @holie/tools`;
    }
    return undefined;
  });

  // 2. Overal uitgezet.
  filter("uit", (p) => {
    const uit = beleid.providers[p]?.uit;
    return uit ? `uitgezet (${uit.reden}, ${uit.wie} ${uit.datum})` : undefined;
  });

  // 3. Toelating per soort gegevens (uitsluiting wint van alles).
  filter("uitsluiting", (p) => {
    const t = geldendeToelating(beleid, p, gegevens, project, nu);
    if (t.status === "uitgesloten") {
      if (t.verlopen) {
        return `toelating voor ${gegevens} verlopen op ${t.regel?.geldig_tot}`;
      }
      return t.regel
        ? `uitgesloten voor ${gegevens} (${t.regel.reden})`
        : `geen toelating voor ${gegevens}`;
    }
    if (t.regel?.toestemming_vereist && !vraag.toestemming?.includes(p)) {
      return `voor ${gegevens} enkel met toestemming van de gebruiker`;
    }
    return undefined;
  });

  // 4. Verwerkerscontext: enkel providers die aan de klant gemeld zijn.
  if (context) {
    const ctx = beleid.contexten[context];
    filter("verwerkerscontext", (p) => {
      if (!ctx) {
        return `verwerkerscontext "${context}" bestaat niet in het beleid`;
      }
      return ctx.providers.some((c) => c.provider === p)
        ? undefined
        : `niet gemeld in verwerkerscontext ${context}`;
    });
  }

  // 5. Projectverbod.
  const verboden = (regels?.verboden ?? []).filter((v) =>
    geldtVoorType(v.types, vraag.type)
  );
  if (verboden.length) {
    filter("projectverbod", (p) => {
      const v = verboden.find((x) => x.provider === p);
      return v ? `verboden in ${project} (${v.reden})` : undefined;
    });
  }

  // 6. Witte lijst.
  const wit = regels?.wittelijst;
  if (wit && geldtVoorType(wit.types, vraag.type)) {
    const binnen = lijst.filter((p) => wit.providers.includes(p));
    if (binnen.length === 0 && wit.modus === "zacht") {
      waarschuwingen.push(
        `witte lijst van ${project} (${
          wit.providers.join(", ")
        }) kan geen ${vraag.type}: gewone kandidaten`,
      );
    } else {
      filter(
        "witte lijst",
        (p) =>
          wit.providers.includes(p)
            ? undefined
            : `niet op de witte lijst van ${project} (${wit.modus})`,
      );
    }
  }

  // 7. Een sleutel in dit project.
  if (vraag.heeftSleutel) {
    filter(
      "sleutel",
      (p) =>
        vraag.heeftSleutel!(p) ? undefined : "geen sleutel in deze omgeving",
    );
  }

  // 8. Tegoed op (negatieve cache na een 400/401/402 over credit of balance).
  if (vraag.tegoedOp) {
    filter(
      "tegoed op",
      (p) =>
        vraag.tegoedOp!(p)
          ? "tegoed op of geblokkeerd (negatieve cache)"
          : undefined,
    );
  }

  // 9. Volgorde: voorrang (project eerst, dan globaal) naar voren, tenzij vast.
  const vooraan: string[] = [];
  if (!vraag.vast) {
    const actief = beleid.voorrang.filter((v) =>
      voorrangActief(v, nu) && geldtVoorType(v.types, vraag.type) &&
      (!v.project || v.project === project)
    );
    const geordend = [
      ...actief.filter((v) => v.project),
      ...actief.filter((v) => !v.project),
    ];
    for (const v of geordend) {
      if (lijst.includes(v.provider) && !vooraan.includes(v.provider)) {
        vooraan.push(v.provider);
      }
    }
  }
  const volgorde = [...vooraan, ...lijst.filter((p) => !vooraan.includes(p))];

  return {
    volgorde,
    type: vraag.type,
    gegevens,
    gegevensBron,
    context,
    voorrang: vooraan,
    stappen,
    waarschuwingen,
  };
}

/** Velden die geen lezer gebruikt en die intern zijn (vaultpaden, notities, dossiers). */
const INTERNE_VELDEN = new Set([
  "bron",
  "omschrijving",
  "gemeld_aan_klant",
  "grondslag",
  "herzien",
  "dataprofiel",
  "tier",
]);

/**
 * Het beleid zoals het publiek op beleid.holie.be komt: zonder interne velden en zonder `wie`,
 * behalve in `providers.<naam>.uit` (de lezers tonen "uitgezet (reden, wie datum)"). `reden`,
 * `datum`, `geldig_tot` en `toestemming_vereist` blijven: de lezers gebruiken ze. De volledige
 * versie blijft in Tickbook; de handtekening gaat over deze publieke vorm.
 */
export function publiekBeleid(beleid: AiBeleid): AiBeleid {
  const loop = (x: unknown, pad: string[]): unknown => {
    if (Array.isArray(x)) return x.map((e) => loop(e, pad));
    if (!x || typeof x !== "object") return x;
    const uit: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) {
      if (INTERNE_VELDEN.has(k)) continue;
      if (
        k === "wie" &&
        !(pad.length === 3 && pad[0] === "providers" && pad[2] === "uit")
      ) continue;
      uit[k] = loop(v, [...pad, k]);
    }
    return uit;
  };
  return loop(beleid, []) as AiBeleid;
}

/**
 * Controleert de vorm van een beleid (bv. een opgehaald bestand). Gooit een `TypeError` met
 * de eerste fout; geeft het beleid terug als het klopt.
 */
export function valideerBeleid(x: unknown): AiBeleid {
  const fout = (m: string): never => {
    throw new TypeError(`ongeldig AI-beleid: ${m}`);
  };
  if (!x || typeof x !== "object") fout("geen object");
  const b = x as Record<string, unknown>;
  if (b.schema !== 1) fout(`schema ${String(b.schema)} onbekend`);
  if (typeof b.volgnummer !== "number") fout("volgnummer ontbreekt");
  if (typeof b.uitgegeven !== "string") fout("uitgegeven ontbreekt");
  const obj = (k: string) => {
    if (!b[k] || typeof b[k] !== "object" || Array.isArray(b[k])) {
      fout(`${k} is geen object`);
    }
  };
  const arr = (k: string) => {
    if (!Array.isArray(b[k])) fout(`${k} is geen lijst`);
  };
  obj("providers");
  obj("basis");
  obj("contexten");
  obj("projecten");
  arr("voorrang");
  arr("toelatingen");
  for (const [naam, p] of Object.entries(b.providers as object)) {
    const info = p as ProviderInfo;
    if (!Array.isArray(info?.capaciteiten)) {
      fout(`provider ${naam} heeft geen capaciteiten`);
    }
    for (const c of info.capaciteiten) {
      if (!(AI_TYPES as readonly string[]).includes(c)) {
        fout(`provider ${naam}: onbekend type ${c}`);
      }
    }
  }
  for (const t of b.toelatingen as Toelating[]) {
    if (!(GEGEVENS as readonly string[]).includes(t?.gegevens)) {
      fout(`toelating met onbekende gegevens ${t?.gegevens}`);
    }
    if (!["onderbouwd", "testfase", "uitgesloten"].includes(t.status)) {
      fout(`toelating ${t.provider}/${t.gegevens}: status ${t.status}`);
    }
  }
  for (const [naam, r] of Object.entries(b.projecten as object)) {
    const g = (r as ProjectRegels).gegevens;
    if (g && !(GEGEVENS as readonly string[]).includes(g)) {
      fout(`project ${naam}: onbekende gegevens ${g}`);
    }
    const w = (r as ProjectRegels).wittelijst;
    if (w && !["zacht", "strikt"].includes(w.modus)) {
      fout(`project ${naam}: witte lijst zonder geldige modus`);
    }
  }
  return x as AiBeleid;
}

/**
 * Het strenge noodbeleid in het pakket zelf, voor een project dat zich onder beleid zette
 * maar geen momentopname en geen bereikbaar beleidsadres heeft (koude start). Strenger dan
 * het echte beleid: enkel publieke en eigen gegevens gaan overal heen; persoons- en
 * gezondheidsgegevens enkel naar Claude (geen DeepSeek, geen Lovable, geen gratis Gemini).
 * Spraak en beeld voor persoon/gezondheid falen dus liever dan dat ze bij een niet-onderbouwde
 * provider landen.
 */
export const NOODBELEID: AiBeleid = (() => {
  const b: Beslissing = {
    reden: "noodbeleid in @holie/tools: geen momentopname en geen beleidsadres",
    wie: "pakket",
    datum: "2026-11-01",
  };
  const providers: Record<string, ProviderInfo> = {
    anthropic: {
      naam: "Claude (Anthropic)",
      capaciteiten: ["tekst", "tools", "beeld-in"],
    },
    deepseek: {
      naam: "DeepSeek",
      capaciteiten: ["tekst", "tools", "beeld-in", "live-spraak"],
    },
    gemini: {
      naam: "Gemini (Google, gratis API)",
      capaciteiten: ["tekst", "tools", "beeld-in", "audio-in"],
    },
    lovable: {
      naam: "Lovable AI-gateway",
      capaciteiten: ["tekst", "tools", "beeld-in", "audio-in", "beeld-uit"],
    },
    meta: { naam: "Meta (Muse)", capaciteiten: ["tekst", "beeld-uit"] },
  };
  const toelatingen: Toelating[] = [];
  for (const p of Object.keys(providers)) {
    for (const g of ["publiek", "prive-peter"] as const) {
      toelatingen.push({ ...b, provider: p, gegevens: g, status: "testfase" });
    }
  }
  for (const g of ["persoon", "gezondheid"] as const) {
    toelatingen.push({
      ...b,
      provider: "anthropic",
      gegevens: g,
      status: "testfase",
    });
  }
  return {
    schema: 1,
    volgnummer: 0,
    uitgegeven: "2026-11-01T00:00:00Z",
    providers,
    basis: {
      tekst: ["anthropic", "gemini", "lovable", "deepseek", "meta"],
      tools: ["anthropic", "deepseek", "gemini", "lovable"],
      "beeld-in": ["anthropic", "deepseek", "gemini", "lovable"],
      "audio-in": ["gemini", "lovable"],
      "beeld-uit": ["meta", "lovable"],
    },
    voorrang: [],
    toelatingen,
    contexten: {},
    projecten: {},
    standaard_gegevens: "persoon",
  };
})();

// ---------------------------------------------------------------------------
// Ondertekend beleid (sinds 0.23.0)
// ---------------------------------------------------------------------------

/** Waar het ondertekende beleid staat (Cloudflare Worker `holie-ai-beleid`). */
export const BELEID_URL = "https://beleid.holie.be/ai-beleid.json";

/**
 * De publieke Ed25519-sleutel (raw, base64) waarmee het beleid ondertekend is. De
 * privésleutel staat bij de schrijver (Tickbook, en `HOLIE_AI_BELEID_SLEUTEL` op Peters
 * laptop), nooit in dit pakket of in de Worker.
 */
export const BELEID_PUBLIEKE_SLEUTEL =
  "Z9tJme2ghnbvQNMQzO5IUM6Ivo20uBqTCa9TWAzOW7o=";

/** Het bestand op het beleidsadres: de inhoud als tekst plus de handtekening erover. */
export interface BeleidEnvelop {
  schema: 1;
  /** Het beleid als JSON-tekst; de handtekening gaat over exact deze bytes. */
  inhoud: string;
  /** Ed25519 over UTF-8(inhoud), base64. */
  handtekening: string;
}

const naarBytes = (b64: string) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const naarB64 = (b: ArrayBuffer) => {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s);
};

/** Ondertekent een beleid met een Ed25519-privésleutel (PKCS#8, base64). */
export async function ondertekenBeleid(
  beleid: AiBeleid,
  privesleutelPkcs8: string,
): Promise<BeleidEnvelop> {
  valideerBeleid(beleid);
  const inhoud = JSON.stringify(beleid);
  const sleutel = await crypto.subtle.importKey(
    "pkcs8",
    naarBytes(privesleutelPkcs8),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const handtekening = await crypto.subtle.sign(
    { name: "Ed25519" },
    sleutel,
    new TextEncoder().encode(inhoud),
  );
  return { schema: 1, inhoud, handtekening: naarB64(handtekening) };
}

/**
 * Controleert een envelop en geeft het beleid terug. Gooit een `TypeError` als de
 * handtekening niet klopt of de inhoud geen geldig beleid is.
 */
export async function controleerEnvelop(
  envelop: unknown,
  publiekeSleutel: string = BELEID_PUBLIEKE_SLEUTEL,
): Promise<AiBeleid> {
  const e = envelop as Partial<BeleidEnvelop> | null;
  if (
    !e || e.schema !== 1 || typeof e.inhoud !== "string" ||
    typeof e.handtekening !== "string"
  ) {
    throw new TypeError("ongeldig beleidsenvelop");
  }
  const sleutel = await crypto.subtle.importKey(
    "raw",
    naarBytes(publiekeSleutel),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    sleutel,
    naarBytes(e.handtekening),
    new TextEncoder().encode(e.inhoud),
  );
  if (!ok) throw new TypeError("handtekening van het beleid klopt niet");
  return valideerBeleid(JSON.parse(e.inhoud));
}
