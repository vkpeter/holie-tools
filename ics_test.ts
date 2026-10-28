import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  bouwIcs,
  escapeIcsTekst,
  ICS_CONTENT_TYPE,
  type IcsEvent,
  type IcsKalender,
  vouwIcsRegel,
  VTIMEZONE_BRUSSEL,
} from "./ics.ts";

const NU = new Date("2026-10-28T10:15:30.123Z");

// Verzonnen waarden: geen echte personen of feeds in dit pakket.
function event(extra: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: "abc-1@voorbeeld.test",
    begin: { datum: "2026-11-03" },
    titel: "Voorbeeld",
    ...extra,
  };
}

function kalender(
  events: IcsEvent[],
  extra: Partial<IcsKalender> = {},
): IcsKalender {
  return { prodId: "-//Voorbeeld//Test//NL", events, ...extra };
}

function bouw(e: Partial<IcsEvent>, k: Partial<IcsKalender> = {}): string {
  return bouwIcs(kalender([event(e)], k), { nu: NU });
}

function regels(ics: string): string[] {
  return ics.split("\r\n");
}

// Ontvouwt zoals een lezer: CRLF + spatie verdwijnt.
function ontvouw(ics: string): string {
  return ics.replace(/\r\n /g, "");
}

Deno.test("header, VTIMEZONE en enkel CRLF", () => {
  const ics = bouwIcs(
    kalender([], { naam: "Afspraken", verversen: "PT1H" }),
    { nu: NU },
  );
  assert(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert(ics.endsWith("END:VCALENDAR\r\n"));
  const r = regels(ics);
  for (
    const verwacht of [
      "VERSION:2.0",
      "PRODID:-//Voorbeeld//Test//NL",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Afspraken",
      "X-WR-TIMEZONE:Europe/Brussels",
      "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
      "X-PUBLISHED-TTL:PT1H",
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Brussels",
      "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
      "END:VTIMEZONE",
    ]
  ) {
    assert(r.includes(verwacht), `ontbreekt: ${verwacht}`);
  }
  // Geen losse \n zonder \r ervoor.
  assertFalse(/(^|[^\r])\n/.test(ics));
  assertEquals(ICS_CONTENT_TYPE, "text/calendar; charset=utf-8");
  assertEquals(VTIMEZONE_BRUSSEL.length, 17);
});

Deno.test("zonder naam en verversen geen X-WR-CALNAME of REFRESH-INTERVAL", () => {
  const ics = bouwIcs(kalender([]), { nu: NU });
  assertFalse(ics.includes("X-WR-CALNAME"));
  assertFalse(ics.includes("REFRESH-INTERVAL"));
  assertFalse(ics.includes("X-PUBLISHED-TTL"));
  assertFalse(ics.includes("BEGIN:VEVENT"));
});

Deno.test("vouwen op 75 octetten met multibyte-tekens, nooit doormidden", () => {
  const lang = "Kapsalon Élégance ".repeat(6) +
    "😀😀😀 café ünïcode ".repeat(5);
  const ics = bouw({ titel: lang });
  const enc = new TextEncoder();
  for (const r of regels(ics)) {
    assert(
      enc.encode(r).length <= 75,
      `te lang (${enc.encode(r).length}): ${r}`,
    );
  }
  assert(ics.includes("\r\n "), "er moet gevouwen zijn");
  // Ontvouwen geeft het origineel terug en bevat geen vervangingsteken.
  assert(ontvouw(ics).split("\r\n").includes(`SUMMARY:${lang}`));
  assertFalse(ics.includes("�"));
});

Deno.test("vouwIcsRegel: korte regel blijft, exacte grens en vervolgregels", () => {
  assertEquals(vouwIcsRegel("kort"), "kort");
  const exact = "A".repeat(75);
  assertEquals(vouwIcsRegel(exact), exact);
  const een = vouwIcsRegel("A".repeat(76));
  assertEquals(een, `${"A".repeat(75)}\r\n A`);
  // Een emoji (4 bytes) die niet meer op de eerste regel past, gaat heel naar de volgende.
  const emoji = vouwIcsRegel("A".repeat(73) + "😀");
  assertEquals(emoji, `${"A".repeat(73)}\r\n 😀`);
  // Vervolgregels tellen de spatie mee: 74 tekens inhoud.
  const drie = vouwIcsRegel("B".repeat(75 + 74 + 5)).split("\r\n");
  assertEquals(drie.map((r) => r.length), [75, 75, 6]);
  assertEquals(drie.join("").replace(/ /g, ""), "B".repeat(75 + 74 + 5));
});

Deno.test("escaping: backslash eerst, dan ; , en regeleinden", () => {
  assertEquals(escapeIcsTekst("A, B; C\\D"), "A\\, B\\; C\\\\D");
  assertEquals(
    escapeIcsTekst("een\r\ntwee\rdrie\nvier"),
    "een\\ntwee\\ndrie\\nvier",
  );
  // Een backslash die al voor een n staat, wordt niet een regeleinde.
  assertEquals(escapeIcsTekst("a\\nb"), "a\\\\nb");
  // Tab blijft, andere controletekens verdwijnen.
  assertEquals(escapeIcsTekst("a\tb\u0000c\u007f"), "a\tbc");
  const ics = bouw({ titel: "A, B; C\\D" }, { naam: "Mijn; kalender, nu" });
  assert(ics.includes("SUMMARY:A\\, B\\; C\\\\D\r\n"));
  assert(ics.includes("X-WR-CALNAME:Mijn\\; kalender\\, nu\r\n"));
});

Deno.test("hele dag: DTEND is de volgende dag, ook bij jaarwissel", () => {
  const r = regels(bouw({ begin: { datum: "2026-12-31" } }));
  assert(r.includes("DTSTART;VALUE=DATE:20261231"));
  assert(r.includes("DTEND;VALUE=DATE:20270101"));
  assert(r.includes("TRANSP:TRANSPARENT"));
  assertFalse(r.some((x) => x.startsWith("DURATION")));
});

Deno.test("hele dag: maandwissel en schrikkeljaar", () => {
  assert(
    regels(bouw({ begin: { datum: "2026-01-31" } })).includes(
      "DTEND;VALUE=DATE:20260201",
    ),
  );
  // 2028 is een schrikkeljaar: 28 feb -> 29 feb -> 1 maart.
  assert(
    regels(bouw({ begin: { datum: "2028-02-28" } })).includes(
      "DTEND;VALUE=DATE:20280229",
    ),
  );
  assert(
    regels(bouw({ begin: { datum: "2028-02-29" } })).includes(
      "DTEND;VALUE=DATE:20280301",
    ),
  );
  // 2026 niet: 28 feb -> 1 maart.
  assert(
    regels(bouw({ begin: { datum: "2026-02-28" } })).includes(
      "DTEND;VALUE=DATE:20260301",
    ),
  );
});

Deno.test("getimed: DTSTART met TZID, HH:MM en HH:MM:SS, geen DTEND zonder einde", () => {
  const r = regels(bouw({ begin: { datum: "2026-11-03", tijd: "09:30" } }));
  assert(r.includes("DTSTART;TZID=Europe/Brussels:20261103T093000"));
  assert(r.includes("TRANSP:OPAQUE"));
  assertFalse(r.some((x) => x.startsWith("DTEND") || x.startsWith("DURATION")));
  const s = regels(bouw({ begin: { datum: "2026-11-03", tijd: "09:30:15" } }));
  assert(s.includes("DTSTART;TZID=Europe/Brussels:20261103T093015"));
});

Deno.test("Date wordt een UTC-moment met Z, ook voor einde", () => {
  const r = regels(
    bouw({
      begin: new Date("2026-11-03T08:30:00.789Z"),
      einde: new Date("2026-11-03T10:00:00Z"),
    }),
  );
  assert(r.includes("DTSTART:20261103T083000Z"));
  assert(r.includes("DTEND:20261103T100000Z"));
  assert(r.includes("TRANSP:OPAQUE"));
});

Deno.test("duur: DURATION in plaats van DTEND", () => {
  const r = regels(
    bouw({ begin: { datum: "2026-11-03", tijd: "09:30" }, duur: "PT1H30M" }),
  );
  assert(r.includes("DURATION:PT1H30M"));
  assertFalse(r.some((x) => x.startsWith("DTEND")));
  // Hele dag met duur in dagen: geen automatische DTEND.
  const h = regels(bouw({ duur: "P2D" }));
  assert(h.includes("DURATION:P2D"));
  assertFalse(h.some((x) => x.startsWith("DTEND")));
});

Deno.test("einde: hele dag en lokale tijd", () => {
  const h = regels(
    bouw({ begin: { datum: "2026-11-03" }, einde: { datum: "2026-11-06" } }),
  );
  assert(h.includes("DTEND;VALUE=DATE:20261106"));
  const t = regels(
    bouw({
      begin: { datum: "2026-11-03", tijd: "09:00" },
      einde: { datum: "2026-11-03", tijd: "17:45" },
    }),
  );
  assert(t.includes("DTEND;TZID=Europe/Brussels:20261103T174500"));
});

Deno.test("status en bezet, met de juiste standaardwaarden", () => {
  const r = regels(bouw({ status: "CANCELLED", bezet: true }));
  assert(r.includes("STATUS:CANCELLED"));
  assert(r.includes("TRANSP:OPAQUE")); // hele dag, maar uitdrukkelijk bezet
  const t = regels(
    bouw({ begin: { datum: "2026-11-03", tijd: "09:00" }, bezet: false }),
  );
  assert(t.includes("TRANSP:TRANSPARENT"));
  // Zonder status geen STATUS-regel.
  assertFalse(bouw({}).includes("STATUS:"));
});

Deno.test("volgorde van de eigenschappen en optionele velden", () => {
  const ics = bouw({
    begin: { datum: "2026-11-03", tijd: "09:30" },
    duur: "PT1H",
    status: "CONFIRMED",
    locatie: "Lier, Antwerpen",
    beschrijving: "regel een\nregel twee",
    url: "https://voorbeeld.test/a?b=1&c=2",
    gewijzigd: "2026-10-27T08:00:00.000Z",
  });
  const namen = regels(ontvouw(ics)).map((r) => r.split(/[:;]/)[0]);
  const vanaf = namen.indexOf("UID") - 1; // de BEGIN:VEVENT vlak voor de UID
  assertEquals(namen.slice(vanaf, vanaf + 14), [
    "BEGIN",
    "UID",
    "DTSTAMP",
    "LAST-MODIFIED",
    "DTSTART",
    "DURATION",
    "TRANSP",
    "STATUS",
    "SUMMARY",
    "LOCATION",
    "DESCRIPTION",
    "URL",
    "END",
    "END",
  ]);
  const r = regels(ontvouw(ics));
  assert(r.includes("LOCATION:Lier\\, Antwerpen"));
  assert(r.includes("DESCRIPTION:regel een\\nregel twee"));
  // De URL wordt niet TEXT-geescapet.
  assert(r.includes("URL:https://voorbeeld.test/a?b=1&c=2"));
  assert(r.includes("DTSTAMP:20261028T101530Z"));
  assert(r.includes("LAST-MODIFIED:20261027T080000Z"));
});

Deno.test("gewijzigd: Date werkt, ongeldige waarde laat de regel weg", () => {
  assert(
    bouw({ gewijzigd: new Date("2026-10-27T08:00:00Z") }).includes(
      "LAST-MODIFIED:20261027T080000Z",
    ),
  );
  const ics = bouw({ gewijzigd: "geen datum" });
  assertFalse(ics.includes("LAST-MODIFIED"));
  assert(ics.includes("BEGIN:VEVENT"));
  assertFalse(bouw({ gewijzigd: new Date(NaN) }).includes("LAST-MODIFIED"));
});

Deno.test("ongeldige events worden standaard overgeslagen, de rest blijft", () => {
  const ongeldig: IcsEvent[] = [
    event({ uid: "a", begin: { datum: "2026-02-30" } }),
    event({ uid: "b", begin: { datum: "03/11/2026" } }),
    event({ uid: "c", begin: { datum: "2026-11-03", tijd: "24:00" } }),
    event({ uid: "d", begin: { datum: "2026-11-03", tijd: "9:30" } }),
    event({ uid: "e", begin: { datum: "2026-11-03", tijd: "10:60" } }),
    event({ uid: "f", duur: "PT1H", einde: { datum: "2026-11-05" } }),
    event({ uid: "g", url: "https://voorbeeld.test/\r\nX-EVIL:1" }),
    event({ uid: "" }),
    event({ uid: "  " }),
    event({ uid: "h", duur: "1 uur" }),
    event({ uid: "i", duur: "P" }),
    event({ uid: "j", duur: "PT1H" }), // hele dag met uren
    event({ uid: "k", status: "MAYBE" as IcsEvent["status"] }),
    event({ uid: "l", begin: new Date(NaN) }),
    event({ uid: "m", einde: { datum: "2026-11-03" } }), // niet na begin
    event({
      uid: "n",
      begin: { datum: "2026-11-03", tijd: "09:00" },
      einde: { datum: "2026-11-03" },
    }), // soorten door elkaar
  ];
  const ics = bouwIcs(
    kalender([...ongeldig, event({ uid: "ok" })]),
    { nu: NU },
  );
  assertEquals(ics.split("BEGIN:VEVENT").length - 1, 1);
  assert(ics.includes("UID:ok\r\n"));
  assertFalse(ics.includes("X-EVIL"));
});

Deno.test('opOngeldig: "gooi" geeft een TypeError met een duidelijke reden', () => {
  const gooi = (e: IcsEvent) =>
    bouwIcs(kalender([e]), { nu: NU, opOngeldig: "gooi" });
  const fout = assertThrows(
    () => gooi(event({ uid: "x1", begin: { datum: "2026-02-30" } })),
    TypeError,
    'event "x1"',
  );
  assert(fout.message.includes("bestaat niet"));
  assertThrows(
    () => gooi(event({ begin: { datum: "2026-11-03", tijd: "24:00" } })),
    TypeError,
    "tijd",
  );
  assertThrows(
    () => gooi(event({ duur: "PT1H", einde: { datum: "2026-11-05" } })),
    TypeError,
    "duur en einde",
  );
  assertThrows(
    () => gooi(event({ url: "https://voorbeeld.test/\nX-EVIL:1" })),
    TypeError,
    "url",
  );
  assertThrows(() => gooi(event({ uid: "" })), TypeError, "uid");
  // Een geldig event gooit niet.
  assert(gooi(event()).includes("BEGIN:VEVENT"));
});

Deno.test("fouten op kalenderniveau gooien altijd", () => {
  assertThrows(
    () => bouwIcs(kalender([], { prodId: "" })),
    TypeError,
    "prodId",
  );
  assertThrows(
    () => bouwIcs(kalender([], { prodId: "\r\n" })),
    TypeError,
    "prodId",
  );
  assertThrows(
    () => bouwIcs(kalender([], { verversen: "elk uur" })),
    TypeError,
    "verversen",
  );
  assertThrows(
    () => bouwIcs(kalender([]), { nu: new Date(NaN) }),
    TypeError,
    "nu",
  );
});

Deno.test("injectie via prodId, uid, naam, titel of tzid wordt nooit een eigen regel", () => {
  const boos = "x\r\nX-EVIL:1";
  const ics = bouwIcs(
    kalender([
      event({
        uid: boos,
        titel: boos,
        locatie: boos,
        beschrijving: boos,
      }),
    ], {
      prodId: boos,
      naam: boos,
      tijdzone: {
        tzid: boos,
        definitie: ["BEGIN:VTIMEZONE", `TZID:${boos}`, "END:VTIMEZONE", boos],
      },
    }),
    { nu: NU },
  );
  for (const r of regels(ics)) {
    assertFalse(r.startsWith("X-EVIL"), `ingespoten regel: ${r}`);
    assertFalse(r.startsWith(" X-EVIL"));
  }
  assertFalse(ics.includes("\r\nX-EVIL"));
  const r = regels(ics);
  assert(r.includes("PRODID:xX-EVIL:1"));
  assert(r.includes("UID:xX-EVIL:1"));
  // Titel, naam: regeleinden worden een letterlijke \n binnen dezelfde regel.
  assert(r.includes("SUMMARY:x\\nX-EVIL:1"));
  assert(r.includes("X-WR-CALNAME:x\\nX-EVIL:1"));
});

Deno.test("UID wordt TEXT-geescapet", () => {
  assert(
    bouw({ uid: "a,b;c@voorbeeld.test" }).includes(
      "UID:a\\,b\\;c@voorbeeld.test\r\n",
    ),
  );
});

Deno.test("eigen tijdzone: tzid en definitie komen in de feed, TZID bij lokale tijden", () => {
  const definitie = [
    "BEGIN:VTIMEZONE",
    "TZID:America/New_York",
    "BEGIN:STANDARD",
    "DTSTART:19701101T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
    "TZOFFSETFROM:-0400",
    "TZOFFSETTO:-0500",
    "TZNAME:EST",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
  const ics = bouw(
    {
      begin: { datum: "2026-11-03", tijd: "09:30" },
      einde: { datum: "2026-11-03", tijd: "10:30" },
    },
    { tijdzone: { tzid: "America/New_York", definitie } },
  );
  const r = regels(ics);
  assert(r.includes("X-WR-TIMEZONE:America/New_York"));
  assert(r.includes("DTSTART;TZID=America/New_York:20261103T093000"));
  assert(r.includes("DTEND;TZID=America/New_York:20261103T103000"));
  assert(r.includes("TZNAME:EST"));
  // De Brusselse definitie zit er dan niet bij.
  assertFalse(ics.includes("Europe/Brussels"));
  assertFalse(ics.includes("CEST"));
});

Deno.test("tzid zonder tekens die een parameter breken", () => {
  const ics = bouw(
    { begin: { datum: "2026-11-03", tijd: "09:30" } },
    { tijdzone: { tzid: 'Aa;"b:c,d', definitie: [] } },
  );
  assert(ics.includes("DTSTART;TZID=Aabcd:20261103T093000"));
  assertThrows(
    () => bouwIcs(kalender([], { tijdzone: { tzid: "\r\n", definitie: [] } })),
    TypeError,
    "tzid",
  );
});

Deno.test("de uitvoer is deterministisch voor dezelfde invoer en nu", () => {
  const k = kalender([event(), event({ uid: "twee" })]);
  assertEquals(bouwIcs(k, { nu: NU }), bouwIcs(k, { nu: NU }));
  // Zonder nu gebruikt hij de klok: DTSTAMP is een geldig UTC-moment.
  assert(/DTSTAMP:\d{8}T\d{6}Z/.test(bouwIcs(k)));
});

// Byte-gelijkheid met roundbook-ics.ts (Billara, supabase/functions/_shared). De
// verwachte tekst is eenmalig uit dat bestand gehaald (28 okt 2026): zelfde afspraak,
// zelfde `nu`. Roundbook moet na de overstap naar dit pakket dezelfde bytes geven.
const ROUNDBOOK_KOP = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Roundbook//Afspraken//NL",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:Afspraken",
  "X-WR-TIMEZONE:Europe/Brussels",
  "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  "X-PUBLISHED-TTL:PT1H",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Brussels",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

const ROUNDBOOK_KALENDER: Partial<IcsKalender> = {
  prodId: "-//Roundbook//Afspraken//NL",
  naam: "Afspraken",
  verversen: "PT1H",
};

Deno.test("byte-gelijk aan Roundbook: hele dag, bevestigd", () => {
  const verwacht = [
    ...ROUNDBOOK_KOP,
    "BEGIN:VEVENT",
    "UID:11111111-2222-3333-4444-555555555555@roundbook.eu",
    "DTSTAMP:20261028T101530Z",
    "LAST-MODIFIED:20261027T080000Z",
    "DTSTART;VALUE=DATE:20261103",
    "DTEND;VALUE=DATE:20261104",
    "TRANSP:TRANSPARENT",
    "STATUS:CONFIRMED",
    "SUMMARY:Voormiddag: Salon X (Lier)",
    "LOCATION:Lier",
    "DESCRIPTION:Dagdeel: voormiddag\\nStatus: bevestigd\\nUit Roundbook",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const ics = bouwIcs(
    kalender([{
      uid: "11111111-2222-3333-4444-555555555555@roundbook.eu",
      begin: { datum: "2026-11-03" },
      titel: "Voormiddag: Salon X (Lier)",
      locatie: "Lier",
      beschrijving: "Dagdeel: voormiddag\nStatus: bevestigd\nUit Roundbook",
      status: "CONFIRMED",
      gewijzigd: "2026-10-27T08:00:00.000Z",
    }], ROUNDBOOK_KALENDER),
    { nu: NU },
  );
  assertEquals(ics, verwacht);
});

Deno.test("byte-gelijk aan Roundbook: uur 09:30, duur PT1H, te bevestigen", () => {
  const verwacht = [
    ...ROUNDBOOK_KOP,
    "BEGIN:VEVENT",
    "UID:11111111-2222-3333-4444-555555555555@roundbook.eu",
    "DTSTAMP:20261028T101530Z",
    "LAST-MODIFIED:20261027T080000Z",
    "DTSTART;TZID=Europe/Brussels:20261103T093000",
    "DURATION:PT1H",
    "TRANSP:OPAQUE",
    "STATUS:TENTATIVE",
    "SUMMARY:Te bevestigen: Salon X (Lier)",
    "LOCATION:Lier",
    // Gevouwen op 75 octetten, zoals roundbook-ics.ts het doet.
    "DESCRIPTION:Dagdeel: voormiddag\\nUur: 09:30\\nStatus: te bevestigen\\nUit Rou",
    " ndbook",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const ics = bouwIcs(
    kalender([{
      uid: "11111111-2222-3333-4444-555555555555@roundbook.eu",
      begin: { datum: "2026-11-03", tijd: "09:30" },
      duur: "PT1H",
      titel: "Te bevestigen: Salon X (Lier)",
      locatie: "Lier",
      beschrijving:
        "Dagdeel: voormiddag\nUur: 09:30\nStatus: te bevestigen\nUit Roundbook",
      status: "TENTATIVE",
      gewijzigd: "2026-10-27T08:00:00.000Z",
    }], ROUNDBOOK_KALENDER),
    { nu: NU },
  );
  assertEquals(ics, verwacht);
});
