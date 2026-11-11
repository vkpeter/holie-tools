/**
 * holie-ai-beleid: serveert het ondertekende AI-beleid op https://beleid.holie.be.
 *
 *   GET  /ai-beleid.json[?project=foodie&v=0.23.0]  het huidige envelop (ondertekend)
 *   PUT  /ai-beleid.json                             nieuw envelop; enkel aanvaard als de
 *                                                    handtekening klopt en het volgnummer
 *                                                    hoger is dan het huidige
 *   GET  /lezers                                     (met leessleutel) per project: pakketversie, volgnummer
 *                                                    en wanneer het laatst gelezen werd
 *   GET  /historie/<volgnummer>                      (met leessleutel) een ouder envelop
 *   POST /verbruik                                   dagregels van @holie/tools (>= 0.26.0),
 *                                                    opgeteld in D1; zonder geheim, begrensd
 *                                                    Per regel mag een `storingen`-array mee
 *                                                    (>= 0.33.0): [{ provider, soort: "tegoed" | "fout",
 *                                                    status, aantal }], opgeteld in D1-tabel `storing`
 *                                                    Ook optioneel per regel (>= 0.34.0): cache_lees, cache_schrijf_5m,
 *                                                    cache_schrijf_1u (tokens), batch_aanroepen, batch_gewist,
 *                                                    batch_wis_mislukt; opgeteld in D1-tabel `verbruik_extra`
 *   GET  /verbruik?van=&tot=                         de dagteller, enkel met
 *                                                    `Authorization: Bearer <VERBRUIK_LEESSLEUTEL>`
 *   GET  /verbruik-extra?van=&tot=                   (met dezelfde leessleutel) de extra tellers per dag
 *   GET  /storing?dag=YYYY-MM-DD                     (met dezelfde leessleutel) de storingen van een dag
 *                                                    (standaard vandaag Brussel): { storingen: [...] }
 *
 * Er staat GEEN geheim in deze Worker: de handtekening is de schrijfsleutel. Wie de
 * privésleutel niet heeft, kan niets publiceren; een oud ondertekend bestand opnieuw
 * insturen faalt op het volgnummer.
 *
 * Bindings: KV `BELEID`, var `PUBLIEKE_SLEUTEL` (Ed25519, raw, base64), D1 `VERBRUIK`
 * (schema in `verbruik.sql`), rate limit `VERBRUIK_LIMIET`, secret `VERBRUIK_LEESSLEUTEL`.
 */

const JSON_KOP = { "content-type": "application/json; charset=utf-8" };

function antwoord(body, status = 200, extra = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...JSON_KOP, "access-control-allow-origin": "*", ...extra },
  });
}

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function controleer(envelop, publiek) {
  if (
    !envelop || envelop.schema !== 1 || typeof envelop.inhoud !== "string" ||
    typeof envelop.handtekening !== "string"
  ) return "envelop onvolledig";
  const sleutel = await crypto.subtle.importKey(
    "raw",
    b64(publiek),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    sleutel,
    b64(envelop.handtekening),
    new TextEncoder().encode(envelop.inhoud),
  );
  if (!ok) return "handtekening klopt niet";
  let beleid;
  try {
    beleid = JSON.parse(envelop.inhoud);
  } catch {
    return "inhoud is geen JSON";
  }
  if (beleid?.schema !== 1 || typeof beleid.volgnummer !== "number") {
    return "inhoud is geen beleid";
  }
  return { beleid };
}

/** Schrijft hoogstens elke 10 min per project+versie een leesregel (KV-schrijflimiet). */
async function noteerLezer(env, project, versie, volgnummer) {
  const cache = caches.default;
  const sleutel = new Request(
    `https://beleid.holie.be/__lezer/${encodeURIComponent(project)}/${
      encodeURIComponent(versie)
    }`,
  );
  if (await cache.match(sleutel)) return;
  await env.BELEID.put(
    `lezer:${project}`,
    JSON.stringify({
      project,
      versie,
      volgnummer,
      laatst: new Date().toISOString(),
    }),
  );
  await cache.put(
    sleutel,
    new Response("1", { headers: { "cache-control": "max-age=600" } }),
  );
}

