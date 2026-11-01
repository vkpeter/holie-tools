/**
 * Eén loginblok voor alle React-apps van Peter (1 nov 2026).
 *
 * Vaste volgorde, in elke app dezelfde: de Google-knop bovenaan, dan de scheiding "of", dan het
 * e-mailformulier. De volgorde zit in het blok zelf en is geen prop.
 *
 * Het blok kent geen router en geen supabase-client: de app geeft `onGoogle` en `onEmail` mee en
 * beslist zelf waar Google naar terugkeert (implicit of PKCE, `next`, Lovable-broker). Het blok
 * draagt ook geen Tailwind-klassen; zijn eigen opmaak zit in een kleine stylesheet met
 * `holie-login`-klassen. Knop, invoerveld en label kunnen de eigen componenten van de app zijn
 * (shadcn), zodat het formulier de huisstijl van de app houdt.
 *
 * ⚠️ Het blok importeert React niet zelf: de app geeft zijn eigen React mee. Zo krijgt een app
 * nooit een tweede React-kopie (een JSR-pakket kan geen bereik "18 of 19" vastleggen), en volgen
 * de types de React-versie van de app.
 *
 * ```tsx
 * // src/components/LoginBlok.tsx in de app
 * import * as React from "react";
 * import { maakLoginBlok } from "@holie/tools/login";
 * export const LoginBlok = maakLoginBlok(React);
 * ```
 *
 * De Google-knop volgt de merkregels van Google: het officiële G-logo in kleur, neutrale knop
 * (wit met grijze rand, of donker in `.dark`) en de tekst "Doorgaan met Google".
 *
 * @module
 */
import type { LoginMelding } from "./google-terug.ts";

export type { LoginMelding } from "./google-terug.ts";

/**
 * Het deel van React dat het blok gebruikt. `import * as React from "react"` past erop, in
 * React 18 en 19.
 */
export interface ReactLike {
  // deno-lint-ignore no-explicit-any
  createElement: (...args: any[]) => any;
  // deno-lint-ignore no-explicit-any
  Fragment: any;
  // deno-lint-ignore no-explicit-any
  useState: (...args: any[]) => any;
  // deno-lint-ignore no-explicit-any
  useEffect: (...args: any[]) => any;
  useId: () => string;
}

/** Iets wat React kan tonen: een element, tekst, `null`. */
export type Inhoud = unknown;

/** Een component van de app (functie of forwardRef), bv. shadcn `Button`. */
// deno-lint-ignore no-explicit-any
export type AppComponent<P> = ((props: P) => any) | { $$typeof: symbol };

/** Alle teksten van het blok. */
export interface LoginTeksten {
  google: string;
  googleBezig: string;
  of: string;
  email: string;
  wachtwoord: string;
  inloggen: string;
  bezig: string;
  vergeten: string;
  /** Als `onEmail` een fout gooit zonder bruikbare tekst. */
  onbekendeFout: string;
}

/** De standaardteksten per taal. De Google-tekst volgt de officiële vertaling van Google. */
export const LOGIN_TEKSTEN: Record<"nl" | "en" | "fr" | "de", LoginTeksten> = {
  nl: {
    google: "Doorgaan met Google",
    googleBezig: "Naar Google…",
    of: "of",
    email: "E-mail",
    wachtwoord: "Wachtwoord",
    inloggen: "Inloggen",
    bezig: "Bezig…",
    vergeten: "Wachtwoord vergeten?",
    onbekendeFout: "Er ging iets mis. Probeer opnieuw.",
  },
  en: {
    google: "Continue with Google",
    googleBezig: "Going to Google…",
    of: "or",
    email: "Email",
    wachtwoord: "Password",
    inloggen: "Log in",
    bezig: "Busy…",
    vergeten: "Forgot password?",
    onbekendeFout: "Something went wrong. Please try again.",
  },
  fr: {
    google: "Continuer avec Google",
    googleBezig: "Vers Google…",
    of: "ou",
    email: "E-mail",
    wachtwoord: "Mot de passe",
    inloggen: "Se connecter",
    bezig: "Un instant…",
    vergeten: "Mot de passe oublié ?",
    onbekendeFout: "Une erreur s'est produite. Réessayez.",
  },
  de: {
    google: "Weiter mit Google",
    googleBezig: "Zu Google…",
    of: "oder",
    email: "E-Mail",
    wachtwoord: "Passwort",
    inloggen: "Anmelden",
    bezig: "Einen Moment…",
    vergeten: "Passwort vergessen?",
    onbekendeFout: "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
  },
};

