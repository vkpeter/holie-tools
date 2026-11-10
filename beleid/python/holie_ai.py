"""Eén AI-aanroep voor Python-code, met terugval volgens het AI-beleid (nu Claude, Gemini, Lovable, DeepSeek, Meta).

Python-tegenhanger van `callAi` in @holie/tools. Enkel de standaardbibliotheek, naast
`holie_ai_beleid` (zelfde map). Op de VPS: /opt/holie/lib/python (PYTHONPATH); lokaal:
PYTHONPATH naar holie-tools/beleid/python.

    import holie_ai
    uit = holie_ai.call_ai([{"role": "user", "content": "..."}], project="domus",
                           label="score", gegevens="prive-peter")
    uit["content"], uit["provider"], uit["terugval"]

De volgorde komt uit het AI-beleid (`kies_providers`, standaard de basisvolgorde van het type);
een provider zonder sleutel of die deze client niet kent valt weg, DeepSeek en Meta blijven eruit
waar het beleid dat voor de gegevens eist (bv. "persoon"). Meta (Muse) doet enkel type "tekst"
(py-1.3.0, zoals `callAi` sinds 0.33.0).
Terugval naar de volgende provider bij: 400/401/402 met "credit" of "balance" in de tekst (tegoed
op: die provider 10 min overgeslagen), 429, 5xx (ook 529), timeout, netwerkfout en elke andere
4xx (zonder cache). Verbruik en storingen gaan naar de centrale teller. Nooit een sleutel in
een log.
"""
from __future__ import annotations

import json
import logging
import os
import socket
import time
import urllib.error
import urllib.request
from typing import Callable

import holie_ai_beleid as beleid_mod

logger = logging.getLogger(__name__)

TEGOED_OP_S = 10 * 60
STANDAARD_MODELLEN = {
    "anthropic": "claude-haiku-5-5",
    "deepseek": "deepseek-v4-flash",
    "gemini": "gemini-3.5-flash-lite",
    "lovable": "google/gemini-3-flash-preview",
    "meta": "muse-spark-1.3",
}
SLEUTELS = {"anthropic": "ANTHROPIC_API_KEY", "deepseek": "DEEPSEEK_API_KEY",
            "gemini": "GEMINI_API_KEY", "lovable": "LOVABLE_API_KEY",
            "meta": "META_MODEL_API_KEY"}
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSIE = "2023-06-01"
DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
LOVABLE_URL = "https://ai.gateway.lovable.dev/v1/chat/completions"
META_URL = "https://api.meta.ai/v1/chat/completions"  # Muse, OpenAI-vorm (zelfde als META_CHAT_ENDPOINT)
URLS = {"deepseek": DEEPSEEK_URL, "gemini": GEMINI_URL, "lovable": LOVABLE_URL, "meta": META_URL}
# Tools en beeld-in zijn voor Meta niet nagemeten: enkel tekst.
ENKEL_TEKST = {"meta"}

HttpFn = Callable[[str, dict, bytes, float], "tuple[int, str]"]

# provider:laatste 8 tekens van de sleutel -> tijdstip (monotonic) tot wanneer overgeslagen
_tegoed_op_tot: dict[str, float] = {}


class AiOnbeschikbaar(Exception):
    """Alle providers faalden. `status` = status van de laatste poging (0 = timeout/netwerk)."""

    def __init__(self, status: int, pogingen: list[dict]):
        samen = "; ".join(f"{p['provider']}: {p['status']} {p['fout']}"[:160] for p in pogingen)
        super().__init__(f"Geen AI-provider kon antwoorden ({samen or 'geen kandidaten'})")
        self.status = status
        self.pogingen = pogingen


def is_tegoed_fout(status: int, tekst: str) -> bool:
    low = (tekst or "").lower()
    return status in (400, 401, 402) and ("credit" in low or "balance" in low)


def _cache_sleutel(provider: str, sleutel: str) -> str:
    return f"{provider}:{sleutel[-8:]}"


