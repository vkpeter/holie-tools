#!/bin/bash
# Zet @holie/tools in meerdere apps op dezelfde versie, met een lockfile die meegroeit.
# Per repo: package.json-versie zetten, `bun install` (bun.lock groeit mee), `bun install --frozen-lockfile` als controle,
# dan package.json + bun.lock SAMEN in een commit (Peter <ai@holie.be>, nooit een Co-Authored-By-trailer).
# Aanleiding 10 nov 2026: Hapklik kreeg ^0.30.1 in package.json maar bun.lock bleef op 0.28.1; de smoke brak pas 's nachts.
#
#   scripts/bump-apps.sh <versie> <repo>...                 droog (standaard): toont wat er zou gebeuren, wijzigt niets
#   scripts/bump-apps.sh --uitvoeren <versie> <repo>...     echt bumpen en lokaal committen
#   scripts/bump-apps.sh --uitvoeren --push <versie> <repo>...   ook `git push origin <branch>` per repo
#
# <repo> is een map of een naam onder ~/Apps (bv. hapklik). Pushen kost per app een VPS-build: bundel liever zelf.
set -uo pipefail
UIT=; PUSH=
while [ $# -gt 0 ]; do
  case $1 in --uitvoeren) UIT=1 ;; --droog) UIT= ;; --push) PUSH=1 ;; -h|--help) sed -n '2,12p' "$0"; exit 0 ;; *) break ;; esac
  shift
done
VERSIE=${1:-}; shift || true
[[ $VERSIE =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "geef een versie als 0.33.1"; sed -n '6,9p' "$0"; exit 2; }
[ $# -gt 0 ] || { echo "geef minstens een repo"; exit 2; }
[ -z "$PUSH" ] || [ -n "$UIT" ] || { echo "--push werkt enkel samen met --uitvoeren"; exit 2; }
APPS=${APPS_MAP:-$HOME/Apps}
RE='("@holie/tools": *"npm:@jsr/holie__tools@\^?)[0-9]+\.[0-9]+\.[0-9]+'

[ -n "$UIT" ] && echo "MODUS: uitvoeren (lokaal committen${PUSH:+, pushen})" || echo "MODUS: droog (niets wordt gewijzigd; --uitvoeren om echt te bumpen)"
fouten=0
for R in "$@"; do
  D=$R; [ -d "$D" ] || D=$APPS/$R
  echo "== $R"
  fout() { echo "   OVERGESLAGEN: $1"; fouten=$((fouten + 1)); }
  [ -f "$D/package.json" ] || { fout "geen package.json in $D"; continue; }
  grep -qE "$RE" "$D/package.json" || { fout "geen @holie/tools (npm:@jsr/holie__tools@^...) in package.json"; continue; }
  HUIDIG=$(grep -oE "$RE" "$D/package.json" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+$')
  [ "$HUIDIG" != "$VERSIE" ] || { echo "   al op $VERSIE"; continue; }
  [ -f "$D/bun.lock" ] || { fout "geen bun.lock (deze repo gebruikt geen bun)"; continue; }
  LOCKVERS=$(grep -oE '"@holie/tools": \["@jsr/holie__tools@[0-9.]+' "$D/bun.lock" | grep -oE '[0-9.]+$' | head -1)
  BRANCH=$(git -C "$D" rev-parse --abbrev-ref HEAD 2>/dev/null) || { fout "geen git-repo"; continue; }
  VUIL=$(git -C "$D" status --porcelain -- package.json bun.lock)
  [ -z "$VUIL" ] || { fout "package.json of bun.lock heeft al onopgeslagen wijzigingen (van een andere sessie?): $VUIL"; continue; }
  echo "   package.json ^$HUIDIG -> ^$VERSIE, bun.lock nu ${LOCKVERS:-?}, branch $BRANCH"
  [ -f "$D/package-lock.json" ] && echo "   let op: package-lock.json bestaat ook en wordt NIET aangepast (npm ci in CI leest die)"
  if [ -z "$UIT" ]; then
    echo "   zou doen: sed package.json; bun install; bun install --frozen-lockfile; git commit -- package.json bun.lock${PUSH:+; push}"
    continue
  fi
  cp "$D/package.json" "$D/package.json.bump-bak"; cp "$D/bun.lock" "$D/bun.lock.bump-bak"
  herstel() { mv -f "$D/package.json.bump-bak" "$D/package.json"; mv -f "$D/bun.lock.bump-bak" "$D/bun.lock"; }
  sed -i -E "s|$RE|\1$VERSIE|" "$D/package.json" && grep -q "holie__tools@^$VERSIE" "$D/package.json" || { herstel; fout "sed op package.json faalde; teruggezet"; continue; }
  if ! (cd "$D" && bun install >/dev/null 2>&1); then herstel; fout "bun install faalde (bestaat holie-tools $VERSIE op JSR?); teruggezet"; continue; fi
  if ! (cd "$D" && bun install --frozen-lockfile >/dev/null 2>&1); then herstel; fout "bun install --frozen-lockfile faalde na de bump; teruggezet"; continue; fi
  rm -f "$D/package.json.bump-bak" "$D/bun.lock.bump-bak"
  if git -C "$D" diff --quiet -- bun.lock; then echo "   bun.lock bleef gelijk (onverwacht), niet gecommit"; fouten=$((fouten + 1)); continue; fi
  git -C "$D" add -- package.json bun.lock
  git -C "$D" -c user.name=Peter -c user.email=ai@holie.be commit -q -m "@holie/tools $VERSIE (package.json en bun.lock samen)" -- package.json bun.lock \
    || { fout "commit faalde"; continue; }
  echo "   gecommit: $(git -C "$D" log -1 --format=%h)"
  if [ -n "$PUSH" ]; then git -C "$D" push origin "$BRANCH" || fout "push faalde"; fi
done
[ "$fouten" -eq 0 ] || { echo "klaar met $fouten melding(en)"; exit 1; }
echo klaar
