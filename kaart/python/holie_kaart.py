"""Gedeelde kaartmotor van Holie (Eendje, Nilou, later meer): merk-onafhankelijk, enkel standaardbibliotheek.

Draait op de VPS-host (python3 van Ubuntu) uit /opt/holie/lib/python (zie holie-skills `jobs/holie_ai_py.py`), lokaal
uit holie-tools/kaart/python. Wat hier staat kent geen merk: kleuren, naam, logo, prompts en querys komen als
parameter van de job die de module gebruikt.

Onderdelen:
- feitkeuze: `platte_tekst`, `zinnen`, `kandidaten`, `kies_feit`, `kies_feiten`, `woordelijk`, `kort`. Een kaartkop is
  altijd een zin die WOORDELIJK in het artikel staat; het taalmodel (de functie `vraag`) kiest enkel een nummer.
- opmaak: `Merk`, `basis_css`, `html_feitkaart`, `html_foto`, `html_feiten`, `html_slot` (carrouselslides 1080x1350).
- renderen en uploaden: `render_html` (HTML naar JPG via chrome-headless-shell in een docker-container zonder
  netwerk), `upload_r2` (aws s3 cp naar R2; de sleutels komen nooit in een log).

Gebruik in een job:

    import holie_kaart as hk
    MERK = hk.Merk(naam="eendje.be", accent="#0F52B4", donker_rgb="15,23,43", logo=DUCK)
    html = hk.html_slot("Titel", "ETEN", MERK)
    hk.render_html(html, "/tmp/k.jpg", fonts="/opt/holie/jobs/nilou-fonts", pw_cache=PW_CACHE, image=IMAGE)
    url = hk.upload_r2("/tmp/k.jpg", "stam/kaart.jpg", env_pad="/etc/holie/eendje-beeld.env", cdn="https://cdn.eendje.be")

Tests: `python -m unittest discover -s kaart/python -p "test_holie_kaart.py"` (geen netwerk, geen docker).
"""
import glob
import html as _html
import os
import re
import shutil
import subprocess
import tempfile
import urllib.request
from dataclasses import dataclass

BREED, HOOG = 1080, 1350
INTER = "inter-latin-wght-normal.woff2"
MIN_TEKENS, MAX_TEKENS = 35, 100
# Zinnen die zonder hun vorige zin niets zeggen.
VERWIJST = re.compile(r"^(Dit|Dat|Daardoor|Daarom|Daarna|Hier|Hierdoor|Zo|Ook|En|Maar|Het|Die|Deze|Hij|Zij|Ze|Om dit)\b")
# Zinnen die naar een plek of ding wijzen dat enkel in de vorige zin genoemd werd ("deze heuvel").
DEIXIS = re.compile(r"\b(deze|dit|die|daar|hier)\s+(heuvel|plek|stad|regio|terrein|route|gerecht|recept)\b", re.I)


# ---------------------------------------------------------------- feitkeuze

def platte_tekst(md):
    """Markdown naar platte regels: geen koppen, geen opsommingstekens, geen vet- of cursieftekens, geen links."""
    regels = []
    for r in (md or "").splitlines():
        r = r.strip()
        if not r or r.startswith("#") or r.startswith(">") or r.startswith("|"):
            continue
        r = re.sub(r"^(?:[-*+]|\d+[.)])\s+", "", r)
        r = re.sub(r"^\*\*[^*]{1,60}:\*\*\s*", "", r)  # "**Te veel groenten:** ..." -> de uitleg
        r = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", r)
        r = r.replace("**", "").replace("__", "")
        r = re.sub(r"(?<![\w*])\*(?!\s)([^*]+)\*", r"\1", r)
        regels.append(r)
    return regels


def zinnen(regel):
    return [z.strip() for z in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9À-Ý\"'])", regel) if z.strip()]


