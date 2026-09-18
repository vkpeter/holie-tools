import { assertEquals, assertStrictEquals } from "@std/assert";
import { escapeHtml } from "./html.ts";
import { escapeHtml as viaTelegram } from "./telegram.ts";

Deno.test("escapeHtml escapet alle vijf, & eerst", () => {
  assertEquals(
    escapeHtml(`<a href='x'>"a" & b</a>`),
    "&lt;a href=&#39;x&#39;&gt;&quot;a&quot; &amp; b&lt;/a&gt;",
  );
  // Geen dubbele escaping van wat al een entiteit lijkt: & gaat altijd mee.
  assertEquals(escapeHtml("&amp;"), "&amp;amp;");
});

Deno.test("telegram heruitvoer is dezelfde functie", () => {
  assertStrictEquals(viaTelegram, escapeHtml);
});
