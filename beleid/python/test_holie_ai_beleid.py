"""Toetst de Python-lezer tegen de TypeScript-uitkomst (verwachting.json, zie verwachting.ts).

    python -I -m pytest beleid/python      (of: python beleid/python/test_holie_ai_beleid.py)
"""
import base64
import copy
import json
import os
import sys
from pathlib import Path

HIER = Path(__file__).parent
sys.path.insert(0, str(HIER))

import holie_ai_beleid as hab  # noqa: E402

BELEID = json.loads((HIER.parent / "ai-beleid.json").read_text(encoding="utf-8"))
VERWACHT = json.loads((HIER / "verwachting.json").read_text(encoding="utf-8"))


def test_zelfde_keuze_als_typescript():
    fouten = []
    for g in VERWACHT["gevallen"]:
        v = g["vraag"]
        try:
            u = hab.kies_providers(BELEID, type=v["type"], project=v.get("project"),
                                   gegevens=v.get("gegevens"), context=v.get("context"),
                                   nu=g["nu"])
            uit = {"volgorde": u["volgorde"], "gegevens": u["gegevens"], "voorrang": u["voorrang"]}
        except hab.BeleidLeeg as e:
            uit = {"leeg": e.stap}
        if uit != g["uitkomst"]:
            fouten.append((v, g["nu"], uit, g["uitkomst"]))
    assert not fouten, f"{len(fouten)} verschillen, eerste: {fouten[0]}"
    assert len(VERWACHT["gevallen"]) > 500


def test_handtekening_klopt():
    beleid = hab.controleer_envelop(VERWACHT["envelop"], VERWACHT["publiek"])
    assert beleid["volgnummer"] == BELEID["volgnummer"]


def test_vervalste_inhoud_faalt():
    e = copy.deepcopy(VERWACHT["envelop"])
    e["inhoud"] = e["inhoud"].replace('"anthropic"', '"anthropix"', 1)
    try:
        hab.controleer_envelop(e, VERWACHT["publiek"])
    except ValueError as fout:
        assert "handtekening" in str(fout)
    else:
        raise AssertionError("vervalst envelop aanvaard")


def test_andere_sleutel_faalt():
    try:
        hab.controleer_envelop(VERWACHT["envelop"])  # de echte publieke sleutel
    except ValueError:
        pass
    else:
        raise AssertionError("handtekening van een wegwerpsleutel aanvaard")


def test_domus_prive_peter_claude_dan_deepseek():
    u = hab.kies_providers(BELEID, type="tekst", project="domus",
                           volgorde=["anthropic", "deepseek"], nu=1794700800)  # 20 nov 2026
    assert u["gegevens"] == "prive-peter"
    assert u["volgorde"] == ["anthropic", "deepseek"]


def test_sleutel_filtert():
    u = hab.kies_providers(BELEID, type="tekst", project="domus",
                           volgorde=["anthropic", "deepseek"],
                           heeft_sleutel=lambda p: p == "deepseek")
    assert u["volgorde"] == ["deepseek"]


def test_zonder_adres_en_cache_noodbeleid(tmp_path=None):
    import tempfile
    d = tmp_path or Path(tempfile.mkdtemp())
    os.environ["HOLIE_AI_BELEID_URL"] = "uit"
    os.environ["HOLIE_AI_BELEID_CACHE"] = str(Path(d) / "geen.json")
    try:
        assert hab.huidig_beleid("domus") is hab.NOODBELEID
        try:
            hab.kies_providers(hab.NOODBELEID, type="tekst", project="x", gegevens="persoon",
                               volgorde=["deepseek"])
        except hab.BeleidLeeg as e:
            assert e.stap == "uitsluiting"
        else:
            raise AssertionError("noodbeleid liet DeepSeek toe voor persoon")
    finally:
        del os.environ["HOLIE_AI_BELEID_URL"]
        del os.environ["HOLIE_AI_BELEID_CACHE"]


def test_meld_verbruik_naar_nep_adres():
    import http.server
    import threading
    ontvangen = []

    class Hand(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            n = int(self.headers.get("content-length") or 0)
            ontvangen.append(json.loads(self.rfile.read(n)))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Hand)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        url = f"http://127.0.0.1:{srv.server_port}/verbruik"
        usd = hab.schat_usd("claude-haiku-5-5", {"input_tokens": 1_000_000, "output_tokens": 0})
        assert abs(usd - 0.10) < 1e-9
        assert hab.meld_verbruik("domus", "anthropic", "tekst", usd, label=True, url=url)
        r = ontvangen[0]["regels"][0]
        assert r["project"] == "domus" and r["provider"] == "anthropic"
        assert r["aanroepen"] == 1 and r["zonder_label"] == 0 and r["usd"] == 0.1
    finally:
        srv.shutdown()


def test_meld_verbruik_uit_en_stil_bij_fouten():
    oud = os.environ.get("HOLIE_AI_VERBRUIK_URL")
    os.environ["HOLIE_AI_VERBRUIK_URL"] = "uit"
    try:
        assert hab.meld_verbruik("domus", "anthropic") is False
    finally:
        if oud is None:
            os.environ.pop("HOLIE_AI_VERBRUIK_URL", None)
        else:
            os.environ["HOLIE_AI_VERBRUIK_URL"] = oud
    # onbereikbaar adres: geen uitzondering, gewoon False
    assert hab.meld_verbruik("domus", "anthropic", url="http://127.0.0.1:9/x", timeout=0.5) is False


if __name__ == "__main__":
    for naam, f in list(globals().items()):
        if naam.startswith("test_"):
            f()
            print("ok", naam)