def kandidaten(content_md):
    """Volledige zinnen uit het artikel die als losse kop kunnen staan, in volgorde, met een heuristische score."""
    uit, pos = [], 0
    for regel in platte_tekst(content_md):
        for z in zinnen(regel):
            pos += 1
            if not (MIN_TEKENS <= len(z) <= MAX_TEKENS) or not z.endswith((".", "!")):
                continue
            if VERWIJST.match(z) or DEIXIS.search(z) or "http" in z or "?" in z or ":" in z[:40]:
                continue
            s = (3 if re.search(r"\d", z) else 0) + (2 if 45 <= len(z) <= 85 else 0) + (1 if pos <= 6 else 0)
            s -= 2 if len(z.split()) < 7 else 0
            uit.append((z, s))
    return uit


PROMPT = ("Je kiest de kop voor een Instagram-kaart van {merk}. Hieronder staan zinnen "
          "die woordelijk uit het artikel komen. Kies de zin die zonder context begrijpelijk is en de lezer het meest "
          "verrast met een concreet feit (een getal, een oorzaak, een onverwacht detail). Geen instructie zonder feit, "
          "geen sfeerzin, geen inleiding. Antwoord enkel met het nummer, of 0 als geen enkele zin werkt.\n\n"
          "Artikel: {titel}\n\n{lijst}")

PROMPT_REEKS = ("Je kiest de zinnen voor een Instagram-carrousel van {merk}. Hieronder "
                "staan zinnen die woordelijk uit het artikel komen. Kies eerst de kop: de zin die zonder context "
                "begrijpelijk is en het meest verrast met een concreet feit. Kies daarna TWEE aanvullende feiten "
                "voor de tweede slide: zinnen die elk ook zonder context kloppen, iets concreets vertellen en niet "
                "hetzelfde zeggen als de kop. Geef er maar een als er echt geen tweede bruikbare is. Geen instructie "
                "zonder feit, geen sfeerzin. Antwoord enkel met drie nummers, kop eerst, gescheiden door komma's "
                "(bv. 4,1,9), of 0 als geen enkele zin werkt als kop.\n\nArtikel: {titel}\n\n{lijst}")


def _antwoord(status, antw):
    return "".join(b.get("text", "") for b in (antw or {}).get("content", [])) if status == 200 else ""


def kies_feit(content_md, titel="", vraag=None, *, merk="een nieuwsgierige blog", label="kaart"):
    """Het beste feit uit het artikel: een volledige zin, woordelijk, 35 tot 100 tekens. None als er geen is.

    Met `vraag` (de functie `vraag(prompt, label=, max_tokens=) -> (status, antwoord)` van de job) kiest een
    taalmodel enkel een NUMMER uit de kandidaten, zodat de tekst woordelijk blijft; zonder model of bij een fout
    beslist de heuristiek (getal, lengte, vroeg in het artikel). `merk` staat in de prompt ("Eendje.be, een
    nieuwsgierige Vlaamse blog"); `label` is het voorvoegsel van het model-label ("eendje-kaart" geeft
    "eendje-kaart-feit")."""
    kand = kandidaten(content_md)
    if not kand:
        return None
    if vraag and len(kand) > 1:
        top = sorted(kand, key=lambda x: -x[1])[:12]
        lijst = "\n".join("%d. %s" % (n + 1, z) for n, (z, _) in enumerate(top))
        status, antw = vraag(PROMPT.format(merk=merk, titel=titel, lijst=lijst), label=label + "-feit", max_tokens=10)
        m = re.search(r"\d+", _antwoord(status, antw))
        if m:
            n = int(m.group(0))
            if n == 0:
                return None
            if 1 <= n <= len(top):
                return top[n - 1][0]
    return max(kand, key=lambda x: x[1])[0]


