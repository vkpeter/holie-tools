/// <reference lib="dom" />
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { assert, assertEquals } from "@std/assert";
import * as React from "react";
import { act, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LOGIN_TEKSTEN,
  type LoginInvoerProps,
  type LoginKnopProps,
  maakLoginBlok,
} from "./login.ts";

const LoginBlok = maakLoginBlok(React);

// Happy-dom pas registreren in de eerste DOM-test: op topniveau vangt hij de load-gebeurtenis
// van Deno zelf op en faalt die. De laatste test ruimt hem weer op.
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

async function vulIn(h: HTMLElement) {
  const [email, ww] = [...h.querySelectorAll("input")] as HTMLInputElement[];
  await typ(email, "a@b.test");
  await typ(ww, "geheim123");
}

async function typ(el: HTMLInputElement, waarde: string) {
  const zet = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(() => {
    zet.call(el, waarde);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function knoppen(h: HTMLElement): HTMLButtonElement[] {
  return [...h.querySelectorAll("button")] as HTMLButtonElement[];
}

Deno.test("volgorde: Google, dan 'of', dan het formulier", () => {
  const html = renderToStaticMarkup(
    <LoginBlok onGoogle={() => {}} onEmail={() => null} />,
  );
  const g = html.indexOf("Doorgaan met Google");
  const of = html.indexOf('role="separator"');
  const form = html.indexOf("<form");
  assert(g > 0 && of > g && form > of, html);
  assert(html.includes('fill="#4285F4"'), "officieel G-logo");
});

Deno.test("zonder onGoogle: geen knop en geen scheiding", () => {
  const html = renderToStaticMarkup(<LoginBlok onEmail={() => null} />);
  assert(!html.includes("Google"));
  assert(!html.includes('role="separator"'));
});

Deno.test("velden: echt type, labels, autocomplete, vaste ids", () => {
  const html = renderToStaticMarkup(
    <LoginBlok
      onEmail={() => null}
      ids={{ email: "email", wachtwoord: "password" }}
    />,
  );
  assert(html.includes('id="email"') && html.includes('type="email"'));
  assert(html.includes('id="password"') && html.includes('type="password"'));
  assert(html.includes('for="email"') && html.includes('for="password"'));
  assert(html.includes('autoComplete="current-password"'));
});

Deno.test("talen en losse teksten", () => {
  const en = renderToStaticMarkup(
    <LoginBlok taal="en" onGoogle={() => {}} onEmail={() => null} />,
  );
  assert(en.includes(LOGIN_TEKSTEN.en.google));
  const rb = renderToStaticMarkup(
    <LoginBlok onEmail={() => null} teksten={{ inloggen: "Aanmelden" }} />,
  );
  assert(rb.includes(">Aanmelden</button>"));
});

Deno.test("e-mail: leeg formulier wordt niet verstuurd", opties, async () => {
  let geroepen = false;
  const { houder, weg } = await toon(
    <LoginBlok onEmail={() => (geroepen = true, null)} />,
  );
  await act(() => houder.querySelector("form")!.requestSubmit());
  assertEquals(geroepen, false);
  await weg();
});

Deno.test(
  "e-mail: roept onEmail met het adres zonder spaties",
  opties,
  async () => {
    const ontvangen: string[][] = [];
    const { houder, weg } = await toon(
      <LoginBlok
        onEmail={(e, w) => {
          ontvangen.push([e, w]);
          return null;
        }}
      />,
    );
    const [email, ww] = [
      ...houder.querySelectorAll("input"),
    ] as HTMLInputElement[];
    await typ(email, "  peter@voorbeeld.test ");
    await typ(ww, "geheim123");
    await act(() => houder.querySelector("form")!.requestSubmit());
    assertEquals(ontvangen, [["peter@voorbeeld.test", "geheim123"]]);
    assertEquals(houder.querySelector('[role="alert"]'), null);
    await weg();
  },
);

Deno.test(
  "e-mail: een string als antwoord is een foutmelding",
  opties,
  async () => {
    const { houder, weg } = await toon(
      <LoginBlok onEmail={() => Promise.resolve("Ongeldige inloggegevens")} />,
    );
    await vulIn(houder);
    await act(() => houder.querySelector("form")!.requestSubmit());
    assertEquals(
      houder.querySelector('[role="alert"]')?.textContent,
      "Ongeldige inloggegevens",
    );
    // Na de fout kan je opnieuw proberen
    assertEquals(knoppen(houder).at(-1)!.disabled, false);
    await weg();
  },
);

Deno.test("e-mail: een fout gooien toont de boodschap", opties, async () => {
  const { houder, weg } = await toon(
    <LoginBlok
      onEmail={() => {
        throw new Error("Geen verbinding");
      }}
    />,
  );
  await vulIn(houder);
  await act(() => houder.querySelector("form")!.requestSubmit());
  assertEquals(
    houder.querySelector('[role="alert"]')?.textContent,
    "Geen verbinding",
  );
  await weg();
});

Deno.test(
  "Google: bezig tijdens het vertrek, fout zet hem terug",
  opties,
  async () => {
    let weiger: (e: Error) => void = () => {};
    const { houder, weg } = await toon(
      <LoginBlok
        onGoogle={() => new Promise((_, nee) => (weiger = nee))}
        onEmail={() => null}
      />,
    );
    const g = knoppen(houder)[0];
    await act(() => g.click());
    assertEquals(g.textContent, LOGIN_TEKSTEN.nl.googleBezig);
    assert(g.disabled);
    await act(() => weiger(new Error("Provider is not enabled")));
    assertEquals(g.textContent, LOGIN_TEKSTEN.nl.google);
    assert(!g.disabled);
    assertEquals(
      houder.querySelector('[role="alert"]')?.textContent,
      "Provider is not enabled",
    );
    await weg();
  },
);

Deno.test(
  "melding van buiten: info is een status, geen alarm",
  opties,
  async () => {
    const { houder, weg } = await toon(
      <LoginBlok
        onEmail={() => null}
        melding={{ soort: "info", tekst: "Geen uitnodiging" }}
      />,
    );
    assertEquals(
      houder.querySelector('[role="status"]')?.textContent,
      "Geen uitnodiging",
    );
    assertEquals(houder.querySelector('[role="alert"]'), null);
    await weg();
  },
);

Deno.test(
  "wachtwoord vergeten: link, handeling met het adres, eigen element",
  opties,
  async () => {
    const link = renderToStaticMarkup(
      <LoginBlok
        onEmail={() => null}
        wachtwoordVergeten={{ href: "/wachtwoord" }}
      />,
    );
    assert(link.includes('<a href="/wachtwoord"'));

    let adres = "";
    const { houder, weg } = await toon(
      <LoginBlok
        onEmail={() => null}
        wachtwoordVergeten={{ onClick: (e) => (adres = e) }}
      />,
    );
    await typ(houder.querySelector("input")!, "a@b.test");
    const knop = knoppen(houder).find((b) =>
      b.textContent === "Wachtwoord vergeten?"
    )!;
    await act(() => knop.click());
    assertEquals(adres, "a@b.test");
    await weg();

    const eigen = renderToStaticMarkup(
      <LoginBlok
        onEmail={() => null}
        wachtwoordVergeten={{
          render: (t, k) => <a data-router="" className={k} href="/w">{t}</a>,
        }}
      />,
    );
    assert(eigen.includes('data-router=""'));
  },
);

Deno.test("eigen onderdelen van de app worden gebruikt", () => {
  const Knop = (p: LoginKnopProps) => (
    <button data-eigen="knop" type={p.type} disabled={p.disabled}>
      {p.children}
    </button>
  );
  const Invoer = (p: LoginInvoerProps) => <input data-eigen="invoer" {...p} />;
  const html = renderToStaticMarkup(
    <LoginBlok onEmail={() => null} onderdelen={{ Knop, Invoer }} />,
  );
  assertEquals(html.split('data-eigen="invoer"').length - 1, 2);
  assert(html.includes('data-eigen="knop"'));
});

Deno.test("children vervangt het formulier, volgorde blijft", () => {
  const html = renderToStaticMarkup(
    <LoginBlok onGoogle={() => {}} onderFormulier={<p>onder</p>}>
      <form data-registreer="">registreren</form>
    </LoginBlok>,
  );
  const g = html.indexOf("Doorgaan met Google");
  const f = html.indexOf("data-registreer");
  const o = html.indexOf("<p>onder</p>");
  assert(g > 0 && f > g && o > f);
  assert(!html.includes('type="password"'));
});

Deno.test("opruimen: happy-dom weer weg", opties, async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});
