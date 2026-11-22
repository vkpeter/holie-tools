/**
 * Instagram-carrousel via de Graph API (Meta, "Content Publishing"), los van de aanroeper zodat het
 * met een nep-fetch te testen is.
 *
 * Flow:
 *  1. per beeld een container: POST /{ig-user}/media met `image_url` en `is_carousel_item=true`
 *  2. wachten tot elk kind status_code FINISHED heeft (GET /{id}?fields=status_code)
 *  3. carrouselcontainer: POST /{ig-user}/media met `media_type=CAROUSEL`, `children` (komma-lijst) en `caption`
 *  4. wachten tot de carrousel FINISHED is
 *  5. POST /{ig-user}/media_publish met `creation_id`
 *
 * Het token gaat altijd in een `Authorization: Bearer`-header, nooit in de URL of de body: zo belandt het niet
 * in een log, een proxy of een foutmelding.
 *
 * Meta-limieten (documentatie): 2 tot 10 beelden per carrousel, JPEG enkel, een carrousel telt als 1 post
 * binnen de limiet van 100 gepubliceerde posts per 24 uur, en `caption` hoort op de carrouselcontainer
 * (een caption op een kind wordt genegeerd).
 */

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface CarrouselOpties {
  fetchFn: FetchFn;
  igUserId: string;
  accessToken: string;
  caption: string;
  imageUrls: string[];
  /** Graph-versie, bv. "v18.0". */
  versie: string;
  /** Injecteerbaar zodat tests niet echt wachten. */
  wacht?: (ms: number) => Promise<void>;
  /** Hoe vaak de status bevraagd wordt per container. */
  maxPogingen?: number;
  pauzeMs?: number;
}

// `fase` zegt hoe ver we kwamen: bij "voorbereiding" is er niets gepubliceerd en is terugval veilig.
export type CarrouselUitslag =
  | { ok: true; id: string }
  | { ok: false; fase: "voorbereiding"; reden: string }
  | { ok: false; fase: "publicatie"; reden: string; instagram?: unknown };

/** Geeft de URL's terug als het een bruikbare carrousel is (2 tot 10 https-URL's), anders null. */
export function geldigeCarrouselUrls(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const urls = input.filter((u): u is string => {
    if (typeof u !== "string") return false;
    try {
      return new URL(u).protocol === "https:";
    } catch {
      return false;
    }
  });
  // Een deels ongeldige lijst is verdacht: liever de enkele-beeldflow dan een carrousel met gaten.
  if (urls.length !== input.length) return null;
  return urls.length >= 2 && urls.length <= 10 ? urls : null;
}

const form = (token: string, o: Record<string, string>) => ({
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: `Bearer ${token}`,
  },
  body: new URLSearchParams(o),
});

// deno-lint-ignore no-explicit-any
async function leesJson(r: Response): Promise<any> {
  return await r.json().catch(() => ({}));
}

// deno-lint-ignore no-explicit-any
function foutTekst(d: any, r: Response, standaard: string): string | null {
  if (!r.ok || d?.error) return d?.error?.message || standaard;
  return null;
}

export async function postCarrousel(
  o: CarrouselOpties,
): Promise<CarrouselUitslag> {
  const basis = `https://graph.facebook.com/${o.versie}`;
  const wacht = o.wacht ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPogingen = o.maxPogingen ?? 10;
  const pauzeMs = o.pauzeMs ?? 2000;

  // Wacht tot een container FINISHED is. ERROR/EXPIRED is meteen een fout; we blijven niet eindeloos hangen.
  const naarFinished = async (id: string): Promise<string | null> => {
    for (let i = 0; i < maxPogingen; i++) {
      const r = await o.fetchFn(`${basis}/${id}?fields=status_code`, {
        headers: { Authorization: `Bearer ${o.accessToken}` },
      });
      const d = await leesJson(r);
      const fout = foutTekst(d, r, "statuscontrole mislukt");
      if (fout) return fout;
      if (d.status_code === "FINISHED") return null;
      if (d.status_code === "ERROR" || d.status_code === "EXPIRED") {
        return `container ${id} kreeg status ${d.status_code}`;
      }
      await wacht(pauzeMs);
    }
    return `container ${id} niet FINISHED na ${maxPogingen} pogingen`;
  };

  try {
    // 1. Kinderen, achter elkaar zodat de volgorde vastligt.
    const kinderen: string[] = [];
    for (const url of o.imageUrls) {
      const r = await o.fetchFn(
        `${basis}/${o.igUserId}/media`,
        form(o.accessToken, { image_url: url, is_carousel_item: "true" }),
      );
      const d = await leesJson(r);
      const fout = foutTekst(d, r, "kind-container mislukt");
      if (fout || !d.id) {
        return {
          ok: false,
          fase: "voorbereiding",
          reden: `kind ${url}: ${fout ?? "geen id"}`,
        };
      }
      kinderen.push(String(d.id));
    }

    // 2. Kinderen klaar.
    for (const id of kinderen) {
      const fout = await naarFinished(id);
      if (fout) return { ok: false, fase: "voorbereiding", reden: fout };
    }

    // 3. Carrouselcontainer.
    const cr = await o.fetchFn(
      `${basis}/${o.igUserId}/media`,
      form(o.accessToken, {
        media_type: "CAROUSEL",
        children: kinderen.join(","),
        caption: o.caption,
      }),
    );
    const cd = await leesJson(cr);
    const cfout = foutTekst(cd, cr, "carrouselcontainer mislukt");
    if (cfout || !cd.id) {
      return {
        ok: false,
        fase: "voorbereiding",
        reden: `carrousel: ${cfout ?? "geen id"}`,
      };
    }

    // 4. Carrousel klaar.
    const sfout = await naarFinished(String(cd.id));
    if (sfout) return { ok: false, fase: "voorbereiding", reden: sfout };

    // 5. Publiceren. Faalt dit, dan is de uitkomst onzeker: geen terugval (kans op een dubbele post).
    const pr = await o.fetchFn(
      `${basis}/${o.igUserId}/media_publish`,
      form(o.accessToken, { creation_id: String(cd.id) }),
    );
    const pd = await leesJson(pr);
    const pfout = foutTekst(pd, pr, "Instagram API fout bij publiceren");
    if (pfout || !pd.id) {
      return {
        ok: false,
        fase: "publicatie",
        reden: pfout ?? "geen id",
        instagram: pd?.error,
      };
    }
    return { ok: true, id: String(pd.id) };
  } catch (e) {
    // Netwerkfout voor de publicatie: er is niets gepubliceerd.
    return {
      ok: false,
      fase: "voorbereiding",
      reden: e instanceof Error ? e.message : "onbekende fout",
    };
  }
}