def kies_feiten(content_md, titel="", vraag=None, n=3, *, merk="een nieuwsgierige blog", label="kaart"):
    """Kop plus hoogstens n-1 aanvullende feiten voor een carrousel, allemaal woordelijk. [] als er geen kop is.

    Zelfde werkwijze als kies_feit: het model geeft enkel nummers. Zonder model of bij een fout: de n beste volgens
    de heuristiek."""
    kand = kandidaten(content_md)
    if not kand:
        return []
    top = sorted(kand, key=lambda x: -x[1])[:12]
    if vraag and len(top) > 1:
        lijst = "\n".join("%d. %s" % (i + 1, z) for i, (z, _) in enumerate(top))
        status, antw = vraag(PROMPT_REEKS.format(merk=merk, titel=titel, lijst=lijst), label=label + "-reeks",
                             max_tokens=20)
        nrs = [int(x) for x in re.findall(r"\d+", _antwoord(status, antw))]
        if nrs and nrs[0] == 0:
            return []
        gekozen = []
        for k in nrs:
            if 1 <= k <= len(top) and top[k - 1][0] not in gekozen:
                gekozen.append(top[k - 1][0])
        if gekozen:
            return gekozen[:n]
    return [z for z, _ in top[:n]]


def woordelijk(feit, content_md):
    """De kaarttekst moet als exacte reeks in de platte artikeltekst staan."""
    return bool(feit) and feit in "\n".join(platte_tekst(content_md))


def kort(titel, n=48):
    titel = (titel or "").strip()
    return titel if len(titel) <= n else titel[: n - 1].rsplit(" ", 1)[0] + "..."


# ---------------------------------------------------------------- opmaak

@dataclass(frozen=True)
class Merk:
    """Alles wat een kaart merkspecifiek maakt. De opmaak zelf (maten, lettertype Inter) is gedeeld."""
    naam: str                      # in de bronstrook rechts, bv. "eendje.be"
    accent: str                    # etiketkleur en streep bij de feiten, bv. "#0F52B4"
    donker_rgb: str                # "15,23,43": balk en verloop onder de foto; ook de donkere achtergrond
    logo: str = ""                 # inline svg (40x40 in het etiket, 150x150 op het slot)
    donker: str = "#0F172B"        # effen achtergrond van de foto-slide
    verloop: str = ""              # css-achtergrond voor feiten en slot; leeg = donker
    licht: str = "#BFD3F2"         # gedempte tekst op donker
    bron: str = "Uit"              # "Uit: <titel>"
    slot_kop: str = "Het hele artikel"
    slot_noot: str = "link in bio"

    @property
    def achtergrond(self):
        return self.verloop or self.donker


def basis_css(achtergrond, merk):
    """Kop van elke kaart: lettertype, foto-laag, etiket en bronstrook."""
    return f'''<!doctype html><meta charset=utf-8><style>
@font-face{{font-family:I;src:url({INTER});font-weight:100 900}}
*{{margin:0;box-sizing:border-box}}body{{width:{BREED}px;height:{HOOG}px;position:relative;overflow:hidden;font-family:I;
background:{achtergrond}}}
.f{{position:absolute;inset:0;width:{BREED}px;height:{HOOG}px;object-fit:cover}}
.e{{display:inline-flex;align-items:center;gap:12px;height:64px;padding:0 28px 0 20px;border-radius:14px;background:{merk.accent};
color:#fff;font:800 28px/1 I;letter-spacing:.06em}}
.b{{position:absolute;left:0;right:0;bottom:0;height:112px;padding:0 72px;display:flex;align-items:center;justify-content:space-between;
background:rgba({merk.donker_rgb},.9);color:#F9FAFB;font:600 26px/1.2 I}}.b strong{{font-weight:700;font-size:28px}}</style>'''


def _strip(titel, merk):
    return '<div class=b><span>%s: %s</span><strong>%s</strong></div>' % (
        _html.escape(merk.bron), _html.escape(kort(titel)), _html.escape(merk.naam))


