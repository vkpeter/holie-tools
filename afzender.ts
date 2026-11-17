/**
 * Afzender van een contact- of feedbackformulier: wie is ingelogd, wie niet.
 *
 * Waarom een eigen module: op 17 nov 2026 vroeg het contactformulier van Nilou
 * een ingelogde gebruiker om zijn e-mailadres, terwijl dat in de sessie al
 * stond. Elke app met een formulier en een login had hetzelfde probleem.
 *
 * Regel, voor alle apps:
 * - Ingelogd: het adres komt uit de sessie (`user.email`), nooit uit het
 *   formulier. Het veld verschijnt niet; de pagina toont één regel "Je antwoord
 *   komt naar <adres>". De server vertrouwt het adres in de body dan niet.
 * - Niet ingelogd: het formulier blijft zoals het was.
 *
 * Runtime-neutraal, geen supabase-js: `sessieGebruiker` krijgt de client van de
 * aanroeper mee, zoals `controleerCronGeheimViaDb` in `./auth`.
 */

import { bearerToken } from "./auth.ts";
import { normaliseerEmail, schoonRegel } from "./velden.ts";

/** Langste naam die we aanvaarden (zelfde grens als `./gebruikers`). */
export const NAAM_MAX_LENGTE = 100;

function schoneNaam(invoer: unknown): string | null {
  if (typeof invoer !== "string" || invoer.length > NAAM_MAX_LENGTE * 4) {
    return null;
  }
  const naam = schoonRegel(invoer);
  return naam && naam.length <= NAAM_MAX_LENGTE ? naam : null;
}

/** De velden van een Supabase-gebruiker die hier gelezen worden. */
export interface SessieGebruiker {
  email?: string | null;
  is_anonymous?: boolean | null;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

/** Wie het bericht stuurt. `ingelogd` zegt waar het adres vandaan komt. */
export interface Afzender {
  /** Genormaliseerd adres, of `null` als er geen geldig adres is. */
  email: string | null;
  /** Naam voor in de mail, of `null` als er geen is. */
  naam: string | null;
  /** `true`: het adres komt uit de sessie en het veld in de body telde niet. */
  ingelogd: boolean;
}

/** Het minimum van een supabase-js-client dat `sessieGebruiker` nodig heeft. */
export interface AuthLezer {
  auth: {
    getUser(jwt?: string): Promise<{
      data?: { user?: SessieGebruiker | null } | null;
      error?: unknown;
    }>;
  };
}

/**
 * Het naam-veld uit `user_metadata`: eerst `full_name`, dan `name`, dan
 * `display_name` (Google zet de eerste twee, e-mailregistratie soms de derde).
 */
export function naamUitSessie(
  user: SessieGebruiker | null | undefined,
): string | null {
  const meta = user?.user_metadata;
  if (!meta) return null;
  for (const sleutel of ["full_name", "name", "display_name"]) {
    const n = schoneNaam(meta[sleutel]);
    if (n) return n;
  }
  return null;
}

/**
 * Is deze gebruiker een echte, bevestigde account met een geldig adres?
 * Anoniem, zonder adres of nog niet bevestigd telt als niet ingelogd: een
 * onbevestigd adres kan van iemand anders zijn.
 */
export function isIngelogdMetAdres(
  user: SessieGebruiker | null | undefined,
): boolean {
  if (!user || user.is_anonymous) return false;
  if (!normaliseerEmail(user.email)) return false;
  // Ontbreken beide velden (oudere client, test), dan niet afkeuren; staat er
  // een van de twee leeg terwijl de ander ontbreekt, dan wel.
  if (
    user.email_confirmed_at === undefined && user.confirmed_at === undefined
  ) {
    return true;
  }
  return Boolean(user.email_confirmed_at || user.confirmed_at);
}

/**
 * Bepaalt de afzender. Aan de serverkant: `user` komt uit `sessieGebruiker`,
 * `body` is wat de client stuurde. Aan de clientkant, voor de voorinvulling:
 * `afzenderUitSessie(user)` zonder body.
 *
 * Ingelogd: adres uit de sessie; naam uit het formulier, anders uit het profiel.
 * Niet ingelogd: adres en naam uit het formulier.
 */
export function afzenderUitSessie(
  user: SessieGebruiker | null | undefined,
  body: { name?: unknown; naam?: unknown; email?: unknown } = {},
): Afzender {
  const uitFormulier = schoneNaam(body.name) ?? schoneNaam(body.naam);
  if (isIngelogdMetAdres(user)) {
    return {
      email: normaliseerEmail(user!.email),
      naam: uitFormulier ?? naamUitSessie(user),
      ingelogd: true,
    };
  }
  return {
    email: normaliseerEmail(body.email),
    naam: uitFormulier,
    ingelogd: false,
  };
}

/**
 * De gebruiker achter de `Authorization: Bearer <jwt>` van dit verzoek, of
 * `null`. Het token wordt bij GoTrue nagekeken (`auth.getUser(jwt)`): een
 * anon-sleutel, een verlopen of een vervalst token geeft `null`, en de aanroeper
 * valt dan terug op het adres uit het formulier. Valt dus nooit open.
 */
export async function sessieGebruiker(
  req: Request,
  client: AuthLezer,
): Promise<SessieGebruiker | null> {
  const jwt = bearerToken(req);
  // Een JWT heeft drie delen; dat scheelt een rondje bij de sleutel `sb_publishable_...`.
  if (!jwt || jwt.split(".").length !== 3) return null;
  try {
    const { data, error } = await client.auth.getUser(jwt);
    if (error || !data?.user) return null;
    return data.user;
  } catch {
    return null;
  }
}
