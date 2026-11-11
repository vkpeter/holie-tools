import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { maakFetchAdminClient } from "./gebruikers-fetch.ts";
import {
  haalAccount,
  nodigUit,
  verwijder,
  zetActief,
  zoekAccountOpEmail,
} from "./gebruikers.ts";

interface Oproep {
  url: string;
  methode: string;
  headers: Headers;
  body: unknown;
}

type Antw = { status?: number; body?: unknown; tekst?: string };

function neppen(antwoord: (o: Oproep) => Antw | Promise<Antw>) {
  const oproepen: Oproep[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const tekst = typeof init?.body === "string" ? init.body : undefined;
    const o: Oproep = {
      url: String(input),
      methode: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: tekst ? JSON.parse(tekst) : undefined,
    };
    oproepen.push(o);
    const a = await antwoord(o);
    const t = a.tekst ?? (a.body === undefined ? "" : JSON.stringify(a.body));
    return new Response(t || null, { status: a.status ?? 200 });
  }) as typeof fetch;
  return { f, oproepen };
}

const BASIS = "https://x.supabase.co";
const maak = (f: typeof fetch, extra = {}) =>
  maakFetchAdminClient({
    url: BASIS + "/",
    serviceKey: "SLEUTEL",
    fetch: f,
    ...extra,
  });

Deno.test("getUserById: GET, headers zonder content-type, user terug", async () => {
  const { f, oproepen } = neppen(() => ({
    body: { id: "a/b", email: "x@y.be" },
  }));
  const r = await maak(f).auth.admin.getUserById("a/b");
  assertEquals(r, {
    data: { user: { id: "a/b", email: "x@y.be" } },
    error: null,
  });
  const o = oproepen[0];
  assertEquals(o.url, `${BASIS}/auth/v1/admin/users/a%2Fb`);
  assertEquals(o.methode, "GET");
  assertEquals(o.headers.get("apikey"), "SLEUTEL");
  assertEquals(o.headers.get("authorization"), "Bearer SLEUTEL");
  assertEquals(o.headers.get("content-type"), null);
});

Deno.test("getUserById: 404 geeft user null en error met status", async () => {
  const { f } = neppen(() => ({
    status: 404,
    body: { msg: "User not found" },
  }));
  const r = await maak(f).auth.admin.getUserById("1");
  assertEquals(r, {
    data: { user: null },
    error: { message: "User not found", status: 404 },
  });
});

Deno.test("updateUserById: PUT met attrs en content-type", async () => {
  const { f, oproepen } = neppen(() => ({
    body: { id: "1", banned_until: "x" },
  }));
  const r = await maak(f).auth.admin.updateUserById("1", {
    ban_duration: "none",
  });
  assertEquals(r.error, null);
  assertEquals(r.data.user.id, "1");
  const o = oproepen[0];
  assertEquals(o.methode, "PUT");
  assertEquals(o.body, { ban_duration: "none" });
  assertEquals(o.headers.get("content-type"), "application/json");
});

Deno.test("deleteUser: DELETE, ook bij lege body", async () => {
  const { f, oproepen } = neppen(() => ({ status: 200, tekst: "" }));
  const r = await maak(f).auth.admin.deleteUser("1");
  assertEquals(r, { data: { user: null }, error: null });
  assertEquals(oproepen[0].methode, "DELETE");
  const { f: f2 } = neppen(() => ({ status: 422, body: { message: "nee" } }));
  assertEquals((await maak(f2).auth.admin.deleteUser("1")).error, {
    message: "nee",
    status: 422,
  });
});