/** Props die het blok aan een eigen knop van de app geeft. */
export interface LoginKnopProps {
  type: "submit" | "button";
  disabled?: boolean;
  className?: string;
  /** Altijd tekst. */
  children?: string;
}

/** Props die het blok aan een eigen invoerveld van de app geeft. */
export interface LoginInvoerProps {
  id: string;
  name: string;
  type: string;
  autoComplete: string;
  required: boolean;
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  disabled?: boolean;
  className?: string;
  "aria-describedby"?: string;
}

/** Props die het blok aan een eigen label van de app geeft. */
export interface LoginLabelProps {
  htmlFor: string;
  className?: string;
  /** Altijd tekst. */
  children?: string;
}

/** Eigen componenten van de app (bv. shadcn `Button`, `Input`, `Label`). */
export interface LoginOnderdelen {
  Knop?: AppComponent<LoginKnopProps>;
  Invoer?: AppComponent<LoginInvoerProps>;
  Label?: AppComponent<LoginLabelProps>;
}

/** Eigen klassen per onderdeel. Een klasse hier vervangt de standaardopmaak van dat onderdeel. */
export interface LoginKlassen {
  blok?: string;
  google?: string;
  of?: string;
  formulier?: string;
  veld?: string;
  label?: string;
  invoer?: string;
  knop?: string;
  vergeten?: string;
  melding?: string;
}

/** Hoe "wachtwoord vergeten" werkt: een gewone link, een handeling, of een eigen element (router-link). */
export type WachtwoordVergeten =
  | { href: string }
  | { onClick: (email: string) => void }
  | { render: (tekst: string, className: string) => Inhoud };

/** Props van het loginblok. */
export interface LoginBlokProps {
  /** Basistaal van de teksten. Standaard `nl`. */
  taal?: keyof typeof LOGIN_TEKSTEN;
  /** Losse teksten die afwijken van de taal (bv. `inloggen: "Aanmelden"`). */
  teksten?: Partial<LoginTeksten>;
  /**
   * Start de Google-login. Een string als antwoord is een foutmelding; een geweigerde promise
   * ook. Zonder `onGoogle` toont het blok geen Google-knop en geen scheiding.
   */
  onGoogle?: () => unknown;
  /**
   * Meldt aan met e-mail en wachtwoord. Een string als antwoord is een foutmelding (bv. "Ongeldig
   * e-mailadres of wachtwoord"); niets of `null` betekent gelukt en de app navigeert zelf.
   */
  onEmail?: (email: string, wachtwoord: string) => unknown;
  /** Wachtwoord vergeten, onder het wachtwoordveld. */
  wachtwoordVergeten?: WachtwoordVergeten;
  /** Een melding van buiten het blok, typisch na de terugkeer van Google (`googleTerugMelding`). */
  melding?: LoginMelding | null;
  /** Tekst onder het e-mailveld (bv. "Gebruik het adres waarop je uitnodiging aankwam."). */
  emailHint?: Inhoud;
  /** Vervangt het standaardformulier (bv. een registratieformulier); de volgorde blijft. */
  children?: Inhoud;
  /** Onder het formulier (onthoud mij, uitnodigingstekst, link naar registreren). */
  onderFormulier?: Inhoud;
  /** Eigen componenten van de app. */
  onderdelen?: LoginOnderdelen;
  /** Eigen klassen per onderdeel. */
  klassen?: LoginKlassen;
  /** Vaste id's voor de velden (tests die `#email` zoeken). Standaard uniek per blok. */
  ids?: { email?: string; wachtwoord?: string };
  /** Beginwaarde van het e-mailveld. */
  standaardEmail?: string;
}

