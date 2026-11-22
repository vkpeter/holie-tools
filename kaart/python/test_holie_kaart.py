"""Tests voor holie_kaart.py: geen netwerk, geen docker, geen R2.

    python -m unittest discover -s kaart/python -p "test_holie_kaart.py"
"""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import holie_kaart as hk  # noqa: E402

TEKST = """Pastinaak bevat een aanzienlijke hoeveelheid natuurlijke suikers die bij een verhitting boven 160 graden Celsius karamelliseren. Een oventemperatuur van 200 graden Celsius laat het vocht aan de buitenkant snel genoeg verdampen voor een krokante korst.

## Zo maak je het

1. Verwarm de oven voor op 200 graden Celsius.
7. Voeg pas de laatste 5 tot 8 minuten de walnoten toe aan de bakplaat.

## Waar het misgaat

- **Te veel groenten op elkaar:** Als de pastinaak niet in een enkele laag ligt, gaan de stukken stomen.
- **Walnoten te vroeg toevoegen:** Walnoten bevatten veel meervoudig onverzadigde vetzuren die bij langdurige verhitting boven 180 graden Celsius bitter worden.
"""
MERK = hk.Merk(naam="voorbeeld.be", accent="#112233", donker_rgb="1,2,3",
               logo='<svg width="40" height="40"></svg>', verloop="linear-gradient(red,blue)")


def model(tekst):
    return lambda p, **kw: (200, {"content": [{"type": "text", "text": tekst}]})


class Feit(unittest.TestCase):
    def test_woordelijk_en_zonder_markdown(self):
        f = hk.kies_feit(TEKST)
        self.assertTrue(hk.woordelijk(f, TEKST))
        self.assertNotIn("**", f)
        self.assertFalse(f.startswith("Walnoten te vroeg"))

    def test_geen_zin_geen_feit(self):
        self.assertIsNone(hk.kies_feit("## Kop\n\n- **Honing**\n- Kort."))
        self.assertIsNone(hk.kies_feit("Dit maakt het verschil voor 200 mensen in de buurt elke dag."))
        self.assertEqual(hk.kandidaten("Een helling leidt naar deze heuvel die 25 meter boven de stad uitsteekt."), [])

    def test_woordelijk_weigert_herschreven_tekst(self):
        self.assertFalse(hk.woordelijk("Voeg de walnoten pas op het einde toe.", TEKST))
        self.assertFalse(hk.woordelijk("", TEKST))

    def test_model_kiest_enkel_een_nummer(self):
        self.assertTrue(hk.woordelijk(hk.kies_feit(TEKST, "t", model("2")), TEKST))
        self.assertIsNone(hk.kies_feit(TEKST, "t", model("0")))
        self.assertIsNotNone(hk.kies_feit(TEKST, "t", lambda p, **kw: (0, {})))

    def test_prompt_en_label_krijgen_het_merk(self):
        gezien = []

        def vraag(p, **kw):
            gezien.append((p, kw))
            return 200, {"content": [{"type": "text", "text": "1"}]}
        hk.kies_feit(TEKST, "Titel", vraag, merk="Voorbeeld, een blog", label="voorbeeld-kaart")
        hk.kies_feiten(TEKST, "Titel", vraag, merk="Voorbeeld, een blog", label="voorbeeld-kaart")
        self.assertIn("Instagram-kaart van Voorbeeld, een blog.", gezien[0][0])
        self.assertIn("Instagram-carrousel van Voorbeeld, een blog.", gezien[1][0])
        self.assertEqual([g[1]["label"] for g in gezien], ["voorbeeld-kaart-feit", "voorbeeld-kaart-reeks"])

    def test_reeks(self):
        r = hk.kies_feiten(TEKST, "t", model("2,1,2,99"))
        self.assertEqual(len(r), 2)
        self.assertTrue(all(hk.woordelijk(f, TEKST) for f in r))
        self.assertEqual(hk.kies_feiten(TEKST, "t", model("0")), [])
        self.assertGreaterEqual(len(hk.kies_feiten(TEKST)), 2)

    def test_kort(self):
        self.assertEqual(hk.kort("kort"), "kort")
        self.assertTrue(hk.kort("Een heel lange titel die zeker langer is dan achtenveertig tekens").endswith("..."))


class Opmaak(unittest.TestCase):
    def test_merk_komt_uit_de_parameter(self):
        for h in (hk.html_feitkaart("Feit.", "T", "ETEN", None, MERK), hk.html_feiten(["Een feit."], "T", "ETEN", MERK),
                  hk.html_slot("T", "ETEN", MERK), hk.html_foto("f.jpg", "T", MERK)):
            self.assertIn("voorbeeld.be", h)
            self.assertNotIn("eendje", h.lower())
            self.assertNotIn("#0F52B4", h)

    def test_kleuren_en_verloop(self):
        self.assertIn("background:#112233", hk.basis_css("x", MERK))
        self.assertIn("rgba(1,2,3,.9)", hk.basis_css("x", MERK))
        self.assertIn("linear-gradient(red,blue)", hk.html_slot("T", "ETEN", MERK))
        self.assertIn("background:#0F172B", hk.html_foto("f.jpg", "T", MERK))
        self.assertIn("linear-gradient(red,blue)", hk.html_feitkaart("Feit.", "T", "ETEN", None, MERK))
        self.assertNotIn("<img", hk.html_feitkaart("Feit.", "T", "ETEN", None, MERK))
        self.assertIn('<img class=f src="f.jpg"', hk.html_feitkaart("Feit.", "T", "ETEN", "f.jpg", MERK))

    def test_ontsnapt_en_kort(self):
        self.assertIn("5 &lt; 8", hk.html_feiten(["5 < 8 is waar, zegt de studie."], "T", "ETEN", MERK))
        self.assertIn("Titel &amp; meer", hk.html_slot("Titel & meer", "ETEN", MERK))
        self.assertIn("...", hk.html_feitkaart("x.", "Een heel lange titel die zeker langer is dan achtenveertig", "E", None, MERK))

    def test_slot_en_logo(self):
        s = hk.html_slot("T", "ETEN", MERK)
        self.assertIn('width="150" height="150"', s)
        self.assertIn("link in bio", s)
        m = hk.Merk(naam="n", accent="#000", donker_rgb="0,0,0", bron="Van", slot_kop="Lees verder", slot_noot="zie site")
        self.assertIn("Van: T", hk.html_foto("f", "T", m))
        self.assertIn("Lees verder", hk.html_slot("T", "E", m))