Deno.test("generateLink: body, redirect_to als query, platte antwoord opgesplitst", async () => {
  const { f, oproepen } = neppen(() => ({
    body: {
      id: "u1",
      email: "a@b.be",
      user_metadata: { full_name: "An" },
      action_link: "https://x/verify?token=t",
      email_otp: "123456",
      hashed_token: "h",
      redirect_to: "https://app/",
      verification_type: "invite",
    },
  }));
  const r = await maak(f).auth.admin.generateLink({
    type: "invite",
    email: "a@b.be",
    newEmail: "c@d.be",
    options: { data: { full_name: "An" }, redirectTo: "https://app/x?a=1&b=2" },
  });
  const o = oproepen[0];
  assertEquals(o.methode, "POST");
  assertEquals(
    o.url,
    `${BASIS}/auth/v1/admin/generate_link?redirect_to=${
      encodeURIComponent("https://app/x?a=1&b=2")
    }`,
  );
  assertEquals(o.body, {
    type: "invite",
    email: "a@b.be",
    new_email: "c@d.be",
    data: { full_name: "An" },
  });
  assertEquals(r.error, null);
  assertEquals(r.data.properties, {
    action_link: "https://x/verify?token=t",
    email_otp: "123456",
    hashed_token: "h",
    redirect_to: "https://app/",
    verification_type: "invite",
  });
  assertEquals(r.data.user, {
    id: "u1",
    email: "a@b.be",
    user_metadata: { full_name: "An" },
  });
});

Deno.test("generateLink: zonder redirectTo geen query; fout geeft null/null", async () => {
  const { f, oproepen } = neppen(() => ({
    status: 422,
    body: { error_description: "Mailadres ongeldig" },
  }));
  const r = await maak(f).auth.admin.generateLink({
    type: "magiclink",
    email: "x",
  });
  assertEquals(oproepen[0].url, `${BASIS}/auth/v1/admin/generate_link`);
  assertEquals(r, {
    data: { properties: null, user: null },
    error: { message: "Mailadres ongeldig", status: 422 },
  });
});

Deno.test("rpc: POST met args, encodeURIComponent, 204 wordt null", async () => {
  const { f, oproepen } = neppen(() => ({ status: 204 }));
  const r = await maak(f).rpc("a b/c", { p: 1 });
  assertEquals(r, { data: null, error: null });
  assertEquals(oproepen[0].url, `${BASIS}/rest/v1/rpc/a%20b%2Fc`);
  assertEquals(oproepen[0].body, { p: 1 });
  const { f: f2, oproepen: o2 } = neppen(() => ({ body: "uuid-1" }));
  assertEquals((await maak(f2).rpc("n")).data, "uuid-1");
  assertEquals(o2[0].body, {});
});

Deno.test("foutboodschap: msg, message, error_description, error, anders HTTP status", async () => {
  const gevallen: [unknown, string][] = [
    [{ msg: "m1" }, "m1"],
    [{ message: "m2" }, "m2"],
    [{ error_description: "m3" }, "m3"],
    [{ error: "m4" }, "m4"],
    [{}, "HTTP 500"],
  ];
  for (const [body, verwacht] of gevallen) {
    const { f } = neppen(() => ({ status: 500, body }));
    const r = await maak(f).rpc("x");
    assertEquals(r.error, { message: verwacht, status: 500 });
  }
  const { f } = neppen(() => ({ status: 502, tekst: "<html>bad gateway" }));
  assertEquals((await maak(f).rpc("x")).error, {
    message: "HTTP 502",
    status: 502,
  });
});

Deno.test("niet-JSON bij 200 is een fout, geen worp", async () => {
  const { f } = neppen(() => ({ tekst: "<html>" }));
  const r = await maak(f).auth.admin.getUserById("1");
  assertEquals(r.data, { user: null });
  assertEquals(r.error?.status, 200);
});

Deno.test("netwerkfout gooit niet", async () => {
  const f = (() => Promise.reject(new TypeError("kapot"))) as typeof fetch;
  const r = await maak(f).rpc("x");
  assertEquals(r, { data: null, error: { message: "kapot", status: 0 } });
  const u = await maak(f).auth.admin.updateUserById("1", {});
  assertEquals(u.data, { user: null });
  assertEquals(u.error.status, 0);
});

Deno.test("time-out gooit niet", async () => {
  const f = ((_u: string, init?: RequestInit) =>
    new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
    })) as typeof fetch;
  const r = await maak(f, { timeoutMs: 20 }).rpc("x");
  assertEquals(r.data, null);
  assertEquals(r.error.status, 0);
  assertStringIncludes(r.error.message, "Time-out");
});

