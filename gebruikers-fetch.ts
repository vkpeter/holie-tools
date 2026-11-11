/**
 * `AdminClient` (zie `./gebruikers`) op gewone `fetch`, zonder supabase-js en zonder andere
 * dependencies. Bedoeld voor Cloudflare Workers, waar supabase-js te zwaar is (grootte, CPU-tijd);
 * werkt ook in Deno en Node 18+. De client gooit nooit: netwerkfout, time-out en een antwoord
 * zonder JSON worden `error: { message, status }` (status 0 zonder HTTP-antwoord).
 *
 * ```ts
 * import { maakFetchAdminClient } from "@holie/tools/gebruikers-fetch";
 * import { zetActief } from "@holie/tools/gebruikers";
 * const admin = maakFetchAdminClient({ url: env.SUPABASE_URL, serviceKey: env.SERVICE_ROLE_KEY });
 * await zetActief(admin, id, false);
 * ```
 *
 * @module
 */

import type { AdminClient } from "./gebruikers.ts";

/** Opties van `maakFetchAdminClient`. */
export interface FetchAdminOpties {
  /** Basis-URL van het Supabase-project; een slash achteraan mag. */
  url: string;
  /** Service-role-sleutel. Enkel op de server gebruiken. */
  serviceKey: string;
  /** Eigen `fetch` (tests, of een service binding). Standaard de globale. */
  fetch?: typeof fetch;
  /** Time-out per verzoek in milliseconden. Standaard 10000. */
  timeoutMs?: number;
}

/** Fout in de vorm van supabase-js; `status` is 0 als er geen HTTP-antwoord kwam. */
interface FetchFout {
  message: string;
  status: number;
}

interface Antwoord {
  /** Geparste JSON (`null` bij een lege body). */
  body: unknown;
  fout: FetchFout | null;
}

function foutTekst(body: unknown, status: number): string {
  const b = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  for (const sleutel of ["msg", "message", "error_description", "error"]) {
    const w = b[sleutel];
    if (typeof w === "string" && w) return w;
  }
  return `HTTP ${status}`;
}

/**
 * Maakt een `AdminClient` die rechtstreeks GoTrue (`/auth/v1/admin`) en PostgREST (`/rest/v1/rpc`)
 * aanroept met de service-role-sleutel.
 */
export function maakFetchAdminClient(opties: FetchAdminOpties): AdminClient {
  const basis = opties.url.replace(/\/+$/, "");
  const timeoutMs = opties.timeoutMs ?? 10_000;

  async function vraag(
    pad: string,
    methode: string,
    body?: unknown,
  ): Promise<Antwoord> {
    const headers: Record<string, string> = {
      apikey: opties.serviceKey,
      authorization: `Bearer ${opties.serviceKey}`,
    };
    const init: RequestInit = { method: methode, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    try {
      init.signal = AbortSignal.timeout(timeoutMs);
      const doeFetch = opties.fetch ?? fetch;
      const res = await doeFetch(`${basis}${pad}`, init);
      const tekst = await res.text();
      let json: unknown = null;
      let parseerde = true;
      if (tekst) {
        try {
          json = JSON.parse(tekst);
        } catch {
          parseerde = false;
        }
      }
      if (res.status >= 200 && res.status < 300) {
        return parseerde ? { body: json, fout: null } : {
          body: null,
          fout: { message: "Antwoord is geen JSON", status: res.status },
        };
      }
      return {
        body: null,
        fout: {
          message: foutTekst(parseerde ? json : null, res.status),
          status: res.status,
        },
      };
    } catch (e) {
      const naam = e instanceof Error ? e.name : "";
      const message = naam === "TimeoutError" || naam === "AbortError"
        ? `Time-out na ${timeoutMs} ms`
        : e instanceof Error && e.message
        ? e.message
        : "Netwerkfout";
      return { body: null, fout: { message, status: 0 } };
    }
  }

  const gebruikerPad = (id: string) =>
    `/auth/v1/admin/users/${encodeURIComponent(id)}`;

  // deno-lint-ignore no-explicit-any
  const metUser = (r: Antwoord): any =>
    r.fout
      ? { data: { user: null }, error: r.fout }
      : { data: { user: r.body }, error: null };

  return {
    auth: {
      admin: {
        generateLink: async (params: {
          type: string;
          email: string;
          password?: string;
          newEmail?: string;
          options?: { data?: unknown; redirectTo?: string };
        }) => {
          const query = params.options?.redirectTo
            ? `?redirect_to=${encodeURIComponent(params.options.redirectTo)}`
            : "";
          const r = await vraag(
            `/auth/v1/admin/generate_link${query}`,
            "POST",
            {
              type: params.type,
              email: params.email,
              password: params.password,
              new_email: params.newEmail,
              data: params.options?.data,
            },
          );
          if (r.fout) {
            return { data: { properties: null, user: null }, error: r.fout };
          }
          const {
            action_link,
            email_otp,
            hashed_token,
            redirect_to,
            verification_type,
            ...user
          } = (r.body && typeof r.body === "object" ? r.body : {}) as Record<
            string,
            unknown
          >;
          return {
            data: {
              properties: {
                action_link,
                email_otp,
                hashed_token,
                redirect_to,
                verification_type,
              },
              user,
            },
            error: null,
          };
        },
        getUserById: async (id: string) =>
          metUser(await vraag(gebruikerPad(id), "GET")),
        updateUserById: async (id: string, attrs: Record<string, unknown>) =>
          metUser(await vraag(gebruikerPad(id), "PUT", attrs)),
        deleteUser: async (id: string) =>
          metUser(await vraag(gebruikerPad(id), "DELETE")),
      },
    },
    rpc: async (naam: string, args: Record<string, unknown> = {}) => {
      const r = await vraag(
        `/rest/v1/rpc/${encodeURIComponent(naam)}`,
        "POST",
        args,
      );
      return r.fout
        ? { data: null, error: r.fout }
        : { data: r.body, error: null };
    },
  };
}
