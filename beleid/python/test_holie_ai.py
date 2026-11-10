"""Toetst holie_ai.call_ai met een gefingeerde http (geen netwerk).

    python -I -m pytest beleid/python      (of: python beleid/python/test_holie_ai.py)
"""
import json
import os
import sys
from pathlib import Path
from unittest import mock

HIER = Path(__file__).parent
sys.path.insert(0, str(HIER))
os.environ["HOLIE_AI_VERBRUIK_URL"] = "uit"
os.environ["HOLIE_AI_BELEID_URL"] = "uit"

import holie_ai  # noqa: E402
import holie_ai_beleid as hab  # noqa: E402

ENV = {"ANTHROPIC_API_KEY": "sk-ant-test-12345678", "DEEPSEEK_API_KEY": "sk-ds-test-12345678"}
MSG = [{"role": "user", "content": "hallo"}]
KREDIET = '{"error":{"message":"Your credit balance is too low to access the Anthropic API"}}'
OK_DS = json.dumps({"choices": [{"message": {"content": "hoi"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 3, "completion_tokens": 1}})
OK_ANT = json.dumps({"content": [{"type": "text", "text": "dag"}], "stop_reason": "end_turn",
                     "usage": {"input_tokens": 3, "output_tokens": 1}})


def nep(anthropic):
    """http-dubbel: `anthropic` is (status, tekst) of een exceptie; deepseek antwoordt altijd."""
    oproepen = []

    def http(url, headers, body, timeout):
        oproepen.append(url)
        if "anthropic" in url:
            if isinstance(anthropic, BaseException):
                raise anthropic
            return anthropic
        if "deepseek" in url:
            return 200, OK_DS
        return 500, "kapot"
    http.oproepen = oproepen
    return http


def roep(http, **kw):
    return holie_ai.call_ai(MSG, project="domus", label="t", gegevens="prive-peter",
                            volgorde=["anthropic", "deepseek"], env=ENV,
                            beleid=hab.NOODBELEID, http=http, **kw)


def setup_function(_):
    holie_ai.wis_tegoed_cache()


def test_claude_goed():
    uit = roep(nep((200, OK_ANT)))
    assert uit["provider"] == "anthropic" and uit["content"] == "dag"
    assert uit["terugval"] is False and uit["finish_reason"] == "stop"


def test_tegoed_op_valt_terug_en_wordt_overgeslagen():
    http = nep((400, KREDIET))
    uit = roep(http)
    assert uit["provider"] == "deepseek" and uit["terugval"] is True
    assert sum("anthropic" in u for u in http.oproepen) == 1
    http2 = nep((400, KREDIET))
    uit2 = roep(http2)
    assert uit2["provider"] == "deepseek" and uit2["terugval"] is False
    assert not any("anthropic" in u for u in http2.oproepen)


def test_429_529_timeout_naar_deepseek():
    for ant in [(429, "te snel"), (529, "overloaded"), (503, "x"), TimeoutError("t"),
                OSError("netwerk"), (404, "model weg")]:
        holie_ai.wis_tegoed_cache()
        uit = roep(nep(ant))
        assert uit["provider"] == "deepseek" and uit["terugval"] is True, ant


def test_een_gewone_400_zonder_credit_geen_cache():
    roep(nep((400, "bad request")))
    http = nep((200, OK_ANT))
    assert roep(http)["provider"] == "anthropic"


def test_alles_faalt():
    def http(url, headers, body, timeout):
        return 500, "stuk"
    with mock.patch.object(hab, "meld_verbruik") as m:
        try:
            roep(http)
        except holie_ai.AiOnbeschikbaar as e:
            assert e.status == 500 and len(e.pogingen) == 2
        else:
            raise AssertionError("AiOnbeschikbaar verwacht")
    kw = m.call_args.kwargs
    assert kw["fout"] is True
    assert [s["soort"] for s in kw["storingen"]] == ["fout", "fout"]


def test_storingen_soort_in_meld_verbruik():
    with mock.patch.object(hab, "meld_verbruik") as m:
        roep(nep((400, KREDIET)))
    kw = m.call_args.kwargs
    assert kw["terugval"] is True and kw["label"] is True
    assert kw["storingen"] == [{"provider": "anthropic", "soort": "tegoed", "status": 400}]
    holie_ai.wis_tegoed_cache()
    with mock.patch.object(hab, "meld_verbruik") as m:
        roep(nep((429, "x")))
    assert m.call_args.kwargs["storingen"][0]["soort"] == "fout"
    holie_ai.wis_tegoed_cache()
    with mock.patch.object(hab, "meld_verbruik") as m:
        roep(nep(TimeoutError()))
    assert m.call_args.kwargs["storingen"] == [
        {"provider": "anthropic", "soort": "fout", "status": 0}]


def test_body_vorm():
    gezien = {}

    def http(url, headers, body, timeout):
        gezien[url] = (headers, json.loads(body))
        return (200, OK_ANT) if "anthropic" in url else (200, OK_DS)
    holie_ai.call_ai(MSG, project="domus", label="t", gegevens="prive-peter", system="sys",
                     temperature=0.3, volgorde=["anthropic"], env=ENV, beleid=hab.NOODBELEID,
                     http=http)
    h, b = gezien[holie_ai.ANTHROPIC_URL]
    assert h["x-api-key"] == ENV["ANTHROPIC_API_KEY"] and h["anthropic-version"] == "2023-06-01"
    assert b["system"] == "sys" and "temperature" not in b and b["model"] == "claude-haiku-5-5"
    holie_ai.call_ai(MSG, project="domus", label="t", gegevens="prive-peter", system="sys",
                     temperature=0.3, volgorde=["deepseek"], env=ENV, beleid=hab.NOODBELEID,
                     http=http)
    h, b = gezien[holie_ai.DEEPSEEK_URL]
    assert b["thinking"] == {"type": "disabled"} and b["temperature"] == 0.3
    assert b["messages"][0] == {"role": "system", "content": "sys"}


def test_samenvoegen():
    s = hab.samenvoegen_storingen([{"provider": "a", "soort": "fout", "status": 429},
                                   {"provider": "a", "soort": "fout", "status": 529}])
    assert s == [{"provider": "a", "soort": "fout", "status": 529, "aantal": 2}]


def test_beleid_sluit_deepseek_uit_voor_persoon_dus_anthropic_dan_gemini():
    import copy
    beleid = copy.deepcopy(hab.NOODBELEID)
    beleid["toelatingen"].append({"provider": "gemini", "gegevens": "persoon", "status": "testfase",
                                  "reden": "test", "wie": "t", "datum": "2026-11-09"})
    env = dict(ENV, GEMINI_API_KEY="gem-test-12345678")
    oproepen = []

    def http(url, headers, body, timeout):
        oproepen.append(url)
        if "anthropic" in url:
            return 529, "overloaded"
        if "generativelanguage" in url:
            return 200, OK_DS
        return 200, OK_DS
    uit = holie_ai.call_ai(MSG, project="x", label="t", gegevens="persoon", env=env,
                           beleid=beleid, http=http)
    assert uit["provider"] == "gemini" and uit["terugval"] is True
    assert not any("deepseek" in u for u in oproepen)


def test_standaardvolgorde_uit_beleid_met_lovable_en_onbekende_provider():
    env = {"LOVABLE_API_KEY": "lov-test-12345678", "ANTHROPIC_API_KEY": "sk-ant-test-12345678"}
    beleid = dict(hab.NOODBELEID, basis={"tekst": ["meta", "anthropic", "lovable"]})
    oproepen = []

    def http(url, headers, body, timeout):
        oproepen.append(url)
        return (500, "stuk") if "anthropic" in url else (200, OK_DS)
    uit = holie_ai.call_ai(MSG, project="x", label="t", gegevens="publiek", env=env,
                           beleid=beleid, http=http)
    assert uit["provider"] == "lovable" and uit["model"] == "google/gemini-3-flash-preview"
    assert oproepen == [holie_ai.ANTHROPIC_URL, holie_ai.LOVABLE_URL]



BELEID_V18 = json.loads((HIER.parent / "ai-beleid.json").read_text(encoding="utf-8"))
ALLE = {"ANTHROPIC_API_KEY": "sk-ant-test-12345678", "GEMINI_API_KEY": "gem-test-12345678",
        "LOVABLE_API_KEY": "lov-test-12345678", "DEEPSEEK_API_KEY": "sk-ds-test-12345678",
        "META_MODEL_API_KEY": "meta-test-12345678"}


def test_meta_is_laatste_tekstschakel():
    oproepen = []

    def http(url, headers, body, timeout):
        oproepen.append((url, headers.get("authorization"), json.loads(body)["model"]))
        return (200, OK_DS) if url == holie_ai.META_URL else (503, "weg")
    uit = holie_ai.call_ai(MSG, project="domus", label="t", gegevens="prive-peter", env=ALLE,
                           beleid=BELEID_V18, http=http)
    assert uit["provider"] == "meta" and uit["model"] == "muse-spark-1.3" and uit["terugval"]
    assert [u for u, _, _ in oproepen] == [holie_ai.ANTHROPIC_URL, holie_ai.GEMINI_URL,
                                          holie_ai.LOVABLE_URL, holie_ai.DEEPSEEK_URL,
                                          holie_ai.META_URL]
    assert oproepen[-1][1] == "Bearer meta-test-12345678"


def test_meta_niet_voor_persoon_en_niet_buiten_tekst():
    oproepen = []

    def http(url, headers, body, timeout):
        oproepen.append(url)
        return 503, "weg"
    for gegevens, type_ in (("persoon", "tekst"), ("prive-peter", "tools")):
        try:
            holie_ai.call_ai(MSG, project="x", label="t", gegevens=gegevens, type=type_, env=ALLE,
                             beleid=BELEID_V18, http=http)
        except holie_ai.AiOnbeschikbaar:
            pass
    assert holie_ai.META_URL not in oproepen and len(oproepen) > 0


def test_meta_zonder_sleutel_valt_weg():
    env = {k: v for k, v in ALLE.items() if k != "META_MODEL_API_KEY"}
    oproepen = []

    def http(url, headers, body, timeout):
        oproepen.append(url)
        return 503, "weg"
    try:
        holie_ai.call_ai(MSG, project="x", label="t", gegevens="publiek", env=env,
                         beleid=BELEID_V18, http=http)
    except holie_ai.AiOnbeschikbaar:
        pass
    assert holie_ai.META_URL not in oproepen and len(oproepen) == 4


if __name__ == "__main__":
    # Zonder pytest (staat niet op de VPS of de laptop): elke test_-functie draaien.
    fouten = 0
    for naam, f in sorted(globals().items()):
        if naam.startswith("test_") and callable(f):
            holie_ai.wis_tegoed_cache() if hasattr(holie_ai, "wis_tegoed_cache") else None
            try:
                f()
                print("ok", naam)
            except Exception as e:  # noqa: BLE001
                fouten += 1
                print("FOUT", naam, type(e).__name__, e)
    sys.exit(1 if fouten else 0)
