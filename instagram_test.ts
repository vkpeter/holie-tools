import { assertEquals } from "@std/assert";
import { geldigeCarrouselUrls, postCarrousel } from "./instagram.ts";

type Call = {
  url: string;
  params: Record<string, string>;
  auth: string | null;
};

/** Nep-fetch: legt elke call vast; `faalOp` laat de call die aan de voorwaarde voldoet falen. */
function nepFetch(faalOp?: (c: Call) => boolean) {
  const calls: Call[] = [];
  let kind = 0;
  const fetchFn = (url: string, init?: RequestInit) => {
    const params: Record<string, string> = init?.body
      ? Object.fromEntries(new URLSearchParams(init.body as URLSearchParams))
      : {};
    const auth = new Headers(init?.headers).get("authorization");
    const c = { url, params, auth };
    calls.push(c);
    const antw = (b: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(b), { status }));
    if (faalOp?.(c)) {
      return antw({ error: { message: "nep fout", code: 100 } }, 400);
    }
    if (url.includes("fields=status_code")) {
      return antw({ status_code: "FINISHED" });
    }
    if (url.endsWith("/media_publish")) return antw({ id: "POST1" });
    if (params.media_type === "CAROUSEL") return antw({ id: "CAR1" });
    return antw({ id: `KIND${++kind}` });
  };
  return { fetchFn, calls };
}

const urls = [1, 2, 3, 4].map((n) =>
  `https://cdn.example.org/a/kaart-${n}.jpg`
);
const basis = {
  igUserId: "IG",
  accessToken: "TOK",
  caption: "Hallo",
  versie: "v18.0",
  wacht: () => Promise.resolve(),
};

Deno.test("carrousel met 4 beelden: volgorde en params", async () => {
  const { fetchFn, calls } = nepFetch();
  const u = await postCarrousel({ ...basis, fetchFn, imageUrls: urls });
  assertEquals(u, { ok: true, id: "POST1" });
  const soorten = calls.map((c) =>
    c.url.includes("status_code")
      ? "status"
      : c.url.endsWith("/media_publish")
      ? "publish"
      : c.params.media_type === "CAROUSEL"
      ? "carrousel"
      : "kind"
  );
  assertEquals(soorten, [
    "kind",
    "kind",
    "kind",
    "kind",
    "status",
    "status",
    "status",
    "status",
    "carrousel",
    "status",
    "publish",
  ]);
  const kinderen = calls.filter((c) => c.params.is_carousel_item);
  assertEquals(kinderen.map((c) => c.params.image_url), urls);
  assertEquals(kinderen[0].params.is_carousel_item, "true");
  assertEquals(kinderen[0].url, "https://graph.facebook.com/v18.0/IG/media");
  assertEquals("caption" in kinderen[0].params, false);
  const car = calls.find((c) => c.params.media_type === "CAROUSEL")!;
  assertEquals(car.params.children, "KIND1,KIND2,KIND3,KIND4");
  assertEquals(car.params.caption, "Hallo");
  assertEquals(calls[calls.length - 1].params.creation_id, "CAR1");
});

Deno.test("een kind faalt: voorbereiding-fout, nooit publish (terugval op enkel beeld)", async () => {
  const { fetchFn, calls } = nepFetch((c) => c.params.image_url === urls[2]);
  const u = await postCarrousel({ ...basis, fetchFn, imageUrls: urls });
  assertEquals(u.ok, false);
  if (!u.ok) assertEquals(u.fase, "voorbereiding");
  assertEquals(calls.some((c) => c.url.endsWith("/media_publish")), false);
});

Deno.test("publicatie faalt: fase publicatie (geen terugval)", async () => {
  const { fetchFn } = nepFetch((c) => c.url.endsWith("/media_publish"));
  const u = await postCarrousel({ ...basis, fetchFn, imageUrls: urls });
  assertEquals(u.ok, false);
  if (!u.ok) assertEquals(u.fase, "publicatie");
});

Deno.test("geen (geldige) imageUrls: null, dus de oude flow", () => {
  assertEquals(geldigeCarrouselUrls(undefined), null);
  assertEquals(geldigeCarrouselUrls(null), null);
  assertEquals(geldigeCarrouselUrls(["https://a/1.jpg"]), null);
  assertEquals(
    geldigeCarrouselUrls(["https://a/1.jpg", "http://a/2.jpg"]),
    null,
  );
  assertEquals(geldigeCarrouselUrls(Array(11).fill("https://a/1.jpg")), null);
  assertEquals(geldigeCarrouselUrls(["https://a/1.jpg", "https://a/2.jpg"]), [
    "https://a/1.jpg",
    "https://a/2.jpg",
  ]);
});

Deno.test("token enkel in de Authorization-header, nooit in URL of body", async () => {
  const { fetchFn, calls } = nepFetch();
  await postCarrousel({ ...basis, fetchFn, imageUrls: urls });
  assertEquals(calls.length, 11);
  for (const c of calls) {
    assertEquals(c.auth, "Bearer TOK");
    assertEquals(
      c.url.includes("TOK") || c.url.includes("access_token"),
      false,
    );
    assertEquals("access_token" in c.params, false);
  }
});