def html_feitkaart(feit, titel, categorie, foto, merk):
    """Kaart 1: foto full-bleed met verloop, etiket en het feit als kop; zonder foto (None) op de merkachtergrond."""
    e = _html.escape
    grootte = 76 if len(feit) <= 70 else 68
    zonder = foto is None
    beeld = "" if zonder else '<img class=f src="%s"><div class=g></div>' % foto
    bodem = "bottom:170px" if not zonder else "top:330px"
    d = merk.donker_rgb
    return f'''<!doctype html><meta charset=utf-8><style>
@font-face{{font-family:I;src:url({INTER});font-weight:100 900}}
*{{margin:0;box-sizing:border-box}}body{{width:{BREED}px;height:{HOOG}px;position:relative;overflow:hidden;font-family:I;
background:{merk.achtergrond if zonder else merk.donker}}}
.f{{position:absolute;inset:0;width:{BREED}px;height:{HOOG}px;object-fit:cover}}
.g{{position:absolute;inset:0;background:linear-gradient(to top,rgba({d},.88) 0%,rgba({d},.60) 38%,rgba({d},0) 62%)}}
.w{{position:absolute;left:72px;{bodem};width:936px}}
.e{{display:inline-flex;align-items:center;gap:12px;height:64px;padding:0 28px 0 20px;border-radius:14px;background:{merk.accent};
color:#fff;font:800 28px/1 I;letter-spacing:.06em;margin-bottom:24px}}
h1{{font:800 {grootte if not zonder else grootte + 8}px/1.06 I;color:#fff;text-shadow:0 2px 12px rgba({d},.6);letter-spacing:-1px}}
.b{{position:absolute;left:0;right:0;bottom:0;height:112px;padding:0 72px;display:flex;align-items:center;justify-content:space-between;
background:rgba({d},.9);color:#F9FAFB;font:600 26px/1.2 I}}.b strong{{font-weight:700;font-size:28px}}</style>
{beeld}<div class=w><div class=e>{merk.logo}{e(categorie)}</div><h1>{e(feit)}</h1></div>
<div class=b><span>{e(merk.bron)}: {e(kort(titel))}</span><strong>{e(merk.naam)}</strong></div>'''


def html_foto(foto, titel, merk):
    """Slide 2: de foto, zonder tekst erover, met enkel de bronstrook."""
    return basis_css(merk.donker, merk) + '<img class=f src="%s">' % foto + _strip(titel, merk)


def html_feiten(feiten, titel, categorie, merk):
    """Slide 3: de aanvullende feiten, woordelijk, op de merkachtergrond."""
    e = _html.escape
    grootte = 58 if max(len(f) for f in feiten) <= 80 else 50
    blokken = "".join('<p style="border-left:10px solid %s;padding:4px 0 4px 32px;margin:0 0 56px;'
                      'font:800 %dpx/1.12 I;color:#fff;letter-spacing:-.5px">%s</p>' % (merk.accent, grootte, e(f))
                      for f in feiten)
    return (basis_css(merk.achtergrond, merk) + '<div style="position:absolute;left:72px;top:150px;width:936px">'
            '<div class=e style="margin-bottom:72px">%s%s</div>%s</div>' % (merk.logo, e(categorie), blokken)
            + _strip(titel, merk))


def html_slot(titel, categorie, merk):
    """Slide 4: waar het hele artikel staat."""
    e = _html.escape
    groot = merk.logo.replace('width="40" height="40"', 'width="150" height="150"')
    return (basis_css(merk.achtergrond, merk) + '<div style="position:absolute;left:72px;top:300px;width:936px">%s'
            '<div style="font:600 34px/1.3 I;color:%s;margin:64px 0 20px">%s</div>'
            '<h1 style="font:800 72px/1.06 I;color:#fff;letter-spacing:-1px">%s</h1>'
            '<div style="margin-top:72px;font:800 44px/1 I;color:#fff">%s</div>'
            '<div style="margin-top:16px;font:600 30px/1.2 I;color:%s">%s</div></div>'
            % (groot, merk.licht, e(merk.slot_kop), e(titel or ""), e(merk.naam), merk.licht, e(merk.slot_noot)))


# ---------------------------------------------------------------- renderen en uploaden

def chrome_pad(pw_cache):
    """Pad van chrome-headless-shell BINNEN de container (de cache staat daar op /pw-cache)."""
    kand = sorted(glob.glob(os.path.join(pw_cache, "chromium_headless_shell-*", "chrome-headless-shell-linux64",
                                         "chrome-headless-shell")))
    if not kand:
        raise RuntimeError("geen chrome-headless-shell in %s (draai eerst een smoke)" % pw_cache)
    return "/pw-cache/" + os.path.relpath(kand[-1], pw_cache).replace(os.sep, "/")


