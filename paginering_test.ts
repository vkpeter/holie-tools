import { assertEquals } from "@std/assert";
import { paginaPad, paginaVenster, pagineer } from "./paginering.ts";

const lijst = Array.from({ length: 20 }, (_, i) => i + 1);

Deno.test("pagineer: eerste, middelste en laatste pagina", () => {
  const p1 = pagineer(lijst, 1, 9);
  assertEquals(p1.items.length, 9);
  assertEquals(
    [p1.pagina, p1.aantalPaginas, p1.totaal, p1.vorige, p1.volgende],
    [1, 3, 20, null, 2],
  );
  const p2 = pagineer(lijst, 2, 9);
  assertEquals(p2.items[0], 10);
  assertEquals([p2.vorige, p2.volgende], [1, 3]);
  const p3 = pagineer(lijst, 3, 9);
  assertEquals(p3.items, [19, 20]);
  assertEquals([p3.vorige, p3.volgende], [2, null]);
});

Deno.test("pagineer: buiten bereik en lege lijst", () => {
  assertEquals(pagineer(lijst, 99, 9).pagina, 3);
  assertEquals(pagineer(lijst, 0, 9).pagina, 1);
  assertEquals(pagineer(lijst, NaN, 9).pagina, 1);
  const leeg = pagineer([], 1, 9);
  assertEquals([leeg.items, leeg.aantalPaginas, leeg.vorige, leeg.volgende], [
    [],
    1,
    null,
    null,
  ]);
});

Deno.test("paginaPad: pagina 1 is de basis, de rest krijgt een segment", () => {
  assertEquals(paginaPad("/blog", 1), "/blog");
  assertEquals(paginaPad("/blog", 2), "/blog/page/2");
  assertEquals(paginaPad("/en/blog/", 3), "/en/blog/page/3");
  assertEquals(paginaPad("/blog", 2, "pagina"), "/blog/pagina/2");
  assertEquals(paginaPad("", 1), "/");
  assertEquals(paginaPad("/", 2), "/page/2");
});

Deno.test("paginaVenster: korte lijst toont alles, lange krijgt puntjes", () => {
  assertEquals(paginaVenster(1, 1), [1]);
  assertEquals(paginaVenster(1, 0), []);
  assertEquals(paginaVenster(2, 7), [1, 2, 3, 4, 5, 6, 7]);
  assertEquals(paginaVenster(1, 20), [1, 2, 3, 4, 5, 6, "...", 20]);
  assertEquals(paginaVenster(10, 20), [1, "...", 8, 9, 10, 11, 12, "...", 20]);
  assertEquals(paginaVenster(20, 20), [1, "...", 15, 16, 17, 18, 19, 20]);
  assertEquals(paginaVenster(4, 20), [1, 2, 3, 4, 5, 6, "...", 20]);
});