/** De vier paden van het officiële G-logo van Google, in kleur (viewBox 0 0 48 48). */
export const GOOGLE_G_PADEN: ReadonlyArray<{ fill: string; d: string }> = [
  {
    fill: "#EA4335",
    d: "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z",
  },
  {
    fill: "#4285F4",
    d: "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z",
  },
  {
    fill: "#FBBC05",
    d: "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z",
  },
  {
    fill: "#34A853",
    d: "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z",
  },
];

/** De opmaak van het blok zelf. Geen Tailwind: werkt in Tailwind 3, 4 en zonder. */
export const LOGIN_CSS = `
.holie-login{display:flex;flex-direction:column;gap:1rem;width:100%}
.holie-login-google{display:flex;align-items:center;justify-content:center;gap:.75rem;width:100%;min-height:2.75rem;padding:0 1rem;border:1px solid #747775;border-radius:var(--radius,.5rem);background:#fff;color:#1f1f1f;font:inherit;font-size:.9375rem;font-weight:500;line-height:1.25rem;letter-spacing:normal;text-transform:none;cursor:pointer;transition:background-color .15s,box-shadow .15s}
.holie-login-google:hover:not(:disabled){background:#f2f2f2;box-shadow:0 1px 2px rgba(60,64,67,.3)}
.holie-login-google:focus-visible{outline:2px solid #1a73e8;outline-offset:2px}
.holie-login-google:disabled{opacity:.6;cursor:default}
.dark .holie-login-google,[data-theme="dark"] .holie-login-google{background:#131314;color:#e3e3e3;border-color:#8e918f}
.dark .holie-login-google:hover:not(:disabled),[data-theme="dark"] .holie-login-google:hover:not(:disabled){background:#1f1f20}
.holie-login-g{width:18px;height:18px;flex:none}
.holie-login-of{display:flex;align-items:center;gap:.75rem;font-size:.75rem;line-height:1rem;text-transform:uppercase;letter-spacing:.06em;opacity:.7}
.holie-login-of::before,.holie-login-of::after{content:"";flex:1;height:1px;background:currentColor;opacity:.35}
.holie-login-formulier{display:flex;flex-direction:column;gap:1rem}
.holie-login-veld{display:flex;flex-direction:column;gap:.375rem}
.holie-login-label{font-size:.875rem;font-weight:500}
.holie-login-invoer{width:100%;min-height:2.5rem;padding:.5rem .75rem;border:1px solid #9ca3af;border-radius:var(--radius,.375rem);background:transparent;color:inherit;font:inherit}
.holie-login-knop{width:100%;min-height:2.5rem;padding:.5rem 1rem;border:0;border-radius:var(--radius,.375rem);background:#1f1f1f;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.holie-login-knop:disabled{opacity:.6;cursor:default}
.holie-login-hint{font-size:.8125rem;opacity:.75}
.holie-login-vergeten{align-self:flex-end;padding:0;border:0;background:none;color:inherit;font:inherit;font-size:.8125rem;text-decoration:underline;text-underline-offset:2px;opacity:.8;cursor:pointer}
.holie-login-vergeten:hover{opacity:1}
.holie-login-melding{padding:.625rem .75rem;border:1px solid;border-radius:var(--radius,.375rem);font-size:.875rem;line-height:1.35}
.holie-login-melding[data-soort="fout"]{color:#b3261e;border-color:rgba(179,38,30,.4);background:rgba(179,38,30,.06)}
.holie-login-melding[data-soort="info"]{border-color:currentColor;opacity:.9}
.dark .holie-login-melding[data-soort="fout"],[data-theme="dark"] .holie-login-melding[data-soort="fout"]{color:#f2b8b5;border-color:rgba(242,184,181,.45);background:rgba(242,184,181,.08)}
`;

function foutTekst(antwoord: unknown, reserve: string): string | null {
  if (typeof antwoord === "string") return antwoord || reserve;
  return null;
}

function uitFout(e: unknown, reserve: string): string {
  if (typeof e === "string" && e) return e;
  if (e instanceof Error && e.message) return e.message;
  return reserve;
}