// ---------------------------------------------------------------------------
// Verbruik (fase D, 1 nov 2026): @holie/tools 0.26.0 meldt per proces een bundel dagregels.
// Geen geheim nodig om te schrijven: projecten hebben geen sleutel. Vervalsen kan dus, maar
// geeft hoogstens een vals alarm, nooit een lek. Daarom begrensd: grootte, plausibele waarden,
// rate limit per IP en een plafond per project en dag. Lezen vraagt VERBRUIK_LEESSLEUTEL (VPS).
// ---------------------------------------------------------------------------

export const VERBRUIK_MAX_BYTES = 16 * 1024;
export const VERBRUIK_MAX_REGELS = 50;
/** Plafond per regel en per (dag, project, provider, type): daarboven telt niets meer bij. */
export const VERBRUIK_MAX_USD_REGEL = 50;
export const VERBRUIK_MAX_USD_DAG = 500;
export const VERBRUIK_MAX_AANROEPEN_REGEL = 10000;
/** Extra tellers (0.34.0): tokens en batches per regel. */
export const EXTRA_VELDEN = [
  "cache_lees",
  "cache_schrijf_5m",
  "cache_schrijf_1u",
  "batch_aanroepen",
  "batch_gewist",
  "batch_wis_mislukt",
];
const EXTRA_MAX = 1e12;
const TYPES = new Set([
  "tekst",
  "tools",
  "beeld-in",
  "audio-in",
  "beeld-uit",
  "tts",
  "embeddings",
  "live-spraak",
]);

/** `YYYY-MM-DD` in Europe/Brussels, `dagen` verschoven. */
export function brusselseDag(dagen = 0, nu = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Brussels",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nu + dagen * 86400000));
}

const geheelTussen = (x, min, max) =>
  Number.isInteger(x) && x >= min && x <= max;

/** Toetst één regel; geeft de foutreden of null. */
export function regelFout(r, nu = Date.now()) {
  if (!r || typeof r !== "object") return "regel is geen object";
  if (typeof r.dag !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.dag)) {
    return "dag";
  }
  if (r.dag < brusselseDag(-2, nu) || r.dag > brusselseDag(1, nu)) {
    return "dag buiten venster";
  }
  if (typeof r.project !== "string" || !/^[a-z0-9-]{1,40}$/.test(r.project)) {
    return "project";
  }
  if (
    typeof r.provider !== "string" || !/^[a-z0-9-]{1,30}$/.test(r.provider)
  ) return "provider";
  if (!TYPES.has(r.type)) return "type";
  if (!geheelTussen(r.aanroepen, 1, VERBRUIK_MAX_AANROEPEN_REGEL)) {
    return "aanroepen";
  }
  if (
    typeof r.usd !== "number" || !Number.isFinite(r.usd) || r.usd < 0 ||
    r.usd > VERBRUIK_MAX_USD_REGEL
  ) return "usd";
  for (const veld of ["terugval", "zonder_label", "fouten"]) {
    if (!geheelTussen(r[veld] ?? 0, 0, r.aanroepen)) return veld;
  }
  for (const veld of EXTRA_VELDEN) {
    if (r[veld] !== undefined && !geheelTussen(r[veld], 0, EXTRA_MAX)) {
      return veld;
    }
  }
  for (const veld of ["batch_aanroepen", "batch_gewist", "batch_wis_mislukt"]) {
    if ((r[veld] ?? 0) > r.aanroepen) return veld;
  }
  if (r.storingen !== undefined) {
    if (!Array.isArray(r.storingen) || r.storingen.length > 10) {
      return "storingen";
    }
    for (const st of r.storingen) {
      if (!st || typeof st !== "object") return "storing";
      if (
        typeof st.provider !== "string" ||
        !/^[a-z0-9-]{1,30}$/.test(st.provider)
      ) return "storing.provider";
      if (st.soort !== "tegoed" && st.soort !== "fout") return "storing.soort";
      if (!geheelTussen(st.aantal, 1, 100000)) return "storing.aantal";
      if (!geheelTussen(st.status ?? 0, 0, 999)) return "storing.status";
    }
  }
  return null;
}

