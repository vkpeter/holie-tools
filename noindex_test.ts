import { assertEquals } from "@std/assert";
import {
  disallowTegenNoindex,
  type DocumentLike,
  isNoindexPad,
  noindexHeadersBlok,
  noindexMeta,
  noindexPadenVoor,
  normaliseerPad,
  robotsMeta,
  valtOnderBasis,
  zetNoindex,
  zetNoindexBlok,
} from "./noindex.ts";

Deno.test("normaliseerPad: query, hash, slot-slash en hoofdletters", () => {
  assertEquals(normaliseerPad("/Admin/?x=1#y"), "/admin");
  assertEquals(normaliseerPad("auth"), "/auth");
  assertEquals(normaliseerPad("/"), "/");
});

Deno.test("valtOnderBasis: hele segmenten", () => {
  assertEquals(valtOnderBasis("/admin/team", "/admin"), true);
  assertEquals(valtOnderBasis("/admin", "/admin"), true);
  assertEquals(valtOnderBasis("/administratie", "/admin"), false);
});

Deno.test("isNoindexPad en robotsMeta: standaardlijst", () => {
  assertEquals(isNoindexPad("/unsubscribe?token=abc"), true);
  assertEquals(isNoindexPad("/reset-password"), true);
  assertEquals(isNoindexPad("/oauth/consent"), true);
  assertEquals(isNoindexPad("/privacy"), false);
  assertEquals(isNoindexPad("/artikel/auth-uitleg"), false);
  assertEquals(robotsMeta("/login"), "noindex, nofollow");
  assertEquals(robotsMeta("/over"), undefined);
});

Deno.test("noindexPadenVoor: enkel wat in de app bestaat, plus extra", () => {
  const routes = [
    "/",
    "/auth",
    "/admin",
    "/admin/team",
    "/{-$lang}/account",
    "/privacy",
    "/r/$id",
    "/oauth/consent",
  ];
  assertEquals(noindexPadenVoor(routes, ["/r"]), [
    "/account",
    "/admin",
    "/auth",
    "/oauth",
    "/r",
  ]);
  assertEquals(noindexPadenVoor(["/", "/over"]), []);
});

Deno.test("noindexMeta", () => {
  assertEquals(noindexMeta(), { name: "robots", content: "noindex, nofollow" });
});

Deno.test("noindexHeadersBlok: pad en alles eronder, gesorteerd en uniek", () => {
  const blok = noindexHeadersBlok(["/auth", "/admin", "/auth/"]);
  assertEquals(
    blok.split("\n").filter((r) => !r.startsWith("#")).join("\n"),
    [
      "/admin",
      "  X-Robots-Tag: noindex, nofollow",
      "/admin/*",
      "  X-Robots-Tag: noindex, nofollow",
      "/auth",
      "  X-Robots-Tag: noindex, nofollow",
      "/auth/*",
      "  X-Robots-Tag: noindex, nofollow",
      "",
    ].join("\n"),
  );
  assertEquals(noindexHeadersBlok([]), "");
});

Deno.test("zetNoindexBlok: toevoegen, vervangen, idempotent, rest blijft", () => {
  const basis =
    "/*\n  X-Content-Type-Options: nosniff\n\n/sw.js\n  Cache-Control: no-cache\n";
  const een = zetNoindexBlok(basis, ["/auth"]);
  assertEquals(een.startsWith(basis.trimEnd()), true);
  assertEquals(een.includes("/auth/*"), true);
  assertEquals(zetNoindexBlok(een, ["/auth"]), een);
  const twee = zetNoindexBlok(een + "\n/later\n  Cache-Control: no-cache\n", [
    "/admin",
  ]);
  assertEquals(twee.includes("/auth"), false);
  assertEquals(twee.includes("/admin/*"), true);
  assertEquals(twee.includes("/later"), true);
  assertEquals(twee.includes("/sw.js"), true);
  assertEquals(zetNoindexBlok(twee, ["/admin"]), twee);
  // lege lijst haalt het blok weg
  assertEquals(zetNoindexBlok(een, []).includes("holie-noindex"), false);
  assertEquals(zetNoindexBlok(basis, []), basis);
});

Deno.test("zetNoindexBlok: CRLF blijft CRLF", () => {
  const crlf = "/*\r\n  A: b\r\n";
  const uit = zetNoindexBlok(crlf, ["/auth"]);
  assertEquals(uit.includes("\r\n"), true);
  assertEquals(/[^\r]\n/.test(uit), false);
});

Deno.test("disallowTegenNoindex: Disallow verbergt de noindex", () => {
  const robots = `# x
User-agent: Googlebot
Allow: /

User-agent: *
Allow: /
Disallow: /auth
Disallow: /admin/
`;
  assertEquals(disallowTegenNoindex(robots, ["/auth", "/admin", "/login"]), [
    "/auth",
    "/admin",
  ]);
  assertEquals(
    disallowTegenNoindex("User-agent: Googlebot\nDisallow: /auth\n", ["/auth"]),
    [],
  );
});

Deno.test("zetNoindex: nieuwe meta, bestaande vervangen, herstel", () => {
  // minimale nepdocument-implementatie
  type Meta = {
    attrs: Record<string, string>;
    setAttribute(k: string, v: string): void;
    getAttribute(k: string): string | null;
    removeAttribute(k: string): void;
    remove(): void;
  };
  const kinderen: Meta[] = [];
  const nieuw = (): Meta => {
    const m: Meta = {
      attrs: {},
      setAttribute(k, v) {
        m.attrs[k] = v;
      },
      getAttribute(k) {
        return m.attrs[k] ?? null;
      },
      removeAttribute(k) {
        delete m.attrs[k];
      },
      remove() {
        kinderen.splice(kinderen.indexOf(m), 1);
      },
    };
    return m;
  };
  const doc = {
    head: {
      querySelector: () => kinderen[0] ?? null,
      appendChild: (m: Meta) => kinderen.push(m),
    },
    createElement: nieuw,
  } as unknown as DocumentLike;
  const herstel = zetNoindex(doc);
  assertEquals(kinderen.length, 1);
  assertEquals(kinderen[0].attrs.content, "noindex, nofollow");
  herstel();
  assertEquals(kinderen.length, 0);
  const bestaand = nieuw();
  bestaand.setAttribute("name", "robots");
  bestaand.setAttribute("content", "index, follow");
  kinderen.push(bestaand);
  const h2 = zetNoindex(doc);
  assertEquals(bestaand.attrs.content, "noindex, nofollow");
  h2();
  assertEquals(bestaand.attrs.content, "index, follow");
  assertEquals(zetNoindex(undefined) instanceof Function, true);
});