/**
 * Maakt het loginblok met de React van de app: Google bovenaan, dan "of", dan het formulier.
 *
 * ```tsx
 * <LoginBlok
 *   onGoogle={() => supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } })}
 *   onEmail={async (email, wachtwoord) => {
 *     const { error } = await supabase.auth.signInWithPassword({ email, password: wachtwoord });
 *     return error ? "Ongeldig e-mailadres of wachtwoord." : null;
 *   }}
 *   wachtwoordVergeten={{ href: "/wachtwoord" }}
 *   melding={googleTerugMelding(neemGoogleTerug())}
 *   onderdelen={{ Knop: Button, Invoer: Input, Label }}
 * />
 * ```
 */
export function maakLoginBlok<R extends ReactLike>(
  React: R,
): (props: LoginBlokProps) => ReturnType<R["createElement"]> {
  const h = React.createElement;

  function GoogleLogo() {
    return h(
      "svg",
      {
        className: "holie-login-g",
        viewBox: "0 0 48 48",
        width: 18,
        height: 18,
        "aria-hidden": "true",
        focusable: "false",
      },
      ...GOOGLE_G_PADEN.map((p) => h("path", { key: p.fill, ...p })),
    );
  }

  return function LoginBlok(
    props: LoginBlokProps,
  ): ReturnType<R["createElement"]> {
    const {
      taal = "nl",
      onGoogle,
      onEmail,
      wachtwoordVergeten,
      melding,
      emailHint,
      children,
      onderFormulier,
      onderdelen = {},
      klassen = {},
      ids = {},
      standaardEmail = "",
    } = props;
    const t: LoginTeksten = { ...LOGIN_TEKSTEN[taal], ...props.teksten };
    const eigenId = React.useId();
    const emailId = ids.email ?? `${eigenId}-email`;
    const wachtwoordId = ids.wachtwoord ?? `${eigenId}-wachtwoord`;
    const hintId = `${eigenId}-hint`;

    const [email, setEmail] = React.useState(standaardEmail) as [
      string,
      (v: string) => void,
    ];
    const [wachtwoord, setWachtwoord] = React.useState("") as [
      string,
      (v: string) => void,
    ];
    const [bezig, setBezig] = React.useState(false) as [
      boolean,
      (v: boolean) => void,
    ];
    const [googleBezig, setGoogleBezig] = React.useState(false) as [
      boolean,
      (v: boolean) => void,
    ];
    const [fout, setFout] = React.useState(null) as [
      string | null,
      (v: string | null) => void,
    ];

    // Terug met de vorige-knop van de browser na het vertrek naar Google: de pagina komt uit de
    // cache met de knop nog op "bezig". Zet hem dan terug.
    React.useEffect(() => {
      const terug = (e: Event) => {
        if ((e as Event & { persisted?: boolean }).persisted) {
          setGoogleBezig(false);
        }
      };
      const venster = globalThis as unknown as {
        addEventListener?: (t: string, f: (e: Event) => void) => void;
        removeEventListener?: (t: string, f: (e: Event) => void) => void;
      };
      venster.addEventListener?.("pageshow", terug);
      return () => venster.removeEventListener?.("pageshow", terug);
    }, []);

    async function google() {
      if (!onGoogle || googleBezig) return;
      setFout(null);
      setGoogleBezig(true);
      try {
        const tekst = foutTekst(await onGoogle(), t.onbekendeFout);
        if (tekst) {
          setFout(tekst);
          setGoogleBezig(false);
        }
      } catch (e) {
        setFout(uitFout(e, t.onbekendeFout));
        setGoogleBezig(false);
      }
    }

    async function verstuur(e: { preventDefault(): void }) {
      e.preventDefault();
      if (!onEmail || bezig) return;
      setFout(null);
      setBezig(true);
      try {
        const antwoord = await onEmail(email.trim(), wachtwoord);
        const tekst = foutTekst(antwoord, t.onbekendeFout);
        if (tekst) setFout(tekst);
      } catch (err) {
        setFout(uitFout(err, t.onbekendeFout));
      } finally {
        setBezig(false);
      }
    }

    const { Knop, Invoer, Label } = onderdelen;
    const kl = (eigen: string | undefined, standaard: string) =>
      eigen ?? standaard;
    const toonMelding: LoginMelding | null = fout
      ? { soort: "fout", tekst: fout }
      : melding ?? null;
    const uit = bezig || googleBezig;

    const veld = (
      id: string,
      naam: "email" | "password",
      label: string,
      waarde: string,
      zet: (v: string) => void,
      extra?: Inhoud,
    ) => {
      const invoerProps: LoginInvoerProps = {
        id,
        name: naam,
        type: naam,
        autoComplete: naam === "email" ? "email" : "current-password",
        required: true,
        value: waarde,
        onChange: (ev) => zet(ev.target.value),
        disabled: uit,
        ...(naam === "email" && emailHint
          ? { "aria-describedby": hintId }
          : {}),
      };
      return h(
        "div",
        { className: kl(klassen.veld, "holie-login-veld") },
        Label ? h(Label, { htmlFor: id, className: klassen.label }, label) : h(
          "label",
          { htmlFor: id, className: kl(klassen.label, "holie-login-label") },
          label,
        ),
        Invoer
          ? h(Invoer, { ...invoerProps, className: klassen.invoer })
          : h("input", {
            ...invoerProps,
            className: kl(klassen.invoer, "holie-login-invoer"),
          }),
        extra,
      );
    };

    const vergetenKlasse = kl(klassen.vergeten, "holie-login-vergeten");
    let vergeten: Inhoud = null;
    if (wachtwoordVergeten && "href" in wachtwoordVergeten) {
      vergeten = h(
        "a",
        { href: wachtwoordVergeten.href, className: vergetenKlasse },
        t.vergeten,
      );
    } else if (wachtwoordVergeten && "onClick" in wachtwoordVergeten) {
      const klik = wachtwoordVergeten.onClick;
      vergeten = h(
        "button",
        {
          type: "button",
          className: vergetenKlasse,
          onClick: () => klik(email.trim()),
        },
        t.vergeten,
      );
    } else if (wachtwoordVergeten && "render" in wachtwoordVergeten) {
      vergeten = wachtwoordVergeten.render(t.vergeten, vergetenKlasse);
    }

    const knopTekst = bezig ? t.bezig : t.inloggen;
    const formulier = children ?? h(
      "form",
      {
        className: kl(klassen.formulier, "holie-login-formulier"),
        onSubmit: verstuur,
      },
      veld(
        emailId,
        "email",
        t.email,
        email,
        setEmail,
        emailHint
          ? h("p", { id: hintId, className: "holie-login-hint" }, emailHint)
          : null,
      ),
      veld(wachtwoordId, "password", t.wachtwoord, wachtwoord, setWachtwoord),
      vergeten,
      Knop
        ? h(
          Knop,
          { type: "submit", disabled: uit, className: klassen.knop },
          knopTekst,
        )
        : h(
          "button",
          {
            type: "submit",
            disabled: uit,
            className: kl(klassen.knop, "holie-login-knop"),
          },
          knopTekst,
        ),
    );

    return h(
      "div",
      { className: kl(klassen.blok, "holie-login"), "data-holie-login": "" },
      h("style", null, LOGIN_CSS),
      toonMelding
        ? h(
          "div",
          {
            className: kl(klassen.melding, "holie-login-melding"),
            "data-soort": toonMelding.soort,
            role: toonMelding.soort === "fout" ? "alert" : "status",
          },
          toonMelding.tekst,
        )
        : null,
      onGoogle
        ? h(
          React.Fragment,
          null,
          h(
            "button",
            {
              type: "button",
              className: kl(klassen.google, "holie-login-google"),
              onClick: google,
              disabled: uit,
              "aria-busy": googleBezig || undefined,
            },
            h(GoogleLogo, null),
            h("span", null, googleBezig ? t.googleBezig : t.google),
          ),
          h(
            "div",
            {
              className: kl(klassen.of, "holie-login-of"),
              role: "separator",
              "aria-label": t.of,
            },
            h("span", { "aria-hidden": "true" }, t.of),
          ),
        )
        : null,
      formulier,
      onderFormulier,
    );
  };
}
