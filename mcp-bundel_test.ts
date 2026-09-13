import { assert, assertEquals, assertMatch } from "@std/assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BANNER,
  controleerInhoud,
  controleerMcpBundel,
  ENTRY,
  isLokaalPad,
  leesEnv,
  normaliseer,
  npmSpecifier,
  toolnamenUitTekst,
  vergelijkBundels,
} from "./mcp-bundel.ts";

Deno.test("absolute paden, ook van Windows, gelden als lokaal (de stub-bug van 4 sep 2026)", () => {
  for (
    const p of [
      "./x.ts",
      "../x.ts",
      "/home/x.ts",
      "C:\\Users\\x\\index.ts",
      "C:/Users/x.ts",
      "\\\\server\\x.ts",
    ]
  ) {
    assert(isLokaalPad(p), p);
  }
  for (const p of ["zod", "@lovable.dev/mcp-js/stacks/supabase"]) {
    assert(!isLokaalPad(p), p);
  }
});

Deno.test("de entry importeert de MCP relatief, nooit via een absoluut pad", () => {
  const imports = [...ENTRY.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assertEquals(imports[0], "./src/lib/mcp/index.ts");
  for (const p of imports) assert(!/^[A-Za-z]:[\\/]|^\//.test(p), p);
});

Deno.test("npmSpecifier pint de SDK en neemt versies uit package.json", () => {
  assertEquals(
    npmSpecifier("@lovable.dev/mcp-js/stacks/supabase", {}, "0.26.2"),
    "npm:@lovable.dev/mcp-js@0.26.2/stacks/supabase",
  );
  assertEquals(npmSpecifier("zod", { zod: "^4.1.0" }, "x"), "npm:zod@^4.1.0");
  assertEquals(
    npmSpecifier("lokaal", { lokaal: "file:../x" }, "x"),
    "npm:lokaal",
  );
});

Deno.test("normaliseer negeert CRLF en de @ts-nocheck-regel", () => {
  const met = BANNER.replace(/\n/g, "\r\n") + "code\r\n";
  const zonder = BANNER.replace("// @ts-nocheck\n", "") + "code\n";
  assertEquals(normaliseer(met), normaliseer(zonder));
  assertEquals(vergelijkBundels(met, zonder), null);
  assertMatch(
    vergelijkBundels(zonder, zonder + "extra\n") ?? "",
    /eerste verschil op regel/,
  );
});

Deno.test("controleerInhoud vangt een stub en een weggehaalde banner", () => {
  const namen = toolnamenUitTekst(
    `defineTool({ name: "get_article" }); tool({ name: 'list_articles' })`,
  );
  assertEquals(namen, ["get_article", "list_articles"]);
  const stub = BANNER + `import mcp from "npm:C:\\\\Users\\\\x\\\\index.ts";\n`;
  assertEquals(controleerInhoud(stub, namen).length, 1);
  assertEquals(
    controleerInhoud(`// eigen code\n"get_article" "list_articles"`, namen)
      .length,
    1,
  );
  assertEquals(
    controleerInhoud(BANNER + `"get_article" "list_articles"`, namen),
    [],
  );
});

Deno.test("leesEnv valt terug op supabase/config.toml", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-bundel-"));
  mkdirSync(join(root, "supabase"));
  writeFileSync(
    join(root, "supabase", "config.toml"),
    `project_id = "abc123"\n`,
  );
  assertEquals(leesEnv(root).VITE_SUPABASE_PROJECT_ID, "abc123");
  writeFileSync(
    join(root, ".env"),
    `VITE_SUPABASE_PROJECT_ID="uitenv"\nANDERS=1\n`,
  );
  const env = leesEnv(root);
  assertEquals(env.VITE_SUPABASE_PROJECT_ID, "uitenv");
  assertEquals(env.ANDERS, undefined);
});

Deno.test("controleerMcpBundel: repo zonder src/lib/mcp is in orde, ontbrekende bundel niet", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-bundel-"));
  assertEquals(await controleerMcpBundel(root), { inOrde: true, fouten: [] });
  mkdirSync(join(root, "src", "lib", "mcp"), { recursive: true });
  const r = await controleerMcpBundel(root);
  assertEquals(r.inOrde, false);
  assertMatch(r.fouten[0], /ontbreekt/);
});