def nep_cache():
    cache = tempfile.mkdtemp()
    p = os.path.join(cache, "chromium_headless_shell-1", "chrome-headless-shell-linux64")
    os.makedirs(p)
    open(os.path.join(p, "chrome-headless-shell"), "w").close()
    return cache


class RenderEnUpload(unittest.TestCase):
    def test_chrome_pad_zonder_cache_faalt_duidelijk(self):
        with self.assertRaises(RuntimeError):
            hk.chrome_pad(tempfile.mkdtemp())

    def test_chrome_pad_vindt_nieuwste(self):
        d = tempfile.mkdtemp()
        for v in ("1100", "1200"):
            p = os.path.join(d, "chromium_headless_shell-" + v, "chrome-headless-shell-linux64")
            os.makedirs(p)
            open(os.path.join(p, "chrome-headless-shell"), "w").close()
        self.assertEqual(hk.chrome_pad(d),
                         "/pw-cache/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell")

    def test_render_roept_docker_zonder_netwerk_en_vervangt_foto(self):
        fonts, uit = tempfile.mkdtemp(), os.path.join(tempfile.mkdtemp(), "k.jpg")
        open(os.path.join(fonts, hk.INTER), "w").close()
        gezien = {}

        def docker(cmd, **kw):
            werk = cmd[cmd.index("-v") + 1].rsplit(":/w", 1)[0]
            gezien["cmd"] = cmd
            gezien["html"] = open(os.path.join(werk, "k.html"), encoding="utf-8").read()
            gezien["fonts"] = os.listdir(werk)
            with open(os.path.join(werk, "k.jpg"), "wb") as f:
                f.write(b"x" * 30000)

        class Antwoord:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"jpgdata"

        with mock.patch.object(hk.subprocess, "run", docker), \
                mock.patch.object(hk.urllib.request, "urlopen", lambda *a, **k: Antwoord()):
            r = hk.render_html('<img src="https://x.be/a.webp?v=1">', uit, fonts=fonts, pw_cache=nep_cache(),
                               image="img:1", foto_url="https://x.be/a.webp?v=1")
        self.assertEqual(r, uit)
        self.assertEqual(os.path.getsize(uit), 30000)
        self.assertEqual(gezien["cmd"][gezien["cmd"].index("--network") + 1], "none")
        self.assertIn("--window-size=1080,1350", gezien["cmd"])
        self.assertIn('src="foto.webp"', gezien["html"])
        self.assertIn(hk.INTER, gezien["fonts"])

    def test_render_zonder_bruikbare_jpg_faalt(self):
        with mock.patch.object(hk.subprocess, "run", lambda *a, **k: None):
            with self.assertRaises(RuntimeError):
                hk.render_html("<p>", os.path.join(tempfile.mkdtemp(), "k.jpg"), fonts=tempfile.mkdtemp(),
                               pw_cache=nep_cache(), image="i")

    def test_upload_geeft_cdn_url_en_lekt_geen_sleutel(self):
        env = os.path.join(tempfile.mkdtemp(), "r2.env")
        with open(env, "w", encoding="utf-8") as f:
            f.write('# commentaar\nR2_ACCESS_KEY_ID="AKIAGEHEIM"\nR2_SECRET_ACCESS_KEY=sgeheim\nR2_BUCKET=emmer\nR2_ACCOUNT_ID=acc\n')
        gezien = {}

        def aws(cmd, **kw):
            gezien.update(cmd=cmd, env=kw["env"])
            return mock.Mock(returncode=0)
        with mock.patch.object(hk.subprocess, "run", aws):
            url = hk.upload_r2("/tmp/k.jpg", "stam/kaart.jpg", env_pad=env, cdn="https://cdn.voorbeeld.be")
        self.assertEqual(url, "https://cdn.voorbeeld.be/stam/kaart.jpg")
        self.assertIn("s3://emmer/stam/kaart.jpg", gezien["cmd"])
        self.assertIn("https://acc.r2.cloudflarestorage.com", gezien["cmd"])
        self.assertEqual(gezien["env"]["AWS_SECRET_ACCESS_KEY"], "sgeheim")
        with mock.patch.object(hk.subprocess, "run", lambda *a, **k: mock.Mock(returncode=3)):
            with self.assertRaises(RuntimeError) as c:
                hk.upload_r2("/tmp/k.jpg", "s", env_pad=env, cdn="c")
        self.assertNotIn("geheim", str(c.exception))


if __name__ == "__main__":
    unittest.main()
