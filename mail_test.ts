import { assert, assertEquals } from "@std/assert";
import { MAIL_MAX_ONTVANGERS, sendMail } from "./mail.ts";

// Verzonnen waarden: nooit een echte sleutel of echt adres in dit pakket.
const SLEUTEL = "re_TEST_sleutel_niet_echt";
const basis = {
  apiKey: SLEUTEL,
  from: "Test <noreply@example.com>",
  to: "klant@example.com",
  subject: "Bevestiging",
  html: "<p>Dag</p>",
};

type Aanroep = {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
};

function metAntwoord(
  antwoord: { status?: number; body?: string; gooi?: Error },
) {
  const aanroepen: Aanroep[] = [];
  const origineel = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    aanroepen.push({
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)),
    });
    if (antwoord.gooi) return Promise.reject(antwoord.gooi);
    return Promise.resolve(
      new Response(antwoord.body ?? '{"id":"mail-1"}', {
        status: antwoord.status ?? 200,
      }),
    );
  }) as typeof fetch;
  return { aanroepen, herstel: () => (globalThis.fetch = origineel) };
}

Deno.test("verstuurt via Resend met de juiste body en headers", async () => {
  const m = metAntwoord({});
  try {
    const r = await sendMail({
      ...basis,
      text: "Dag",
      cc: ["a@example.com", " "],
      bcc: "b@example.com",
      replyTo: "antwoord@example.com",
      idempotencyKey: "bestelling-1/bevestiging",
    });
    assertEquals(r, { ok: true, status: 200, id: "mail-1" });
    const a = m.aanroepen[0];
    assertEquals(a.url, "https://api.resend.com/emails");
    assertEquals(a.headers.get("Authorization"), `Bearer ${SLEUTEL}`);
    assertEquals(a.headers.get("Idempotency-Key"), "bestelling-1/bevestiging");
    assertEquals(a.body, {
      from: basis.from,
      to: ["klant@example.com"],
      subject: "Bevestiging",
      html: "<p>Dag</p>",
      text: "Dag",
      cc: ["a@example.com"],
      bcc: ["b@example.com"],
      reply_to: "antwoord@example.com",
    });
  } finally {
    m.herstel();
  }
});

Deno.test("laat lege optionele velden en headers weg", async () => {
  const m = metAntwoord({});
  try {
    await sendMail({ ...basis, to: ["x@example.com", "y@example.com"] });
    const a = m.aanroepen[0];
    assertEquals(Object.keys(a.body).sort(), ["from", "html", "subject", "to"]);
    assertEquals(a.body.to, ["x@example.com", "y@example.com"]);
    assertEquals(a.headers.get("Idempotency-Key"), null);
  } finally {
    m.herstel();
  }
});

Deno.test("meerdere reply-to-adressen gaan als rij mee", async () => {
  const m = metAntwoord({});
  try {
    await sendMail({ ...basis, replyTo: ["a@example.com", "b@example.com"] });
    assertEquals(m.aanroepen[0].body.reply_to, [
      "a@example.com",
      "b@example.com",
    ]);
  } finally {
    m.herstel();
  }
});

Deno.test("ongeldige invoer: geen verzoek, wel een reden", async () => {
  const m = metAntwoord({});
  try {
    const gevallen: [Partial<typeof basis> | { to: string[] }, string][] = [
      [{ apiKey: " " }, "geen Resend-sleutel"],
      [{ from: "" }, "geen afzender (from)"],
      [{ to: "" }, "geen ontvanger (to)"],
      [{ subject: "  " }, "geen onderwerp"],
      [
        {
          to: Array.from(
            { length: MAIL_MAX_ONTVANGERS + 1 },
            (_, i) => `${i}@x.be`,
          ),
        },
        `meer dan ${MAIL_MAX_ONTVANGERS} ontvangers in to`,
      ],
    ];
    for (const [over, fout] of gevallen) {
      assertEquals(await sendMail({ ...basis, ...over }), {
        ok: false,
        status: 0,
        fout,
      });
    }
    assertEquals(m.aanroepen.length, 0);
  } finally {
    m.herstel();
  }
});

Deno.test("foutantwoord van Resend: status en melding, zonder sleutel", async () => {
  const m = metAntwoord({
    status: 403,
    body: JSON.stringify({
      statusCode: 403,
      name: "validation_error",
      message: `The domain is not verified for key ${SLEUTEL}`,
    }),
  });
  try {
    const r = await sendMail(basis);
    assertEquals(r.ok, false);
    assertEquals(r.status, 403);
    assertEquals(
      r.fout,
      "Resend 403: validation_error: The domain is not verified for key <sleutel>",
    );
    assert(!JSON.stringify(r).includes(SLEUTEL));
  } finally {
    m.herstel();
  }
});

Deno.test("foutantwoord zonder JSON wordt ingekort", async () => {
  const m = metAntwoord({ status: 502, body: "x".repeat(1000) });
  try {
    const r = await sendMail(basis);
    assertEquals(r.status, 502);
    assert(r.fout!.startsWith("Resend 502: xxx"));
    assert(r.fout!.length < 320);
  } finally {
    m.herstel();
  }
});

Deno.test("netwerkfout: status 0 en geen sleutel in de melding", async () => {
  const m = metAntwoord({
    gooi: new TypeError(`connection refused (Bearer ${SLEUTEL})`),
  });
  try {
    const r = await sendMail(basis);
    assertEquals(r, {
      ok: false,
      status: 0,
      fout: "Resend onbereikbaar: connection refused (Bearer <sleutel>)",
    });
  } finally {
    m.herstel();
  }
});

Deno.test("timeout geeft een eigen melding", async () => {
  const m = metAntwoord({
    gooi: new DOMException("signal timed out", "TimeoutError"),
  });
  try {
    const r = await sendMail({ ...basis, timeoutMs: 5 });
    assertEquals(r.fout, "Resend antwoordde niet op tijd");
    assertEquals(r.status, 0);
  } finally {
    m.herstel();
  }
});

Deno.test("2xx zonder JSON telt als verstuurd zonder id", async () => {
  const m = metAntwoord({ status: 200, body: "" });
  try {
    assertEquals(await sendMail(basis), {
      ok: true,
      status: 200,
      id: undefined,
    });
  } finally {
    m.herstel();
  }
});

Deno.test("apiBasis voor tests", async () => {
  const m = metAntwoord({});
  try {
    await sendMail({ ...basis, apiBasis: "http://localhost:9" });
    assertEquals(m.aanroepen[0].url, "http://localhost:9/emails");
  } finally {
    m.herstel();
  }
});