def render_html(html_tekst, uit_jpg, *, fonts, pw_cache, image, foto_url=None,
                ua="Mozilla/5.0 (compatible; holie-kaart)", breed=BREED, hoog=HOOG):
    """Rendert `html_tekst` naar `uit_jpg` (JPEG) met chrome-headless-shell in docker, zonder netwerk.

    `fonts`: map met de woff2-bestanden, wordt naast de HTML gezet. `foto_url`: wordt eerst op de host opgehaald (de
    renderer heeft geen netwerk) en in de HTML vervangen door het lokale bestand. Geeft `uit_jpg`."""
    werk = tempfile.mkdtemp(prefix="holie-kaart-")
    try:
        os.chmod(werk, 0o777)
        for f in os.listdir(fonts):
            shutil.copy(os.path.join(fonts, f), werk)
        if foto_url:
            ext = os.path.splitext(foto_url.split("?")[0])[1] or ".jpg"
            vraag = urllib.request.Request(foto_url, headers={"User-Agent": ua})  # Cloudflare: 403 op Python-urllib
            with urllib.request.urlopen(vraag, timeout=30) as r, open(os.path.join(werk, "foto" + ext), "wb") as f:
                f.write(r.read())
            html_tekst = html_tekst.replace(foto_url, "foto" + ext)
        with open(os.path.join(werk, "k.html"), "w", encoding="utf-8") as f:
            f.write(html_tekst)
        subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", werk + ":/w",
                        "-v", pw_cache + ":/pw-cache:ro", "--entrypoint", chrome_pad(pw_cache), image,
                        "--no-sandbox", "--hide-scrollbars", "--force-device-scale-factor=1",
                        "--window-size=%d,%d" % (breed, hoog), "--virtual-time-budget=3000",
                        "--screenshot=/w/k.jpg", "file:///w/k.html"],
                       capture_output=True, timeout=120, check=False)
        uit = os.path.join(werk, "k.jpg")
        if not os.path.exists(uit) or os.path.getsize(uit) < 20000:
            raise RuntimeError("render gaf geen bruikbare jpg")
        shutil.copy(uit, uit_jpg)
    finally:
        shutil.rmtree(werk, ignore_errors=True)
    return uit_jpg


def lees_env(pad, basis=None):
    """KEY=waarde-regels uit een env-bestand bovenop `basis` (standaard os.environ); commentaar wordt overgeslagen."""
    env = dict(os.environ if basis is None else basis)
    with open(pad, encoding="utf-8") as f:
        for regel in f:
            if "=" in regel and not regel.lstrip().startswith("#"):
                k, v = regel.rstrip("\n").split("=", 1)
                env[k.strip()] = v.strip().strip('"')
    return env


def upload_r2(jpg, sleutel, *, env_pad, cdn):
    """Zet de kaart in R2 (bucket uit R2_BUCKET van `env_pad`); geeft de publieke URL `cdn/sleutel`.
    De sleutels komen nooit in een log of foutmelding."""
    env = lees_env(env_pad)
    env.update(AWS_ACCESS_KEY_ID=env["R2_ACCESS_KEY_ID"], AWS_SECRET_ACCESS_KEY=env["R2_SECRET_ACCESS_KEY"],
               AWS_DEFAULT_REGION="auto")
    r = subprocess.run(["aws", "s3", "cp", jpg, "s3://%s/%s" % (env["R2_BUCKET"], sleutel), "--only-show-errors",
                        "--content-type", "image/jpeg", "--cache-control", "public, max-age=31536000, immutable",
                        "--endpoint-url", "https://%s.r2.cloudflarestorage.com" % env["R2_ACCOUNT_ID"]],
                       env=env, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError("R2-upload faalde (rc %d)" % r.returncode)
    return "%s/%s" % (cdn, sleutel)