const UPSERT = `INSERT INTO verbruik
  (dag, project, provider, type, aanroepen, usd, terugval, zonder_label, fouten, bijgewerkt)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  ON CONFLICT (dag, project, provider, type) DO UPDATE SET
    aanroepen = aanroepen + excluded.aanroepen,
    usd = usd + excluded.usd,
    terugval = terugval + excluded.terugval,
    zonder_label = zonder_label + excluded.zonder_label,
    fouten = fouten + excluded.fouten,
    bijgewerkt = excluded.bijgewerkt
  WHERE verbruik.usd + excluded.usd <= ${VERBRUIK_MAX_USD_DAG}
    AND verbruik.aanroepen + excluded.aanroepen <= 1000000`;

const UPSERT_EXTRA = `INSERT INTO verbruik_extra
  (dag, project, provider, type, cache_lees, cache_schrijf_5m, cache_schrijf_1u,
   batch_aanroepen, batch_gewist, batch_wis_mislukt, bijgewerkt)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  ON CONFLICT (dag, project, provider, type) DO UPDATE SET
    cache_lees = cache_lees + excluded.cache_lees,
    cache_schrijf_5m = cache_schrijf_5m + excluded.cache_schrijf_5m,
    cache_schrijf_1u = cache_schrijf_1u + excluded.cache_schrijf_1u,
    batch_aanroepen = batch_aanroepen + excluded.batch_aanroepen,
    batch_gewist = batch_gewist + excluded.batch_gewist,
    batch_wis_mislukt = batch_wis_mislukt + excluded.batch_wis_mislukt,
    bijgewerkt = excluded.bijgewerkt`;

const UPSERT_STORING = `INSERT INTO storing
  (dag, provider, soort, project, aantal, status, eerste, laatste)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
  ON CONFLICT (dag, provider, soort, project) DO UPDATE SET
    aantal = aantal + excluded.aantal,
    status = excluded.status,
    laatste = excluded.laatste
  WHERE storing.aantal + excluded.aantal <= 1000000`;

export async function ontvangVerbruik(request, env) {
  if (!env.VERBRUIK) return antwoord({ fout: "geen opslag" }, 503);
  const lengte = Number(request.headers.get("content-length") || 0);
  if (lengte > VERBRUIK_MAX_BYTES) return antwoord({ fout: "te groot" }, 413);
  if (env.VERBRUIK_LIMIET) {
    const ip = request.headers.get("cf-connecting-ip") || "onbekend";
    const { success } = await env.VERBRUIK_LIMIET.limit({ key: ip });
    if (!success) return antwoord({ fout: "te veel verzoeken" }, 429);
  }
  const tekst = await request.text();
  if (tekst.length > VERBRUIK_MAX_BYTES) {
    return antwoord({ fout: "te groot" }, 413);
  }
  let body;
  try {
    body = JSON.parse(tekst);
  } catch {
    return antwoord({ fout: "geen JSON" }, 400);
  }
  const regels = body?.regels;
  if (
    !Array.isArray(regels) || regels.length === 0 ||
    regels.length > VERBRUIK_MAX_REGELS
  ) return antwoord({ fout: "regels" }, 400);
  const nu = Date.now();
  for (const r of regels) {
    const fout = regelFout(r, nu);
    if (fout) return antwoord({ fout: `ongeldige regel: ${fout}` }, 400);
  }
  const tijd = new Date(nu).toISOString();
  const stmt = env.VERBRUIK.prepare(UPSERT);
  const stmtStoring = env.VERBRUIK.prepare(UPSERT_STORING);
  // Enkel regels met iets extra raken de tabel `verbruik_extra`: zonder cache of batch (en
  // dus ook voor oudere clients) verandert er niets, ook niet als de tabel nog niet bestaat.
  const stmtExtra = env.VERBRUIK.prepare(UPSERT_EXTRA);
  const extra = regels.filter((r) => EXTRA_VELDEN.some((v) => (r[v] ?? 0) > 0))
    .map((r) =>
      stmtExtra.bind(
        r.dag,
        r.project,
        r.provider,
        r.type,
        r.cache_lees ?? 0,
        r.cache_schrijf_5m ?? 0,
        r.cache_schrijf_1u ?? 0,
        r.batch_aanroepen ?? 0,
        r.batch_gewist ?? 0,
        r.batch_wis_mislukt ?? 0,
        tijd,
      )
    );
  const storingen = regels.flatMap((r) =>
    (r.storingen ?? []).map((st) =>
      stmtStoring.bind(
        r.dag,
        st.provider,
        st.soort,
        r.project,
        st.aantal,
        st.status ?? 0,
        tijd,
      )
    )
  );
  await env.VERBRUIK.batch([
    ...regels.map((r) =>
      stmt.bind(
        r.dag,
        r.project,
        r.provider,
        r.type,
        r.aanroepen,
        r.usd,
        r.terugval ?? 0,
        r.zonder_label ?? 0,
        r.fouten ?? 0,
        tijd,
      )
    ),
    ...storingen,
    ...extra,
  ]);
  return antwoord({ ok: true, regels: regels.length });
}

