/// <reference lib="dom" />
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, assertEquals } from "@std/assert";
import * as React from "react";
import { act, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type AdminClient,
  BAN_DUUR,
  type Gebruiker,
  GEBRUIKERS_TEKSTEN,
  maakGebruikersBeheer,
  magDeactiveren,
  magRolWijzigen,
  magVerwijderen,
  nodigUit,
  normaliseerNaam,
  type RolInstelling,
  statusVan,
  telBeheerders,
  vereisBeheerder,
  verwijder,
  wijzigEmail,
  wijzigNaam,
  zetActief,
  zoekAccountOpEmail,
} from "./gebruikers.ts";

const INST: RolInstelling = {
  toewijsbaar: ["admin", "user", "viewer"],
  beheerders: ["admin"],
};

// ───────────── Regels ─────────────

Deno.test("statusVan: ban in de toekomst, nooit aangemeld, actief", () => {
  const nu = new Date("2026-11-09T12:00:00Z");
  assertEquals(
    statusVan({
      banned_until: "2126-01-01T00:00:00Z",
      last_sign_in_at: "2026-01-01",
    }, nu),
    "gedeactiveerd",
  );
  assertEquals(
    statusVan(
      { banned_until: "2020-01-01T00:00:00Z", last_sign_in_at: null },
      nu,
    ),
    "uitgenodigd",
  );
  assertEquals(
    statusVan({ last_sign_in_at: "2026-11-01T00:00:00Z" }, nu),
    "actief",
  );
});

Deno.test("normaliseerNaam: schoon, leeg mag, te lang of geen tekst is null", () => {
  assertEquals(normaliseerNaam("‎ Jan   Peeters\n"), "Jan Peeters");
  assertEquals(normaliseerNaam("   "), "");
  assertEquals(normaliseerNaam("x".repeat(101)), null);
  assertEquals(normaliseerNaam(42), null);
});

Deno.test("magRolWijzigen: zelf, geen rol, onbekend, te veel, laatste beheerder", () => {
  const basis = {
    aanroeperId: "a",
    doel: { id: "b", rollen: ["admin"] },
    aantalBeheerders: 2,
    instelling: INST,
  };
  assertEquals(
    magRolWijzigen({
      ...basis,
      doel: { id: "a", rollen: [] },
      nieuweRollen: ["user"],
    }),
    { ok: false, reden: "zelf" },
  );
  assertEquals(magRolWijzigen({ ...basis, nieuweRollen: [] }), {
    ok: false,
    reden: "geen_rol",
  });
  assertEquals(magRolWijzigen({ ...basis, nieuweRollen: ["key_user"] }), {
    ok: false,
    reden: "onbekende_rol",
  });
  assertEquals(magRolWijzigen({ ...basis, nieuweRollen: ["user", "viewer"] }), {
    ok: false,
    reden: "te_veel_rollen",
  });
  // Dubbel telt niet als twee.
  assertEquals(magRolWijzigen({ ...basis, nieuweRollen: ["user", "user"] }), {
    ok: true,
  });
  assertEquals(
    magRolWijzigen({ ...basis, aantalBeheerders: 1, nieuweRollen: ["user"] }),
    { ok: false, reden: "laatste_beheerder" },
  );
  // Meerdere rollen: admin blijft erbij, dus geen degradatie.
  assertEquals(
    magRolWijzigen({
      ...basis,
      aantalBeheerders: 1,
      instelling: { ...INST, meerdere: true },
      nieuweRollen: ["admin", "user"],
    }),
    { ok: true },
  );
});

Deno.test("magDeactiveren en magVerwijderen", () => {
  const doel = { id: "b", email: "B@x.be", rollen: ["admin"] };
  assertEquals(
    magDeactiveren({
      aanroeperId: "b",
      doel,
      aantalBeheerders: 3,
      beheerders: ["admin"],
    }),
    { ok: false, reden: "zelf" },
  );
  assertEquals(
    magDeactiveren({
      aanroeperId: "a",
      doel,
      aantalBeheerders: 1,
      beheerders: ["admin"],
    }),
    { ok: false, reden: "laatste_beheerder" },
  );
  assertEquals(
    magVerwijderen({ aanroeperId: "a", doel, bevestiging: "c@x.be" }),
    { ok: false, reden: "bevestiging" },
  );
  assertEquals(
    magVerwijderen({ aanroeperId: "a", doel, bevestiging: " b@X.be​" }),
    { ok: true },
  );
  assertEquals(
    magVerwijderen({
      aanroeperId: "a",
      doel,
      bevestiging: "b@x.be",
      aantalBeheerders: 1,
      beheerders: ["admin"],
    }),
    { ok: false, reden: "laatste_beheerder" },
  );
});

