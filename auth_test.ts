import { assertEquals } from "@std/assert";
import {
  bearerToken,
  controleerCronGeheim,
  controleerCronGeheimViaDb,
  type EnvLezer,
  geheimenGelijk,
  isMachineSleutel,
  type RpcClient,
} from "./auth.ts";

const envVan = (waarden: Record<string, string>): EnvLezer => (naam) =>
  waarden[naam];

const verzoek = (koppen: Record<string, string>) =>
  new Request("https://x.test", { headers: koppen });

Deno.test("geheimenGelijk: gelijk, ongelijk, andere lengte, multibyte", () => {
  assertEquals(geheimenGelijk("abc", "abc"), true);
  assertEquals(geheimenGelijk("abc", "abd"), false);
  assertEquals(geheimenGelijk("abc", "abcd"), false);
  // Zelfde aantal UTF-16-eenheden, ander aantal bytes.
  assertEquals(geheimenGelijk("é", "e"), false);
  assertEquals(geheimenGelijk("", ""), true);
});

Deno.test("bearerToken leest enkel een echt Bearer-token", () => {
  assertEquals(bearerToken(verzoek({ Authorization: "Bearer  t1 " })), "t1");
  assertEquals(bearerToken(verzoek({ Authorization: "Basic t1" })), null);
  assertEquals(bearerToken(verzoek({ Authorization: "Bearer " })), null);
  assertEquals(bearerToken(verzoek({})), null);
});

Deno.test("isMachineSleutel: legacy-sleutel", () => {
  const env = envVan({ SUPABASE_SERVICE_ROLE_KEY: " legacy-jwt " });
  assertEquals(isMachineSleutel("legacy-jwt", env), true);
  assertEquals(isMachineSleutel("iets-anders", env), false);
});

Deno.test("isMachineSleutel: nieuwe sb_secret-sleutels, ook bij rotatie", () => {
  const env = envVan({
    SUPABASE_SERVICE_ROLE_KEY: "legacy-jwt",
    SUPABASE_SECRET_KEYS: JSON.stringify({
      default: "sb_secret_oud",
      nieuw: "sb_secret_nieuw",
    }),
  });
  assertEquals(isMachineSleutel("sb_secret_nieuw", env), true);
  assertEquals(isMachineSleutel("sb_secret_oud", env), true);
  assertEquals(isMachineSleutel("sb_secret_fout", env), false);
});

Deno.test("isMachineSleutel: fail-closed bij lege env, lege token of foute JSON", () => {
  assertEquals(isMachineSleutel("x", envVan({})), false);
  assertEquals(
    isMachineSleutel("", envVan({ SUPABASE_SECRET_KEYS: '{"a":""}' })),
    false,
  );
  assertEquals(
    isMachineSleutel("x", envVan({ SUPABASE_SECRET_KEYS: "{kapot" })),
    false,
  );
  assertEquals(
    isMachineSleutel("x", envVan({ SUPABASE_SECRET_KEYS: '["x"]' })),
    true, // een array is ook een object met waarden; x staat erin
  );
  assertEquals(
    isMachineSleutel("x", envVan({ SUPABASE_SECRET_KEYS: "null" })),
    false,
  );
});

Deno.test("controleerCronGeheim: env-var, fail-closed", () => {
  const env = envVan({ CRON_SECRET: "geheim" });
  assertEquals(
    controleerCronGeheim(verzoek({ "x-cron-secret": "geheim" }), { env }),
    true,
  );
  assertEquals(
    controleerCronGeheim(verzoek({ "x-cron-secret": "fout" }), { env }),
    false,
  );
  assertEquals(controleerCronGeheim(verzoek({}), { env }), false);
  // Geen CRON_SECRET gezet: altijd nee, ook met een lege header.
  assertEquals(
    controleerCronGeheim(verzoek({ "x-cron-secret": "" }), { env: envVan({}) }),
    false,
  );
  assertEquals(
    controleerCronGeheim(verzoek({ "x-intern": "geheim" }), {
      env: envVan({ INTERN: "geheim" }),
      envNaam: "INTERN",
      header: "x-intern",
    }),
    true,
  );
});

Deno.test("controleerCronGeheimViaDb: enkel data === true telt", async () => {
  const db = (antwoord: { data: unknown; error: unknown }) => {
    const aanroepen: unknown[] = [];
    const client: RpcClient = {
      rpc: (fn, args) => {
        aanroepen.push([fn, args]);
        return Promise.resolve(antwoord);
      },
    };
    return { client, aanroepen };
  };

  const goed = db({ data: true, error: null });
  assertEquals(
    await controleerCronGeheimViaDb(
      verzoek({ "x-cron-secret": "k" }),
      goed.client,
    ),
    true,
  );
  assertEquals(goed.aanroepen, [["verify_cron_secret", { candidate: "k" }]]);

  const leeg = db({ data: true, error: null });
  assertEquals(
    await controleerCronGeheimViaDb(verzoek({}), leeg.client),
    false,
  );
  assertEquals(leeg.aanroepen.length, 0);

  for (
    const antwoord of [
      { data: false, error: null },
      { data: "true", error: null },
      { data: true, error: { message: "boem" } },
    ]
  ) {
    assertEquals(
      await controleerCronGeheimViaDb(
        verzoek({ "x-cron-secret": "k" }),
        db(antwoord).client,
      ),
      false,
    );
  }
});
