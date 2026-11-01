#!/usr/bin/env python3
"""Zet het centrale AI-beleid om naar het model van Merlin (OpenClaw op de Pi).

Leest het ondertekende beleid (holie_ai_beleid.py, zelfde map), kiest de volgorde voor
project `merlin` (gegevens prive-peter, type tools: Merlin roept tools aan) en schrijft die
als `agents.defaults.model.primary` + `fallbacks` in /config/.openclaw/openclaw.json, ENKEL
als er iets verandert. OpenClaw laadt die wijziging live.

Draait als OpenClaw-cron van het soort `command` (geen LLM), stil als er niets verandert;
bij een wijziging één regel uitvoer (komt via Telegram bij Peter). Laat het beleid niets
over, dan blijft de config staan en meldt het script dat (exit 1).

    python3 merlin_beleid.py            gewone run
    python3 merlin_beleid.py --droog    toont wat het zou schrijven, schrijft niets

Bron: holie-tools/beleid/python/ (hier niet bewerken; kopie op de Pi in
/config/.openclaw/scripts/).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import holie_ai_beleid as hab  # noqa: E402

CONFIG = Path(os.environ.get("OPENCLAW_CONFIG", "/config/.openclaw/openclaw.json"))
os.environ.setdefault("HOLIE_AI_BELEID_CACHE", str(CONFIG.parent / "ai-beleid-cache.json"))

# Beleidsprovider -> model in OpenClaw. Een provider zonder regel kan Merlin niet gebruiken.
MODELLEN = {
    "anthropic": "anthropic/claude-haiku-5-5",
    "deepseek": "custom-api-deepseek-com/deepseek-v4-flash",
    "gemini": "google/gemini-2.5-flash",
}


def gewenst(beleid: dict) -> dict:
    uitslag = hab.kies_providers(beleid, type="tools", project="merlin",
                                 gegevens="prive-peter", volgorde=list(MODELLEN),
                                 heeft_sleutel=lambda p: p in MODELLEN)
    modellen = [MODELLEN[p] for p in uitslag["volgorde"]]
    return {"primary": modellen[0], "fallbacks": modellen[1:]}


def main() -> int:
    droog = "--droog" in sys.argv
    beleid = hab.huidig_beleid("merlin")
    try:
        nieuw = gewenst(beleid)
    except hab.BeleidLeeg as e:
        print(f"Merlin: {e}. Model NIET gewijzigd.")
        return 1
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    huidig = config.get("agents", {}).get("defaults", {}).get("model", {})
    if huidig.get("primary") == nieuw["primary"] and \
            list(huidig.get("fallbacks") or []) == nieuw["fallbacks"]:
        if droog:
            print(f"ongewijzigd (beleid {beleid['volgnummer']}): {nieuw}")
        return 0
    if droog:
        print(f"zou schrijven (beleid {beleid['volgnummer']}): {huidig} -> {nieuw}")
        return 0
    shutil.copy2(CONFIG, CONFIG.with_name(CONFIG.name + f".voor-beleid-{int(time.time())}"))
    config.setdefault("agents", {}).setdefault("defaults", {}).setdefault("model", {}).update(nieuw)
    tijdelijk = CONFIG.with_name(CONFIG.name + ".nieuw")
    tijdelijk.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tijdelijk, CONFIG)
    print(f"Merlin-model aangepast door AI-beleid {beleid['volgnummer']}: "
          f"{nieuw['primary']}, daarna {', '.join(nieuw['fallbacks']) or 'niets'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