Deno.test("telBeheerders: gedeactiveerde beheerders tellen niet", () => {
  assertEquals(
    telBeheerders([
      { rollen: ["admin"], status: "actief" },
      { rollen: ["admin"], status: "gedeactiveerd" },
      { rollen: ["admin"], status: "uitgenodigd" },
      { rollen: ["user"], status: "actief" },
    ], ["admin"]),
    2,
  );
});

// ───────────── Server ─────────────

type Aanroep = { naam: string; args: unknown[] };

function nepAdmin(opties: {
  bestaand?: Record<string, { id: string; last_sign_in_at?: string | null }>;
  linkFout?: boolean;
} = {}) {
  const aanroepen: Aanroep[] = [];
  const bestaand = opties.bestaand ?? {};
  const admin: AdminClient = {
    rpc: (naam: string, args: { p_email: string }) => {
      aanroepen.push({ naam: `rpc:${naam}`, args: [args] });
      return Promise.resolve({
        data: bestaand[args.p_email]?.id ?? null,
        error: null,
      });
    },
    auth: {
      admin: {
        getUserById: (id: string) => {
          aanroepen.push({ naam: "getUserById", args: [id] });
          const acc = Object.values(bestaand).find((a) => a.id === id);
          return Promise.resolve(
            acc
              ? { data: { user: acc }, error: null }
              : { data: { user: null }, error: { message: "User not found" } },
          );
        },
        generateLink: (p: unknown) => {
          aanroepen.push({ naam: "generateLink", args: [p] });
          if (opties.linkFout) {
            return Promise.resolve({ data: null, error: { message: "kapot" } });
          }
          return Promise.resolve({
            data: {
              user: { id: "nieuw-id", user_metadata: {} },
              properties: {
                action_link:
                  "https://api.x/auth/v1/verify?token=abc&type=invite",
              },
            },
            error: null,
          });
        },
        updateUserById: (id: string, attrs: unknown) => {
          aanroepen.push({ naam: "updateUserById", args: [id, attrs] });
          return Promise.resolve({ data: { user: { id } }, error: null });
        },
        deleteUser: (id: string) => {
          aanroepen.push({ naam: "deleteUser", args: [id] });
          return Promise.resolve({ data: {}, error: null });
        },
      },
    },
  };
  return { admin, aanroepen };
}

function nepResend(status = 200) {
  const verzonden: {
    url: string;
    body: Record<string, unknown>;
    headers: Headers;
  }[] = [];
  const origineel = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    verzonden.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: new Headers(init.headers),
    });
    return Promise.resolve(
      new Response(
        JSON.stringify(status === 200 ? { id: "mail-1" } : { message: "nee" }),
        {
          status,
        },
      ),
    );
  }) as typeof fetch;
  return { verzonden, herstel: () => (globalThis.fetch = origineel) };
}

const MAIL = {
  apiKey: "re_test",
  from: "T <t@holie.be>",
  onderwerp: "Welkom",
  html: (link: string, naam: string) => `<a href="${link}">${naam}</a>`,
};
const bevestigLink = (l: string) =>
  `https://app.x/auth/confirm?van=${encodeURIComponent(l)}`;

Deno.test("zoekAccountOpEmail: normaliseert en roept de RPC, zonder listUsers", async () => {
  const { admin, aanroepen } = nepAdmin({
    bestaand: { "a@b.be": { id: "1" } },
  });
  assertEquals(await zoekAccountOpEmail(admin, " A@B.be‎"), {
    ok: true,
    id: "1",
  });
  assertEquals(aanroepen[0], {
    naam: "rpc:account_op_email",
    args: [{ p_email: "a@b.be" }],
  });
  assertEquals(await zoekAccountOpEmail(admin, "geen adres"), {
    ok: false,
    fout: "ongeldig_email",
  });
});