Deno.test("integratie: zetActief, verwijder, haalAccount, zoekAccountOpEmail", async () => {
  const { f, oproepen } = neppen((o) => {
    if (o.url.endsWith("/rpc/account_op_email")) return { body: "u1" };
    if (o.methode === "GET") {
      return { body: { id: "u1", email: "a@b.be", created_at: "2026-01-01" } };
    }
    return { body: {} };
  });
  const admin = maak(f);
  assertEquals(await zetActief(admin, "u1", false), { ok: true });
  assertEquals(
    (oproepen[0].body as { ban_duration: string }).ban_duration,
    "876000h",
  );
  assertEquals(await zetActief(admin, "u1", true), { ok: true });
  assertEquals(oproepen[1].body, { ban_duration: "none" });
  assertEquals(await verwijder(admin, "u1"), { ok: true });
  assertEquals(oproepen[2].methode, "DELETE");
  const acc = await haalAccount(admin, "u1");
  assert(acc.ok && acc.account.email === "a@b.be");
  assertEquals(await zoekAccountOpEmail(admin, "A@B.be"), {
    ok: true,
    id: "u1",
  });
  assertEquals(oproepen[4].body, { p_email: "a@b.be" });

  const { f: f404 } = neppen(() => ({ status: 404, body: { msg: "weg" } }));
  const weg = await haalAccount(maak(f404), "u1");
  assert(!weg.ok && weg.fout === "niet_gevonden" && weg.detail === "weg");
  const mis = await verwijder(maak(f404), "u1");
  assert(!mis.ok && mis.fout === "verwijderen");
});

Deno.test("integratie: nodigUit (nieuw adres) met nep-mail", async () => {
  const { f, oproepen } = neppen((o) => {
    if (o.url.endsWith("/rpc/account_op_email")) return { body: null };
    return {
      body: {
        id: "nieuw1",
        email: "nieuw@b.be",
        user_metadata: { full_name: "Nina" },
        action_link: "https://x/verify?token=t",
        hashed_token: "h",
        redirect_to: "https://app/",
        verification_type: "invite",
        email_otp: "1",
      },
    };
  });
  const echteFetch = globalThis.fetch;
  const mails: { url: string; body: { to: string[]; html: string } }[] = [];
  globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) => {
    mails.push({ url: String(u), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(new Response(JSON.stringify({ id: "m1" })));
  }) as typeof fetch;
  try {
    const r = await nodigUit(maak(f), {
      email: "Nieuw@B.be",
      naam: "Nina",
      redirectTo: "https://app/",
      bevestigLink: (l) =>
        `https://app/auth/confirm?via=${encodeURIComponent(l)}`,
      mail: {
        apiKey: "re_test",
        from: "App <app@b.be>",
        onderwerp: "Welkom",
        html: (link, naam) => `<a href="${link}">${naam}</a>`,
        apiBasis: "https://resend.test",
      },
    });
    assertEquals(r, {
      ok: true,
      status: "uitgenodigd",
      id: "nieuw1",
      email: "nieuw@b.be",
    });
  } finally {
    globalThis.fetch = echteFetch;
  }
  const gen = oproepen[1];
  assertStringIncludes(gen.url, "/auth/v1/admin/generate_link?redirect_to=");
  assertEquals(gen.body, {
    type: "invite",
    email: "nieuw@b.be",
    data: { full_name: "Nina" },
  });
  assertEquals(mails.length, 1);
  assertEquals(mails[0].url, "https://resend.test/emails");
  assertStringIncludes(mails[0].body.html, "Nina");
});

Deno.test("integratie: nodigUit droog en met generateLink-fout", async () => {
  const { f } = neppen((o) =>
    o.url.endsWith("/rpc/account_op_email")
      ? { body: null }
      : { status: 422, body: { msg: "geweigerd" } }
  );
  const opties = {
    email: "a@b.be",
    redirectTo: "https://app/",
    bevestigLink: (l: string) => l,
    mail: { apiKey: "k", from: "a@b.be", onderwerp: "o", html: () => "" },
  };
  assertEquals(await nodigUit(maak(f), { ...opties, droog: true }), {
    ok: true,
    status: "uitgenodigd",
    id: null,
    email: "a@b.be",
    droog: true,
  });
  const r = await nodigUit(maak(f), opties);
  assert(!r.ok && r.fout === "link" && r.detail === "geweigerd");
});
