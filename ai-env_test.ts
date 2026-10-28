// Sleutels uit de omgeving, buiten Deno. In een Cloudflare Worker (TanStack Start op
// Lovable, ESE) bestaat `Deno` niet en staan de secrets in `process.env`.
import { assertEquals } from "@std/assert";
import { aiSleutels, callAi, heeftAiSleutel, TEKST_PROVIDERS } from "./ai.ts";

type Env = Record<string, string | undefined>;

/** Draait `fn` alsof dit een Worker is: geen `Deno`, wel `process.env`. */
async function alsWorker<T>(env: Env, fn: () => T | Promise<T>): Promise<T> {
  const deno = Object.getOwnPropertyDescriptor(globalThis, "Deno")!;
  const proc = Object.getOwnPropertyDescriptor(globalThis, "process");
  Object.defineProperty(globalThis, "Deno", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "process", {
    value: { env },
    configurable: true,
    writable: true,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(globalThis, "Deno", deno);
    if (proc) Object.defineProperty(globalThis, "process", proc);
    else delete (globalThis as { process?: unknown }).process;
  }
}

/** Zonder `Deno` en zonder `process`: een kale browser of een onbekende runtime. */
async function zonderRuntime<T>(fn: () => T): Promise<T> {
  const proc = Object.getOwnPropertyDescriptor(globalThis, "process");
  return await alsWorker({}, () => {
    delete (globalThis as { process?: unknown }).process;
    try {
      return fn();
    } finally {
      if (proc) Object.defineProperty(globalThis, "process", proc);
    }
  });
}

Deno.test("aiSleutels leest process.env als Deno ontbreekt", async () => {
  const sleutels = await alsWorker({
    GEMINI_API_KEY: "w-gem",
    LOVABLE_API_KEY: "w-lov",
    DEEPSEEK_API_KEY: "",
    ANTHROPIC_API_KEY: "w-ant",
    META_MODEL_API_KEY: "w-meta",
  }, () => aiSleutels());
  // Een lege waarde telt als geen sleutel, net als in de oude shim (`|| undefined`).
  assertEquals(sleutels, {
    gemini: "w-gem",
    lovable: "w-lov",
    anthropic: "w-ant",
    meta: "w-meta",
  });
});

Deno.test("aiSleutels geeft niets zonder Deno en zonder process", async () => {
  assertEquals(await zonderRuntime(() => aiSleutels()), {});
});

Deno.test("aiSleutels leest Deno.env in Deno", () => {
  Deno.env.set("DEEPSEEK_API_KEY", "d-ds");
  try {
    assertEquals(aiSleutels().deepseek, "d-ds");
  } finally {
    Deno.env.delete("DEEPSEEK_API_KEY");
  }
});

Deno.test("heeftAiSleutel kijkt enkel naar de tekstketen", () => {
  assertEquals(heeftAiSleutel({}), false);
  // Alleen een beeldsleutel volstaat niet voor tekst, zoals in de oude shim.
  assertEquals(heeftAiSleutel({ meta: "m" }), false);
  assertEquals(heeftAiSleutel({ anthropic: "a" }), true);
  assertEquals(heeftAiSleutel({ meta: "m" }, ["meta"]), true);
  assertEquals(TEKST_PROVIDERS, ["anthropic", "deepseek", "gemini", "lovable"]);
});

Deno.test("heeftAiSleutel leest zonder argument de omgeving", async () => {
  assertEquals(
    await alsWorker({ LOVABLE_API_KEY: "w" }, () => heeftAiSleutel()),
    true,
  );
  assertEquals(await alsWorker({}, () => heeftAiSleutel()), false);
});

Deno.test("callAi vindt in een Worker zelf de sleutel in process.env", async () => {
  const origineel = globalThis.fetch;
  const gezien: { url: string; auth: string | null }[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    gezien.push({
      url,
      auth: new Headers(init.headers).get("Authorization"),
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      ),
    );
  }) as typeof fetch;
  try {
    const r = await alsWorker(
      { LOVABLE_API_KEY: "w-lov" },
      () =>
        callAi([{ role: "user", content: "hoi" }], {
          label: "t",
          volgorde: ["deepseek", "lovable"],
        }),
    );
    assertEquals(r.provider, "lovable");
    assertEquals(gezien.length, 1);
    assertEquals(gezien[0].auth, "Bearer w-lov");
  } finally {
    globalThis.fetch = origineel;
  }
});

Deno.test("een meegegeven sleutel wint van process.env", async () => {
  const origineel = globalThis.fetch;
  let auth: string | null = null;
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    auth = new Headers(init.headers).get("Authorization");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      ),
    );
  }) as typeof fetch;
  try {
    await alsWorker(
      { LOVABLE_API_KEY: "uit-env" },
      () =>
        callAi([{ role: "user", content: "hoi" }], {
          label: "t",
          volgorde: ["lovable"],
          sleutels: { lovable: "meegegeven" },
        }),
    );
    assertEquals(auth, "Bearer meegegeven");
  } finally {
    globalThis.fetch = origineel;
  }
});