Deno.test("nodigUit: nieuw adres krijgt een invite met naam en een mail via bevestigLink", async () => {
  const { admin, aanroepen } = nepAdmin();
  const resend = nepResend();
  try {
    const r = await nodigUit(admin, {
      email: "Nieuw@X.be",
      naam: " Jan ",
      redirectTo: "https://app.x/",
      bevestigLink,
      mail: MAIL,
      metadata: { bron: "beheer" },
    });
    assertEquals(r, {
      ok: true,
      status: "uitgenodigd",
      id: "nieuw-id",
      email: "nieuw@x.be",
    });
    const link = aanroepen.find((a) => a.naam === "generateLink")!.args[0];
    assertEquals(link, {
      type: "invite",
      email: "nieuw@x.be",
      options: {
        redirectTo: "https://app.x/",
        data: { bron: "beheer", full_name: "Jan" },
      },
    });
    assertEquals(resend.verzonden.length, 1);
    assert(
      String(resend.verzonden[0].body.html).includes(
        "https://app.x/auth/confirm?van=",
      ),
    );
    assert(String(resend.verzonden[0].body.html).includes(">Jan<"));
    assert(
      resend.verzonden[0].headers.get("Idempotency-Key")?.startsWith(
        "uitnodiging/nieuw-id/",
      ),
    );
  } finally {
    resend.herstel();
  }
});

Deno.test("nodigUit: account in gebruik krijgt niets, nog nooit aangemeld krijgt een magiclink", async () => {
  const { admin, aanroepen } = nepAdmin({
    bestaand: {
      "oud@x.be": { id: "o", last_sign_in_at: "2026-10-01" },
      "wacht@x.be": { id: "w", last_sign_in_at: null },
    },
  });
  const resend = nepResend();
  try {
    const opties = { redirectTo: "https://app.x/", bevestigLink, mail: MAIL };
    assertEquals(await nodigUit(admin, { ...opties, email: "oud@x.be" }), {
      ok: true,
      status: "bestaat",
      id: "o",
      email: "oud@x.be",
    });
    assertEquals(aanroepen.filter((a) => a.naam === "generateLink").length, 0);
    assertEquals(resend.verzonden.length, 0);

    const r = await nodigUit(admin, { ...opties, email: "wacht@x.be" });
    assertEquals(r, {
      ok: true,
      status: "opnieuw",
      id: "w",
      email: "wacht@x.be",
    });
    assertEquals(
      (aanroepen.find((a) => a.naam === "generateLink")!.args[0] as {
        type: string;
      }).type,
      "magiclink",
    );
    assertEquals(resend.verzonden.length, 1);
  } finally {
    resend.herstel();
  }
});

Deno.test("nodigUit: droog maakt niets en mailt niets", async () => {
  const { admin, aanroepen } = nepAdmin();
  const resend = nepResend();
  try {
    const r = await nodigUit(admin, {
      email: "n@x.be",
      redirectTo: "https://app.x/",
      bevestigLink,
      mail: MAIL,
      droog: true,
    });
    assertEquals(r, {
      ok: true,
      status: "uitgenodigd",
      id: null,
      email: "n@x.be",
      droog: true,
    });
    assertEquals(aanroepen.map((a) => a.naam), ["rpc:account_op_email"]);
    assertEquals(resend.verzonden.length, 0);
  } finally {
    resend.herstel();
  }
});

Deno.test("nodigUit: fouten van link en mail komen als code terug", async () => {
  const opties = {
    email: "n@x.be",
    redirectTo: "https://app.x/",
    bevestigLink,
    mail: MAIL,
  };
  const kapot = nepAdmin({ linkFout: true });
  assertEquals(await nodigUit(kapot.admin, opties), {
    ok: false,
    fout: "link",
    detail: "kapot",
  });
  const resend = nepResend(422);
  try {
    const r = await nodigUit(nepAdmin().admin, opties);
    assertEquals(r.ok, false);
    assertEquals(!r.ok && r.fout, "mail");
    assertEquals(r.id, "nieuw-id");
  } finally {
    resend.herstel();
  }
  assertEquals(
    await nodigUit(nepAdmin().admin, { ...opties, naam: "x".repeat(200) }),
    {
      ok: false,
      fout: "ongeldige_naam",
    },
  );
});

