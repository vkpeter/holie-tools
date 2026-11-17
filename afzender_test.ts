import { assertEquals } from "@std/assert";
import {
  afzenderUitSessie,
  type AuthLezer,
  isIngelogdMetAdres,
  naamUitSessie,
  type SessieGebruiker,
  sessieGebruiker,
} from "./afzender.ts";

const jwt = "aaa.bbb.ccc";
const req = (kop?: string) =>
  new Request("https://x.test", {
    method: "POST",
    headers: kop ? { Authorization: kop } : {},
  });
const client = (
  user: SessieGebruiker | null,
  error: unknown = null,
): AuthLezer => ({
  auth: { getUser: () => Promise.resolve({ data: { user }, error }) },
});

Deno.test("ingelogd: adres uit de sessie, body-adres telt niet", () => {
  const a = afzenderUitSessie(
    { email: "Peter@Holie.be", email_confirmed_at: "2026-01-01" },
    { name: "Peter", email: "iemand-anders@example.com" },
  );
  assertEquals(a, { email: "peter@holie.be", naam: "Peter", ingelogd: true });
});

Deno.test("ingelogd zonder naam in het formulier: naam uit het profiel", () => {
  const user = { email: "a@b.be", user_metadata: { full_name: "Ann Peeters" } };
  assertEquals(afzenderUitSessie(user, { name: "  " }).naam, "Ann Peeters");
  assertEquals(afzenderUitSessie(user).naam, "Ann Peeters");
  assertEquals(naamUitSessie({ user_metadata: { name: "Bob" } }), "Bob");
  assertEquals(naamUitSessie({ user_metadata: { full_name: 5 } }), null);
});

Deno.test("niet ingelogd: alles uit het formulier", () => {
  assertEquals(
    afzenderUitSessie(null, { name: "Eva", email: " EVA@Example.com " }),
    { email: "eva@example.com", naam: "Eva", ingelogd: false },
  );
  assertEquals(
    afzenderUitSessie(null, { name: "Eva", email: "nee" }).email,
    null,
  );
  assertEquals(afzenderUitSessie(undefined).ingelogd, false);
});

Deno.test("anoniem, zonder adres of onbevestigd telt niet als ingelogd", () => {
  assertEquals(
    isIngelogdMetAdres({ email: "a@b.be", is_anonymous: true }),
    false,
  );
  assertEquals(isIngelogdMetAdres({ email: "" }), false);
  assertEquals(isIngelogdMetAdres({ email: "kapot" }), false);
  assertEquals(
    isIngelogdMetAdres({ email: "a@b.be", email_confirmed_at: null }),
    false,
  );
  assertEquals(
    isIngelogdMetAdres({ email: "a@b.be", confirmed_at: "x" }),
    true,
  );
  const a = afzenderUitSessie({ email: "a@b.be", email_confirmed_at: null }, {
    email: "c@d.be",
  });
  assertEquals(a.email, "c@d.be");
  assertEquals(a.ingelogd, false);
});

Deno.test("sessieGebruiker: geldig token geeft de gebruiker", async () => {
  const u = { email: "a@b.be" };
  assertEquals(await sessieGebruiker(req(`Bearer ${jwt}`), client(u)), u);
});

Deno.test("sessieGebruiker: geen kop, geen JWT-vorm, fout of uitzondering geeft null", async () => {
  const u = { email: "a@b.be" };
  assertEquals(await sessieGebruiker(req(), client(u)), null);
  assertEquals(
    await sessieGebruiker(req("Bearer sb_publishable_x"), client(u)),
    null,
  );
  assertEquals(
    await sessieGebruiker(req(`Bearer ${jwt}`), client(null, "kapot")),
    null,
  );
  assertEquals(await sessieGebruiker(req(`Bearer ${jwt}`), client(null)), null);
  const werpt: AuthLezer = {
    auth: { getUser: () => Promise.reject(new Error("net")) },
  };
  assertEquals(await sessieGebruiker(req(`Bearer ${jwt}`), werpt), null);
});
