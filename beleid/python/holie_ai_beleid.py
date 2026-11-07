"""Het centrale AI-beleid voor Python-code (Domus, vacatures, scripts op de VPS of de Pi).

Python-tegenhanger van `beleid.ts` + het ophalen in `ai.ts` van @holie/tools (sinds 0.23.0).
Eén bestand, enkel de standaardbibliotheek: kopieer het naast je code (de bron staat in
holie-tools/beleid/python/; een toets daar vergelijkt de uitkomst met de TypeScript-versie).

    from holie_ai_beleid import kies_providers, huidig_beleid

    beleid = huidig_beleid()                     # ondertekend, met cache op schijf
    uitslag = kies_providers(beleid, type="tekst", project="domus",
                             volgorde=["anthropic", "deepseek"],
                             heeft_sleutel=lambda p: bool(os.environ.get(SLEUTELS[p])))
    for provider in uitslag["volgorde"]: ...

Rangorde: uitsluiting > projectverbod > witte lijst > voorrang > basis. Geen toelating is
uitgesloten. Lukt ophalen niet: de laatste geldige kopie op schijf (max 24 u), daarna het
strenge noodbeleid (persoon/gezondheid enkel naar Claude).

Ophalen: `https://beleid.holie.be/ai-beleid.json`, timeout standaard 2 s (een batchjob mag
wat langer wachten dan een edge function), Ed25519-handtekening gecontroleerd in puur Python.
Een ouder volgnummer dan de kopie op schijf wint nooit.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

BELEID_URL = "https://beleid.holie.be/ai-beleid.json"
BELEID_PUBLIEKE_SLEUTEL = "Z9tJme2ghnbvQNMQzO5IUM6Ivo20uBqTCa9TWAzOW7o="
PAKKET_VERSIE = "py-1.1.0"
VERS_S = 5 * 60
MAX_S = 24 * 60 * 60


class BeleidLeeg(Exception):
    """Geen provider over na het beleid. `stap` zegt welke stap de lijst leegmaakte."""

    def __init__(self, stap: str, stappen: list[dict], vraag: str):
        laatste = stappen[-1] if stappen else {"weg": []}
        redenen = "; ".join(f"{w['provider']}: {w['reden']}" for w in laatste["weg"])
        super().__init__(
            f'AI-beleid laat geen provider over voor {vraag}: stap "{stap}" maakte de lijst leeg'
            + (f" ({redenen})" if redenen else "")
        )
        self.stap = stap
        self.stappen = stappen


# --------------------------------------------------------------------------- keuze

def _tijd(waarde: str | None, einde_van_dag: bool) -> float | None:
    if not waarde:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", waarde):
        waarde = f"{waarde}T{'23:59:59' if einde_van_dag else '00:00:00'}Z"
    try:
        return datetime.fromisoformat(waarde.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def voorrang_actief(v: dict, nu: float | None = None) -> bool:
    t = time.time() if nu is None else nu
    van, tot = _tijd(v.get("van"), False), _tijd(v.get("tot"), True)
    if van is not None and t < van:
        return False
    if tot is not None and t > tot:
        return False
    return True


def geldende_toelating(beleid: dict, provider: str, gegevens: str, project: str | None,
                       nu: float | None = None) -> dict:
    t = time.time() if nu is None else nu
    passend = [x for x in beleid.get("toelatingen", [])
               if x["provider"] == provider and x["gegevens"] == gegevens
               and (not x.get("project") or x.get("project") == project)]
    regel = next((x for x in passend if x.get("project") and x["project"] == project), None) \
        or next((x for x in passend if not x.get("project")), None)
    if not regel:
        return {"status": "uitgesloten", "regel": None, "verlopen": False}
    tot = _tijd(regel.get("geldig_tot"), True)
    if tot is not None and t > tot:
        return {"status": "uitgesloten", "regel": regel, "verlopen": True}
    return {"status": regel["status"], "regel": regel, "verlopen": False}


def _geldt(types: list | None, type_: str) -> bool:
    return not types or type_ in types


def kies_providers(beleid: dict, *, type: str, project: str | None = None,
                   gegevens: str | None = None, context: str | None = None,
                   vast: bool = False, volgorde: Iterable[str] | None = None,
                   toestemming: Iterable[str] | None = None,
                   pakket: Iterable[str] | None = None,
                   heeft_sleutel: Callable[[str], bool] | None = None,
                   tegoed_op: Callable[[str], bool] | None = None,
                   nu: float | None = None) -> dict:
    """Zelfde stappen en uitkomst als `kiesProviders` in beleid.ts. Gooit BeleidLeeg."""
    nu = time.time() if nu is None else nu
    regels = beleid.get("projecten", {}).get(project) if project else None
    waarschuwingen: list[str] = []
    if project and regels is None:
        waarschuwingen.append(f'project "{project}" staat niet in het beleid')
    regels = regels or {}
    if gegevens:
        bron = "aanroep"
    elif regels.get("gegevens"):
        gegevens, bron = regels["gegevens"], "project"
    else:
        gegevens, bron = beleid.get("standaard_gegevens") or "persoon", "standaard"
        waarschuwingen.append(f'geen gegevens-label: "{gegevens}" aangenomen (veilige standaard)')
    context = context or regels.get("context")
    omschrijving = f"{type}/{gegevens}" + (f" in {project}" if project else "") + \
        (f" (context {context})" if context else "")
    providers = beleid.get("providers", {})
    toestemming = list(toestemming or [])
    pakket = list(pakket) if pakket is not None else None

    if volgorde is not None:
        start = list(volgorde)
    elif type in beleid.get("basis", {}):
        start = list(beleid["basis"][type])
    else:
        start = [p for p, i in providers.items() if type in i.get("capaciteiten", [])]
    lijst = list(dict.fromkeys(start))
    stappen: list[dict] = []

    def filter_(stap: str, weg: Callable[[str], str | None]) -> None:
        nonlocal lijst
        verslag = {"stap": stap, "over": [], "weg": []}
        for p in lijst:
            reden = weg(p)
            if reden:
                verslag["weg"].append({"provider": p, "reden": reden})
            else:
                verslag["over"].append(p)
        stappen.append(verslag)
        lijst = verslag["over"]
        if not lijst:
            raise BeleidLeeg(stap, stappen, omschrijving)

    def capaciteit(p: str) -> str | None:
        info = providers.get(p)
        if not info:
            return "onbekend in het beleid"
        if type not in info.get("capaciteiten", []):
            return f"kan geen {type}"
        if pakket is not None and p not in pakket:
            return "niet aanroepbaar via deze functie van @holie/tools"
        return None

    filter_("capaciteit", capaciteit)

    def uit(p: str) -> str | None:
        u = providers.get(p, {}).get("uit")
        return f"uitgezet ({u['reden']}, {u['wie']} {u['datum']})" if u else None

    filter_("uit", uit)

    def uitsluiting(p: str) -> str | None:
        t = geldende_toelating(beleid, p, gegevens, project, nu)
        r = t["regel"]
        if t["status"] == "uitgesloten":
            if t["verlopen"]:
                return f"toelating voor {gegevens} verlopen op {r.get('geldig_tot')}"
            return f"uitgesloten voor {gegevens} ({r['reden']})" if r else \
                f"geen toelating voor {gegevens}"
        if r and r.get("toestemming_vereist") and p not in toestemming:
            return f"voor {gegevens} enkel met toestemming van de gebruiker"
        return None

    filter_("uitsluiting", uitsluiting)

    if context:
        ctx = beleid.get("contexten", {}).get(context)

        def verwerker(p: str) -> str | None:
            if not ctx:
                return f'verwerkerscontext "{context}" bestaat niet in het beleid'
            return None if any(c["provider"] == p for c in ctx["providers"]) else \
                f"niet gemeld in verwerkerscontext {context}"

        filter_("verwerkerscontext", verwerker)

    verboden = [v for v in regels.get("verboden") or [] if _geldt(v.get("types"), type)]
    if verboden:
        def verbod(p: str) -> str | None:
            v = next((x for x in verboden if x["provider"] == p), None)
            return f"verboden in {project} ({v['reden']})" if v else None

        filter_("projectverbod", verbod)

    wit = regels.get("wittelijst")
    if wit and _geldt(wit.get("types"), type):
        binnen = [p for p in lijst if p in wit["providers"]]
        if not binnen and wit["modus"] == "zacht":
            waarschuwingen.append(
                f"witte lijst van {project} ({', '.join(wit['providers'])}) kan geen {type}: "
                "gewone kandidaten")
        else:
            filter_("witte lijst", lambda p: None if p in wit["providers"] else
                    f"niet op de witte lijst van {project} ({wit['modus']})")

    if heeft_sleutel:
        filter_("sleutel", lambda p: None if heeft_sleutel(p) else "geen sleutel in deze omgeving")
    if tegoed_op:
        filter_("tegoed op", lambda p: "tegoed op of geblokkeerd (negatieve cache)"
                if tegoed_op(p) else None)

    vooraan: list[str] = []
    if not vast:
        actief = [v for v in beleid.get("voorrang", [])
                  if voorrang_actief(v, nu) and _geldt(v.get("types"), type)
                  and (not v.get("project") or v.get("project") == project)]
        for v in [v for v in actief if v.get("project")] + [v for v in actief if not v.get("project")]:
            if v["provider"] in lijst and v["provider"] not in vooraan:
                vooraan.append(v["provider"])
    return {
        "volgorde": vooraan + [p for p in lijst if p not in vooraan],
        "type": type, "gegevens": gegevens, "gegevensBron": bron, "context": context,
        "voorrang": vooraan, "stappen": stappen, "waarschuwingen": waarschuwingen,
    }


def _noodbeleid() -> dict:
    b = {"reden": "noodbeleid in holie_ai_beleid: geen geldig beleid", "wie": "pakket",
         "datum": "2026-11-01"}
    providers = {
        "anthropic": {"naam": "Claude (Anthropic)", "capaciteiten": ["tekst", "tools", "beeld-in"]},
        "deepseek": {"naam": "DeepSeek", "capaciteiten": ["tekst", "tools", "beeld-in", "live-spraak"]},
        "gemini": {"naam": "Gemini", "capaciteiten": ["tekst", "tools", "beeld-in", "audio-in"]},
        "lovable": {"naam": "Lovable AI-gateway",
                    "capaciteiten": ["tekst", "tools", "beeld-in", "audio-in", "beeld-uit"]},
        "meta": {"naam": "Meta (Muse Image)", "capaciteiten": ["beeld-uit"]},
    }
    toel = [{**b, "provider": p, "gegevens": g, "status": "testfase"}
            for p in providers for g in ("publiek", "prive-peter")]
    toel += [{**b, "provider": "anthropic", "gegevens": g, "status": "testfase"}
             for g in ("persoon", "gezondheid")]
    chat = ["anthropic", "deepseek", "gemini", "lovable"]
    return {"schema": 1, "volgnummer": 0, "uitgegeven": "2026-11-01T00:00:00Z",
            "providers": providers,
            "basis": {"tekst": chat, "tools": chat, "beeld-in": chat,
                      "audio-in": ["gemini", "lovable"], "beeld-uit": ["meta", "lovable"]},
            "voorrang": [], "toelatingen": toel, "contexten": {}, "projecten": {},
            "standaard_gegevens": "persoon"}


NOODBELEID = _noodbeleid()


# --------------------------------------------------------------------------- Ed25519 (RFC 8032)

_P = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_I = pow(2, (_P - 1) // 4, _P)


def _xherstel(y: int, teken: int) -> int | None:
    if y >= _P:
        return None
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P)
    if x2 == 0:
        return None if teken else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _I % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != teken:
        x = _P - x
    return x


def _punt_uit(s: bytes):
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    teken = y >> 255
    y &= (1 << 255) - 1
    x = _xherstel(y, teken)
    return None if x is None else (x, y, 1, x * y % _P)


def _optel(P, Q):
    a = (P[1] - P[0]) * (Q[1] - Q[0]) % _P
    b = (P[1] + P[0]) * (Q[1] + Q[0]) % _P
    c = 2 * P[3] * Q[3] * _D % _P
    d = 2 * P[2] * Q[2] % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _maal(s: int, P):
    Q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            Q = _optel(Q, P)
        P = _optel(P, P)
        s >>= 1
    return Q


def _gelijk(P, Q) -> bool:
    return (P[0] * Q[2] - Q[0] * P[2]) % _P == 0 and (P[1] * Q[2] - Q[1] * P[2]) % _P == 0


_GY = 4 * pow(5, _P - 2, _P) % _P
_G = (_xherstel(_GY, 0), _GY, 1, _xherstel(_GY, 0) * _GY % _P)


def ed25519_controleer(publiek: bytes, bericht: bytes, handtekening: bytes) -> bool:
    if len(publiek) != 32 or len(handtekening) != 64:
        return False
    A = _punt_uit(publiek)
    R = _punt_uit(handtekening[:32])
    if not A or not R:
        return False
    s = int.from_bytes(handtekening[32:], "little")
    if s >= _L:
        return False
    h = int.from_bytes(hashlib.sha512(handtekening[:32] + publiek + bericht).digest(), "little") % _L
    return _gelijk(_maal(s, _G), _optel(R, _maal(h, A)))


def controleer_envelop(envelop: dict, publieke_sleutel: str = BELEID_PUBLIEKE_SLEUTEL) -> dict:
    """Geeft het beleid als de handtekening klopt; gooit ValueError anders."""
    if not isinstance(envelop, dict) or envelop.get("schema") != 1 or \
            not isinstance(envelop.get("inhoud"), str) or \
            not isinstance(envelop.get("handtekening"), str):
        raise ValueError("envelop onvolledig")
    if not ed25519_controleer(base64.b64decode(publieke_sleutel), envelop["inhoud"].encode("utf-8"),
                              base64.b64decode(envelop["handtekening"])):
        raise ValueError("handtekening klopt niet")
    beleid = json.loads(envelop["inhoud"])
    if beleid.get("schema") != 1 or not isinstance(beleid.get("volgnummer"), int):
        raise ValueError("inhoud is geen beleid")
    return beleid


# --------------------------------------------------------------------------- ophalen

def _cachepad() -> Path:
    eigen = os.environ.get("HOLIE_AI_BELEID_CACHE")
    if eigen:
        return Path(eigen)
    basis = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return Path(basis) / "holie-ai-beleid.json"


def _lees_cache() -> tuple[dict | None, float]:
    try:
        pad = _cachepad()
        envelop = json.loads(pad.read_text(encoding="utf-8"))
        return controleer_envelop(envelop), pad.stat().st_mtime
    except Exception:
        return None, 0.0


def huidig_beleid(project: str | None = None, *, url: str | None = None,
                  timeout: float = 2.0) -> dict:
    """Het geldende beleid: vers van het adres, anders de kopie op schijf (max 24 u), anders
    het noodbeleid. `project` laat het adres noteren wie las (zichtbaar in Tickbook).
    HOLIE_AI_BELEID_URL=uit zet het ophalen uit (tests)."""
    adres = url or os.environ.get("HOLIE_AI_BELEID_URL") or BELEID_URL
    gecached, sinds = _lees_cache()
    if gecached and time.time() - sinds < VERS_S:
        return gecached
    if adres != "uit":
        try:
            vraag = adres + ("?" + "&".join(
                [f"project={project}", f"v={PAKKET_VERSIE}"]) if project else "")
            # Eigen user-agent: Cloudflare weigert die van urllib met een 403 (1 nov 2026).
            verzoek = urllib.request.Request(
                vraag, headers={"user-agent": f"holie-ai-beleid/{PAKKET_VERSIE}"})
            with urllib.request.urlopen(verzoek, timeout=timeout) as r:
                envelop = json.loads(r.read().decode("utf-8"))
            beleid = controleer_envelop(envelop)
            if not gecached or beleid["volgnummer"] >= gecached["volgnummer"]:
                try:
                    pad = _cachepad()
                    pad.parent.mkdir(parents=True, exist_ok=True)
                    pad.write_text(json.dumps(envelop), encoding="utf-8")
                except OSError:
                    pass
                return beleid
        except Exception:
            pass
    if gecached and time.time() - sinds < MAX_S:
        return gecached
    return NOODBELEID


# ---------------------------------------------------------------------------------------------
# Verbruik melden (fase D, 1 nov 2026): dezelfde dagteller als @holie/tools >= 0.26.0.
# ---------------------------------------------------------------------------------------------

VERBRUIK_URL = "https://beleid.holie.be/verbruik"

# Prijs per token in USD, cache miss, zoals TARIEVEN in ai.ts (afgelezen, niet geschat). Een model
# dat hier niet staat, telt als 0: liever een zichtbaar gat dan een verzonnen bedrag.
TARIEVEN = {
    "deepseek-v4-flash": (0.27 / 1_000_000, 1.10 / 1_000_000),
    "deepseek-chat": (0.27 / 1_000_000, 1.10 / 1_000_000),
    "claude-haiku-5-5": (0.10 / 1_000_000, 0.50 / 1_000_000),
    "claude-sonnet-5-5": (2 / 1_000_000, 10 / 1_000_000),
    "claude-sonnet-5": (2 / 1_000_000, 10 / 1_000_000),
    "claude-sonnet-4-6": (3 / 1_000_000, 15 / 1_000_000),
    "claude-opus-5-5": (4 / 1_000_000, 20 / 1_000_000),
    "claude-opus-5": (5 / 1_000_000, 25 / 1_000_000),
    "claude-opus-4-8": (5 / 1_000_000, 25 / 1_000_000),
}


def schat_usd(model: str, usage: dict | None) -> float:
    """Tokens naar dollar; OpenAI-vorm (prompt/completion) of Anthropic-vorm (input/output)."""
    tarief = TARIEVEN.get(model or "")
    if not tarief or not usage:
        return 0.0
    i = usage.get("prompt_tokens", usage.get("input_tokens", 0)) or 0
    o = usage.get("completion_tokens", usage.get("output_tokens", 0)) or 0
    # Prompt caching (Anthropic): lezen 0,1x, schrijven 1,25x (5 min) of 2x (1 uur) het inputtarief.
    lees = usage.get("cache_read_input_tokens", 0) or 0
    schrijf = usage.get("cache_creation_input_tokens", 0) or 0
    schrijf_1u = min(schrijf, (usage.get("cache_creation") or {}).get("ephemeral_1h_input_tokens", 0) or 0)
    cache = tarief[0] * (lees * 0.1 + (schrijf - schrijf_1u) * 1.25 + schrijf_1u * 2)
    return float(i) * tarief[0] + float(o) * tarief[1] + cache


def _brusselse_dag() -> str:
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/Brussels")).strftime("%Y-%m-%d")
    except Exception:  # geen tzdata: UTC is hoogstens een paar uur ernaast
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def meld_verbruik(project: str, provider: str, type_: str = "tekst", usd: float = 0.0, *,
                  terugval: bool = False, label: bool = True, fout: bool = False,
                  url: str | None = None, timeout: float = 2.0) -> bool:
    """Meldt één aanroep aan de dagteller (POST /verbruik). Gooit nooit; geeft True als de
    Worker het aanvaardde. `label` = de aanroep gaf zelf `gegevens` mee. Uit met
    HOLIE_AI_VERBRUIK_URL=uit of HOLIE_AI_BELEID_URL=uit (tests)."""
    try:
        adres = url or os.environ.get("HOLIE_AI_VERBRUIK_URL") or VERBRUIK_URL
        if adres == "uit" or (not url and os.environ.get("HOLIE_AI_BELEID_URL") == "uit"):
            return False
        bedrag = float(usd or 0)
        if not (bedrag >= 0 and bedrag < 1e9):
            bedrag = 0.0
        regel = {
            "dag": _brusselse_dag(), "project": project,
            "provider": re.sub(r"-vision$", "", provider or "geen"), "type": type_ or "tekst",
            "aanroepen": 1, "usd": round(bedrag, 6), "terugval": int(bool(terugval)),
            "zonder_label": int(not label), "fouten": int(bool(fout)),
        }
        data = json.dumps({"v": PAKKET_VERSIE, "regels": [regel]}).encode("utf-8")
        verzoek = urllib.request.Request(adres, data=data, method="POST", headers={
            "content-type": "application/json",
            "user-agent": f"holie-ai-beleid/{PAKKET_VERSIE}",
        })
        with urllib.request.urlopen(verzoek, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False