Deno.test("wijzigEmail: bezet bij een ander account, bevestigd bij een vrij adres", async () => {
  const { admin, aanroepen } = nepAdmin({
    bestaand: { "bezet@x.be": { id: "ander" } },
  });
  assertEquals(await wijzigEmail(admin, "ik", "Bezet@x.be"), {
    ok: false,
    fout: "bezet",
  });
  assertEquals(await wijzigEmail(admin, "ik", "vrij@x.be "), {
    ok: true,
    email: "vrij@x.be",
  });
  assertEquals(aanroepen.at(-1), {
    naam: "updateUserById",
    args: ["ik", { email: "vrij@x.be", email_confirm: true }],
  });
});

Deno.test("wijzigNaam, zetActief en verwijder roepen de admin-API", async () => {
  const { admin, aanroepen } = nepAdmin();
  assertEquals(await wijzigNaam(admin, "i", " Jan P "), {
    ok: true,
    naam: "Jan P",
  });
  assertEquals(await wijzigNaam(admin, "i", "", { sleutel: "naam" }), {
    ok: true,
    naam: "",
  });
  assertEquals(await zetActief(admin, "i", false), { ok: true });
  assertEquals(await zetActief(admin, "i", true), { ok: true });
  assertEquals(await verwijder(admin, "i"), { ok: true });
  assertEquals(aanroepen.map((a) => a.args[1] ?? a.args[0]), [
    { user_metadata: { full_name: "Jan P" } },
    { user_metadata: { naam: null } },
    { ban_duration: BAN_DUUR },
    { ban_duration: "none" },
    "i",
  ]);
});

Deno.test("vereisBeheerder: 401, 403, 500 en het id", async () => {
  const req = (kop?: string) =>
    new Request("https://x/", { headers: kop ? { Authorization: kop } : {} });
  const opties = {
    gebruiker: (t: string) =>
      Promise.resolve(t === "goed" || t === "gast" ? { id: t } : null),
    isBeheerder: (id: string) =>
      id === "fout"
        ? Promise.reject(new Error("db"))
        : Promise.resolve(id === "goed"),
    headers: { "Access-Control-Allow-Origin": "*" },
  };
  const geen = await vereisBeheerder(req(), opties);
  assert(geen instanceof Response && geen.status === 401);
  assertEquals(geen.headers.get("Access-Control-Allow-Origin"), "*");
  const slecht = await vereisBeheerder(req("Bearer slecht"), opties);
  assert(slecht instanceof Response && slecht.status === 401);
  const gast = await vereisBeheerder(req("Bearer gast"), opties);
  assert(gast instanceof Response && gast.status === 403);
  const db = await vereisBeheerder(req("Bearer fout"), {
    ...opties,
    gebruiker: () => Promise.resolve({ id: "fout" }),
  });
  assert(db instanceof Response && db.status === 500);
  assertEquals(await vereisBeheerder(req("Bearer goed"), opties), {
    userId: "goed",
  });
});

Deno.test("sql/gebruikers.sql: account_op_email enkel voor de service-role, vier weigeringen", async () => {
  const sql = await Deno.readTextFile(
    new URL("./sql/gebruikers.sql", import.meta.url),
  );
  assert(sql.includes("0.32.0"));
  assert(
    /grant execute on function public\.account_op_email\(text\) to service_role/
      .test(sql),
  );
  assert(
    /revoke all on function public\.account_op_email\(text\) from authenticated/
      .test(sql),
  );
  for (
    const zin of [
      "Enkel een beheerder",
      "eigen rol",
      "Onbekende rol",
      "laatste beheerder",
    ]
  ) {
    assert(sql.includes(zin), zin);
  }
  assert(sql.includes("for update"));
});

// ───────────── Scherm ─────────────

const GebruikersBeheer = maakGebruikersBeheer(React);

const RIJEN: Gebruiker[] = [
  {
    id: "ik",
    email: "ik@x.be",
    naam: "Peter",
    rollen: ["admin"],
    status: "actief",
  },
  { id: "b", email: "b@x.be", rollen: ["user", "key_user"], status: "actief" },
  { id: "c", email: "c@x.be", rollen: [], status: "uitgenodigd" },
  { id: "d", email: "d@x.be", rollen: ["viewer"], status: "gedeactiveerd" },
];