/** GET /verbruik-extra?van=&tot=: cache-tokens en batchtellers per dag, met dezelfde leessleutel. */
export async function leesVerbruikExtra(request, env) {
  if (!env.VERBRUIK) return antwoord({ fout: "geen opslag" }, 503);
  const geweigerd = await leesWeigering(request, env);
  if (geweigerd) return geweigerd;
  const url = new URL(request.url);
  const van = url.searchParams.get("van") || brusselseDag(-35);
  const tot = url.searchParams.get("tot") || brusselseDag(1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(van) || !/^\d{4}-\d{2}-\d{2}$/.test(tot)) {
    return antwoord({ fout: "van/tot als YYYY-MM-DD" }, 400);
  }
  const { results } = await env.VERBRUIK.prepare(
    `SELECT dag, project, provider, type, cache_lees, cache_schrijf_5m, cache_schrijf_1u,
            batch_aanroepen, batch_gewist, batch_wis_mislukt, bijgewerkt
       FROM verbruik_extra WHERE dag >= ?1 AND dag <= ?2
       ORDER BY dag, project, provider, type LIMIT 5000`,
  ).bind(van, tot).all();
  return antwoord({ van, tot, regels: results ?? [] }, 200, {
    "cache-control": "no-store",
  });
}

/** Tijdsonafhankelijke vergelijking van twee teksten. */
async function gelijk(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let v = 0;
  for (let i = 0; i < x.length; i++) v |= x[i] ^ y[i];
  return v === 0;
}

/** 401 tenzij `Authorization: Bearer <VERBRUIK_LEESSLEUTEL>`; null als het mag. */
export async function leesWeigering(request, env) {
  const sleutel = env.VERBRUIK_LEESSLEUTEL;
  const kop = request.headers.get("authorization") || "";
  if (
    !sleutel || !kop.startsWith("Bearer ") ||
    !(await gelijk(kop.slice(7), sleutel))
  ) return antwoord({ fout: "niet toegelaten" }, 401);
  return null;
}

export async function leesVerbruik(request, env) {
  if (!env.VERBRUIK) return antwoord({ fout: "geen opslag" }, 503);
  const geweigerd = await leesWeigering(request, env);
  if (geweigerd) return geweigerd;
  const url = new URL(request.url);
  const van = url.searchParams.get("van") || brusselseDag(-35);
  const tot = url.searchParams.get("tot") || brusselseDag(1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(van) || !/^\d{4}-\d{2}-\d{2}$/.test(tot)) {
    return antwoord({ fout: "van/tot als YYYY-MM-DD" }, 400);
  }
  const { results } = await env.VERBRUIK.prepare(
    `SELECT dag, project, provider, type, aanroepen, usd, terugval, zonder_label, fouten, bijgewerkt
       FROM verbruik WHERE dag >= ?1 AND dag <= ?2
       ORDER BY dag, project, provider, type LIMIT 5000`,
  ).bind(van, tot).all();
  return antwoord({ van, tot, regels: results ?? [] }, 200, {
    "cache-control": "no-store",
  });
}

