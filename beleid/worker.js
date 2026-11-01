/**
 * holie-ai-beleid: serveert het ondertekende AI-beleid op https://beleid.holie.be.
 *
 *   GET  /ai-beleid.json[?project=foodie&v=0.23.0]  het huidige envelop (ondertekend)
 *   PUT  /ai-beleid.json                             nieuw envelop; enkel aanvaard als de
 *                                                    handtekening klopt en het volgnummer
 *                                                    hoger is dan het huidige
 *   GET  /lezers                                     per project: pakketversie, volgnummer
 *                                                    en wanneer het laatst gelezen werd
 *   GET  /historie/<volgnummer>                      een ouder envelop
 *
 * Er staat GEEN geheim in deze Worker: de handtekening is de schrijfsleutel. Wie de
 * privésleutel niet heeft, kan niets publiceren; een oud ondertekend bestand opnieuw
 * insturen faalt op het volgnummer.
 *
 * Bindings: KV `BELEID`, var `PUBLIEKE_SLEUTEL` (Ed25519, raw, base64).
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pad = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, PUT",
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
      const w = await env.BELEID.get(`historie:${historie[1]}`);
      return w ? antwoord(w) : antwoord({ fout: "onbekend volgnummer" }, 404);
    }

    if (pad === "/") {
      return antwoord({
        dienst: "holie-ai-beleid",
        paden: ["/ai-beleid.json", "/lezers", "/historie/<volgnummer>"],
      });
    }
    return antwoord({ fout: "niet gevonden" }, 404);
  },
};