def _tegoed_op(provider: str, sleutel: str) -> bool:
    k = _cache_sleutel(provider, sleutel)
    tot = _tegoed_op_tot.get(k)
    if tot is None:
        return False
    if time.monotonic() > tot:
        del _tegoed_op_tot[k]
        return False
    return True


def wis_tegoed_cache() -> None:
    _tegoed_op_tot.clear()


def _http_urllib(url: str, headers: dict, body: bytes, timeout: float) -> tuple[int, str]:
    verzoek = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(verzoek, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            tekst = e.read().decode("utf-8", "replace")
        except Exception:
            tekst = ""
        return e.code, tekst
    except urllib.error.URLError as e:
        if isinstance(e.reason, (socket.timeout, TimeoutError)):
            raise TimeoutError(str(e.reason)) from e
        raise


def _json(tekst: str) -> dict:
    try:
        d = json.loads(tekst)
        return d if isinstance(d, dict) else {}
    except ValueError:
        return {}


def _bouw_anthropic(model: str, messages: list[dict], system: str | None, max_tokens: int):
    systemen = [system] if system else []
    berichten = []
    for m in messages:
        if m.get("role") == "system":
            systemen.append(str(m.get("content") or ""))
        else:
            berichten.append({"role": m["role"], "content": m["content"]})
    body: dict = {"model": model, "max_tokens": max_tokens, "messages": berichten}
    if systemen:
        body["system"] = "\n\n".join(s for s in systemen if s)
    # Nooit temperature naar Claude: nieuwere modellen weigeren die.
    return body


def _bouw_openai(model: str, messages: list[dict], system: str | None, max_tokens: int,
                 temperature: float | None, deepseek: bool):
    berichten = ([{"role": "system", "content": system}] if system else []) + list(messages)
    body: dict = {"model": model, "messages": berichten, "max_tokens": max_tokens}
    if temperature is not None:
        body["temperature"] = temperature
    if deepseek:
        # V4 denkt standaard na; die tokens tellen mee in max_tokens.
        body["thinking"] = {"type": "disabled"}
    return body


def _lees_anthropic(data: dict) -> tuple[str, dict | None, str | None]:
    tekst = "".join(b.get("text", "") for b in data.get("content") or []
                    if isinstance(b, dict) and b.get("type") == "text")
    stop = data.get("stop_reason")
    stop = {"end_turn": "stop", "max_tokens": "length", "stop_sequence": "stop"}.get(stop, stop)
    return tekst, data.get("usage"), stop


def _lees_openai(data: dict) -> tuple[str, dict | None, str | None]:
    keuzes = data.get("choices") or [{}]
    k = keuzes[0] if keuzes else {}
    return ((k.get("message") or {}).get("content") or ""), data.get("usage"), \
        k.get("finish_reason")


def call_ai(messages: list[dict], *, project: str, label: str, gegevens: str | None = None,
            type: str = "tekst", volgorde: list[str] | None = None, system: str | None = None,
            max_tokens: int = 2048, temperature: float | None = None, timeout: float = 120,
            anthropic_model: str | None = None, deepseek_model: str | None = None,
            gemini_model: str | None = None, lovable_model: str | None = None,
            meta_model: str | None = None, env: dict | None = None,
            beleid: dict | None = None, http: HttpFn | None = None) -> dict:
    """Eén tekstaanroep met terugval. Geeft {"content","provider","model","usage","terugval",
    "finish_reason"}. Gooit AiOnbeschikbaar als alles faalt, BeleidLeeg als het beleid of de
    ontbrekende sleutels geen kandidaat overlaten."""
    env = os.environ if env is None else env
    http = http or _http_urllib
    modellen = {"anthropic": anthropic_model or STANDAARD_MODELLEN["anthropic"],
                "deepseek": deepseek_model or STANDAARD_MODELLEN["deepseek"],
                "gemini": gemini_model or STANDAARD_MODELLEN["gemini"],
                "lovable": lovable_model or STANDAARD_MODELLEN["lovable"],
                "meta": meta_model or STANDAARD_MODELLEN["meta"]}

    def sleutel_van(p: str) -> str:
        return (env.get(SLEUTELS.get(p, "")) or "").strip()

    if beleid is None:
        beleid = beleid_mod.huidig_beleid(project)
    kandidaten = list(volgorde) if volgorde else None  # None = basisvolgorde uit het beleid
    uitslag = beleid_mod.kies_providers(
        beleid, type=type, project=project, gegevens=gegevens, volgorde=kandidaten,
        heeft_sleutel=lambda p: (p in SLEUTELS and bool(sleutel_van(p))
                               and (type == "tekst" or p not in ENKEL_TEKST)))
    for w in uitslag["waarschuwingen"]:
        logger.warning("[ai:%s] beleid: %s", label, w)
    for stap in uitslag["stappen"]:
        for w in stap["weg"]:
            if w["provider"] not in SLEUTELS:
                logger.info("[ai:%s] %s overgeslagen: onbekend voor deze client", label, w["provider"])
    keten = uitslag["volgorde"]
    # Providers met "tegoed op" in de cache overslaan; blijft er niets over, dan toch proberen.
    over = [p for p in keten if not _tegoed_op(p, sleutel_van(p))]
    for p in keten:
        if p not in over:
            logger.info("[ai:%s] %s: tegoed op, overgeslagen", label, p)
    keten = over or keten

    pogingen: list[dict] = []
    storingen: list[dict] = []
    laatste_provider = keten[0] if keten else "geen"
    for i, provider in enumerate(keten):
        laatste_provider = provider
        sleutel = sleutel_van(provider)
        model = modellen[provider]
        if provider == "anthropic":
            url, body = ANTHROPIC_URL, _bouw_anthropic(model, messages, system, max_tokens)
            headers = {"content-type": "application/json", "x-api-key": sleutel,
                       "anthropic-version": ANTHROPIC_VERSIE}
        else:
            url = URLS[provider]
            body = _bouw_openai(model, messages, system, max_tokens, temperature,
                                provider == "deepseek")
            headers = {"content-type": "application/json", "authorization": f"Bearer {sleutel}"}
        headers["user-agent"] = f"holie-ai/{beleid_mod.PAKKET_VERSIE}"
        fout = ""
        try:
            status, tekst = http(url, headers, json.dumps(body).encode("utf-8"), timeout)
        except (TimeoutError, socket.timeout):
            status, tekst, fout = 0, "", "timeout"
        except Exception as e:  # netwerkfout
            status, tekst, fout = 0, "", f"netwerkfout {e.__class__.__name__}"
        if status == 200:
            data = _json(tekst)
            inhoud, usage, stop = (_lees_anthropic if provider == "anthropic"
                                   else _lees_openai)(data)
            if inhoud.strip():
                beleid_mod.meld_verbruik(
                    project, provider, type, beleid_mod.schat_usd(model, usage),
                    terugval=i > 0, label=gegevens is not None, storingen=storingen)
                return {"content": inhoud, "provider": provider, "model": model,
                        "usage": usage, "terugval": i > 0, "finish_reason": stop}
            fout = "lege inhoud"  # geen storing: de provider werkt, het antwoord niet
        else:
            if not fout:
                fout = (tekst or "")[:200]
            soort = "tegoed" if is_tegoed_fout(status, tekst) else "fout"
            if soort == "tegoed":
                _tegoed_op_tot[_cache_sleutel(provider, sleutel)] = time.monotonic() + TEGOED_OP_S
                logger.warning("[ai:%s] %s: tegoed op, %d min overgeslagen", label, provider,
                               TEGOED_OP_S // 60)
            storingen.append({"provider": provider, "soort": soort, "status": status})
        logger.warning("[ai:%s] %s faalde (status %s): %s", label, provider, status, fout[:160])
        pogingen.append({"provider": provider, "status": status, "fout": fout})

    beleid_mod.meld_verbruik(project, laatste_provider, type, 0.0, terugval=len(keten) > 1,
                             label=gegevens is not None, fout=True, storingen=storingen)
    raise AiOnbeschikbaar(pogingen[-1]["status"] if pogingen else 0, pogingen)