/** GET /storing?dag=YYYY-MM-DD: de storingen van een dag, met dezelfde leessleutel als /verbruik. */
export async function leesStoring(request, env) {
  if (!env.VERBRUIK) return antwoord({ fout: "geen opslag" }, 503);
  const geweigerd = await leesWeigering(request, env);
  if (geweigerd) return geweigerd;
  const url = new URL(request.url);
  const dag = url.searchParams.get("dag") || brusselseDag();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dag)) {
    return antwoord({ fout: "dag als YYYY-MM-DD" }, 400);
  }
  const { results } = await env.VERBRUIK.prepare(
    `SELECT dag, provider, soort, project, aantal, status, eerste, laatste
       FROM storing WHERE dag = ?1
       ORDER BY provider, soort, project LIMIT 1000`,
  ).bind(dag).all();
  return antwoord({ dag, storingen: results ?? [] }, 200, {
    "cache-control": "no-store",
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pad = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, PUT, POST",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (pad === "/ai-beleid.json" && request.method === "GET") {
      const huidig = await env.BELEID.get("huidig");
      if (!huidig) return antwoord({ fout: "nog geen beleid" }, 404);
      const project = (url.searchParams.get("project") || "").slice(0, 40);
      const versie = (url.searchParams.get("v") || "?").slice(0, 20);
      if (project && /^[a-z0-9-]+$/.test(project)) {
        let volgnummer = null;
        try {
          volgnummer = JSON.parse(JSON.parse(huidig).inhoud).volgnummer;
        } catch { /* leesregel zonder volgnummer */ }
        ctx.waitUntil(
          noteerLezer(env, project, versie, volgnummer).catch(() => {}),
        );
      }
      return antwoord(huidig, 200, { "cache-control": "no-store" });
    }

    if (pad === "/ai-beleid.json" && request.method === "PUT") {
      let envelop;
      try {
        envelop = await request.json();
      } catch {
        return antwoord({ fout: "geen JSON" }, 400);
      }
      const uitslag = await controleer(envelop, env.PUBLIEKE_SLEUTEL);
      if (typeof uitslag === "string") return antwoord({ fout: uitslag }, 403);
      const oud = await env.BELEID.get("huidig");
      if (oud) {
        const oudNummer = JSON.parse(JSON.parse(oud).inhoud).volgnummer;
        if (uitslag.beleid.volgnummer <= oudNummer) {
          return antwoord({
            fout:
              `volgnummer ${uitslag.beleid.volgnummer} is niet hoger dan ${oudNummer}`,
          }, 409);
        }
      }
      const tekst = JSON.stringify(envelop);
      await env.BELEID.put(`historie:${uitslag.beleid.volgnummer}`, tekst);
      await env.BELEID.put("huidig", tekst);
      return antwoord({
        ok: true,
        volgnummer: uitslag.beleid.volgnummer,
        uitgegeven: uitslag.beleid.uitgegeven,
      });
    }

    if (pad === "/lezers" && request.method === "GET") {
      const geweigerd = await leesWeigering(request, env);
      if (geweigerd) return geweigerd;
      const lijst = await env.BELEID.list({ prefix: "lezer:" });
      const lezers = [];
      for (const k of lijst.keys) {
        const w = await env.BELEID.get(k.name);
        if (w) lezers.push(JSON.parse(w));
      }
      return antwoord({ lezers }, 200, { "cache-control": "no-store" });
    }

    const historie = pad.match(/^\/historie\/(\d+)$/);
    if (historie && request.method === "GET") {
      const geweigerd = await leesWeigering(request, env);
      if (geweigerd) return geweigerd;
      const w = await env.BELEID.get(`historie:${historie[1]}`);
      return w ? antwoord(w) : antwoord({ fout: "onbekend volgnummer" }, 404);
    }

    if (pad === "/verbruik" && request.method === "POST") {
      return await ontvangVerbruik(request, env);
    }
    if (pad === "/verbruik" && request.method === "GET") {
      return await leesVerbruik(request, env);
    }
    if (pad === "/verbruik-extra" && request.method === "GET") {
      return await leesVerbruikExtra(request, env);
    }
    if (pad === "/storing" && request.method === "GET") {
      return await leesStoring(request, env);
    }

    return antwoord({ fout: "niet gevonden" }, 404);
  },
};