Deno.test("scherm (statisch): rollen, statussen, jij, extra kolom, geen rol", () => {
  const html = renderToStaticMarkup(
    <GebruikersBeheer
      gebruikers={RIJEN}
      huidigeId="ik"
      instelling={INST}
      rolLabels={{ key_user: "Key user" }}
      onRol={() => null}
      onActief={() => null}
      onOpnieuw={() => null}
      onVerwijder={() => null}
      onBewaar={() => null}
      onUitnodigen={() => null}
      extraKolom={{ kop: "Toegang", cel: (g) => `T:${g.id}` }}
    />,
  );
  assert(html.includes("Peter (jij)"));
  assert(html.includes("Key user"));
  assert(html.includes(">Uitgenodigd<") && html.includes(">Gedeactiveerd<"));
  assert(html.includes("Toegang") && html.includes("T:b"));
  assert(html.includes("Geen rol"));
  assert(html.includes("Opnieuw sturen: c@x.be"));
  assert(!html.includes("Opnieuw sturen: b@x.be"));
  assert(html.includes("Activeren: d@x.be"));
  // Eigen rij: geen deactiveren of verwijderen.
  assert(
    !html.includes("Deactiveren: ik@x.be") &&
      !html.includes("Verwijderen: ik@x.be"),
  );
  assert(html.includes("Gebruiker uitnodigen"));
});

Deno.test("scherm (statisch): Engels en paginering", () => {
  const veel: Gebruiker[] = Array.from({ length: 30 }, (_, i) => ({
    id: `u${i}`,
    email: `u${i}@x.be`,
    rollen: ["user"],
    status: "actief",
  }));
  const html = renderToStaticMarkup(
    <GebruikersBeheer
      gebruikers={veel}
      huidigeId="ik"
      instelling={INST}
      taal="en"
      perPagina={10}
    />,
  );
  assert(html.includes("1-10 of 30"));
  assert(html.includes(GEBRUIKERS_TEKSTEN.en.volgende));
  assert(!html.includes("u10@x.be"));
});

// Happy-dom pas registreren in de eerste DOM-test (zie login_test.tsx).
async function dom() {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  }
  return (await import("react-dom/client")).createRoot;
}
const opties = { sanitizeOps: false, sanitizeResources: false };

async function toon(el: ReactElement) {
  const createRoot = await dom();
  const houder = document.createElement("div");
  document.body.appendChild(houder);
  const root = createRoot(houder);
  await act(() => root.render(el));
  return {
    houder,
    weg: async () => {
      await act(() => root.unmount());
      houder.remove();
    },
  };
}

async function klik(el: Element | null | undefined) {
  assert(el, "element ontbreekt");
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
}

async function typ(el: HTMLInputElement, waarde: string) {
  await act(() => {
    const zet = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    zet.call(el, waarde);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const knopMet = (h: HTMLElement, label: string) =>
  h.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

Deno.test({
  name: "scherm (DOM): zoeken filtert, deactiveren roept onActief",
  ...opties,
  fn: async () => {
    const actief: [string, boolean][] = [];
    const { houder, weg } = await toon(
      <GebruikersBeheer
        gebruikers={RIJEN}
        huidigeId="ik"
        instelling={INST}
        onActief={(g, a) => {
          actief.push([g.id, a]);
          return null;
        }}
      />,
    );
    try {
      const zoek = houder.querySelector(
        'input[type="search"]',
      ) as HTMLInputElement;
      await typ(zoek, "B@X");
      assertEquals(houder.querySelectorAll("tbody tr").length, 1);
      await klik(knopMet(houder, "Deactiveren: b@x.be"));
      assertEquals(actief, [["b", false]]);
      assert(houder.textContent?.includes("Opgeslagen."));
    } finally {
      await weg();
    }
  },
});

Deno.test({
  name: "scherm (DOM): de laatste beheerder deactiveren weigert in het scherm",
  ...opties,
  fn: async () => {
    let geroepen = false;
    const { houder, weg } = await toon(
      <GebruikersBeheer
        gebruikers={[
          { id: "ik", email: "ik@x.be", rollen: ["user"], status: "actief" },
          { id: "a", email: "a@x.be", rollen: ["admin"], status: "actief" },
        ]}
        huidigeId="ik"
        instelling={INST}
        onActief={() => {
          geroepen = true;
        }}
      />,
    );
    try {
      await klik(knopMet(houder, "Deactiveren: a@x.be"));
      assertEquals(geroepen, false);
      assert(
        houder.querySelector('[role="alert"]')?.textContent?.includes(
          "laatste beheerder",
        ),
      );
    } finally {
      await weg();
    }
  },
});

Deno.test({
  name:
    "scherm (DOM): verwijderen vraagt het e-mailadres; een string is een fout",
  ...opties,
  fn: async () => {
    const weg_: string[] = [];
    const { houder, weg } = await toon(
      <GebruikersBeheer
        gebruikers={RIJEN}
        huidigeId="ik"
        instelling={INST}
        onVerwijder={(g) => {
          weg_.push(g.id);
          return weg_.length === 1 ? "Heeft nog klanten." : null;
        }}
      />,
    );
    try {
      await klik(knopMet(houder, "Verwijderen: b@x.be"));
      const dialoog = houder.querySelector('[role="dialog"]')!;
      assert(dialoog.textContent?.includes("b@x.be"));
      const bevestig = [...dialoog.querySelectorAll("button")].find((b) =>
        b.textContent === "Verwijderen"
      )!;
      assert(bevestig.disabled);
      await typ(dialoog.querySelector("input") as HTMLInputElement, " B@x.be");
      assert(!bevestig.disabled);
      await klik(bevestig);
      assertEquals(weg_, ["b"]);
      assert(
        houder.querySelector('[role="dialog"]'),
        "blijft open bij een fout",
      );
      assert(houder.textContent?.includes("Heeft nog klanten."));
      await klik(bevestig);
      assertEquals(houder.querySelector('[role="dialog"]'), null);
    } finally {
      await weg();
    }
  },
});

Deno.test({
  name:
    "scherm (DOM): bewerken en uitnodigen geven genormaliseerde waarden door",
  ...opties,
  fn: async () => {
    const bewaard: unknown[] = [];
    const uitgenodigd: unknown[] = [];
    const { houder, weg } = await toon(
      <GebruikersBeheer
        gebruikers={RIJEN}
        huidigeId="ik"
        instelling={INST}
        onBewaar={(g, w) => {
          bewaard.push([g.id, w]);
        }}
        onUitnodigen={(w) => {
          uitgenodigd.push(w);
        }}
      />,
    );
    try {
      await klik(knopMet(houder, "Bewerken: b@x.be"));
      let dialoog = houder.querySelector('[role="dialog"]')!;
      const [naam, email] = [
        ...dialoog.querySelectorAll("input"),
      ] as HTMLInputElement[];
      assertEquals(email.value, "b@x.be");
      await typ(naam, " An Smet ");
      await typ(email, "AN@X.be​");
      await act(async () => {
        dialoog.querySelector("form")!.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });
      assertEquals(bewaard, [["b", { naam: "An Smet", email: "an@x.be" }]]);

      await klik(
        [...houder.querySelectorAll("button")].find((b) =>
          b.textContent === "Gebruiker uitnodigen"
        ),
      );
      dialoog = houder.querySelector('[role="dialog"]')!;
      const [nEmail] = [
        ...dialoog.querySelectorAll("input"),
      ] as HTMLInputElement[];
      await typ(nEmail, "Nieuw@x.be");
      const rol = dialoog.querySelector("select") as HTMLSelectElement;
      assertEquals(rol.value, "viewer");
      await act(async () => {
        dialoog.querySelector("form")!.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });
      assertEquals(uitgenodigd, [{
        email: "nieuw@x.be",
        naam: "",
        rollen: ["viewer"],
      }]);
    } finally {
      await weg();
    }
  },
});

Deno.test({
  name: "scherm (DOM): rolkeuze roept onRol; eigen rij staat uit",
  ...opties,
  fn: async () => {
    const rollen: unknown[] = [];
    const { houder, weg } = await toon(
      <GebruikersBeheer
        gebruikers={RIJEN}
        huidigeId="ik"
        instelling={INST}
        onRol={(g, r) => {
          rollen.push([g.id, r]);
        }}
      />,
    );
    try {
      const eigen = houder.querySelector(
        'select[aria-label="Rol: ik@x.be"]',
      ) as HTMLSelectElement;
      assert(eigen.disabled);
      const c = houder.querySelector(
        'select[aria-label="Rol: c@x.be"]',
      ) as HTMLSelectElement;
      assertEquals(c.value, "");
      await act(() => {
        c.value = "user";
        c.dispatchEvent(new Event("change", { bubbles: true }));
      });
      assertEquals(rollen, [["c", ["user"]]]);
    } finally {
      await weg();
      if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
    }
  },
});
