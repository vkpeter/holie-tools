#!/bin/bash
# Zet @holie/tools in meerdere apps op dezelfde versie, met lockfiles en imports die meegroeien.
# Per repo wordt gevolgd wat er echt is:
#   package.json   "@holie/tools": "npm:@jsr/holie__tools@^x" of "@jsr/holie__tools": "^x" (of geen entry: dan wordt het overgeslagen)
#   bun.lock       -> bun install + bun install --frozen-lockfile (controle)
#   package-lock   -> npm install --package-lock-only + controle dat de lock de nieuwe versie bevat
#                     (beide lockfiles aanwezig -> beide)
#   MCP-bundel     heeft package.json een script bundle:mcp, dan wordt supabase/functions/mcp/index.ts opnieuw gebouwd
#   imports        alle jsr:@holie/tools@... in supabase/functions (.ts, .tsx, deno.json, import_map.json) -> ^versie
#   deno.lock      in de repo-root en/of supabase/functions, enkel als er @holie/tools in staat: vernieuwd met
#                  `deno cache --frozen=false` op de bestanden met imports, daarna `--frozen` als controle.
#                  Lukt dat niet, dan staat er "deno.lock niet bijgewerkt" en blijft het bestand onaangeroerd.
#                  Een deno.lock die git negeert wordt wel bijgewerkt maar niet gecommit.
# Daarna worden enkel de bestanden die het script zelf wijzigde gecommit (expliciete paden, Peter <ai@holie.be>,
# nooit een Co-Authored-By-trailer). Staat een repo al overal op de versie: "al op <versie>", niets doen.
# Aanleiding 10-11 nov 2026: Hapklik kreeg ^0.30.1 in package.json maar bun.lock bleef op 0.28.1; billaraapp,
# phyllox, roundbook en holie hadden een andere vorm en moesten met de hand.
#
#   scripts/bump-apps.sh <versie> <repo>...                 droog (standaard): toont wat er zou gebeuren, wijzigt niets
#   scripts/bump-apps.sh --uitvoeren <versie> <repo>...     echt bumpen en lokaal committen
#   scripts/bump-apps.sh --uitvoeren --push <versie> <repo>...   ook `git push origin <branch>` per repo
#
# <repo> is een map of een naam onder ~/Apps (bv. hapklik). Pushen kost per app een VPS-build: bundel liever zelf.
set -uo pipefail
hulp() { sed -n '2,/^set /p' "$0" | grep '^#'; }
UIT=; PUSH=
while [ $# -gt 0 ]; do
  case $1 in --uitvoeren) UIT=1 ;; --droog) UIT= ;; --push) PUSH=1 ;; -h|--help) hulp; exit 0 ;; *) break ;; esac
  shift
done
VERSIE=${1:-}; shift || true
[[ $VERSIE =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "geef een versie als 0.33.1"; hulp | tail -4; exit 2; }
[ $# -gt 0 ] || { echo "geef minstens een repo"; exit 2; }
[ -z "$PUSH" ] || [ -n "$UIT" ] || { echo "--push werkt enkel samen met --uitvoeren"; exit 2; }
APPS=${APPS_MAP:-$HOME/Apps}
PRE='("@holie/tools": *"npm:@jsr/holie__tools@|"@jsr/holie__tools": *")'
RE="${PRE}[~^]?[0-9]+\.[0-9]+\.[0-9]+"
IMP='jsr:@holie/tools@[~^]?[0-9]+(\.[0-9]+){1,2}'
GOED="jsr:@holie/tools@^$VERSIE"

[ -n "$UIT" ] && echo "MODUS: uitvoeren (lokaal committen${PUSH:+, pushen})" || echo "MODUS: droog (niets wordt gewijzigd; --uitvoeren om echt te bumpen)"
fouten=0
# versie van @jsr/holie__tools in package-lock.json ('' als afwezig)
pl_versie() { node -e 'try{const l=require(require("path").resolve(process.argv[1]));const v=Object.entries(l.packages||{}).filter(([k,p])=>/^node_modules\/(@jsr\/holie__tools|@holie\/tools)$/.test(k)||p.name==="@jsr/holie__tools").map(([k,p])=>p.version);console.log(v[0]||"")}catch(e){console.log("")}' "$1"; }
for R in "$@"; do
  D=$R; [ -d "$D" ] || D=$APPS/$R
  echo "== $R"
  fout() { echo "   OVERGESLAGEN: $1"; fouten=$((fouten + 1)); }
  [ -d "$D" ] || { fout "map $D bestaat niet"; continue; }
  BRANCH=$(git -C "$D" rev-parse --abbrev-ref HEAD 2>/dev/null) || { fout "geen git-repo"; continue; }

  # --- wat is er? ---
  PKG=; PKGVERS=
  if [ -f "$D/package.json" ] && grep -qE "$RE" "$D/package.json"; then
    PKG=1; PKGVERS=$(grep -oE "$RE" "$D/package.json" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
  fi
  IMPORTS=()
  if [ -d "$D/supabase/functions" ]; then
    while IFS= read -r f; do IMPORTS+=("$f"); done < <(cd "$D" && find supabase/functions -type f \( -name '*.ts' -o -name '*.tsx' -o -name deno.json -o -name import_map.json \) -not -path '*/node_modules/*' -print0 | xargs -0 -r grep -lE "$IMP" 2>/dev/null | sort)
  fi
  [ -n "$PKG" ] || [ ${#IMPORTS[@]} -gt 0 ] || { fout "geen @holie/tools in package.json en geen jsr:@holie/tools-imports in supabase/functions"; continue; }

  TEDOEN=()       # beschrijving van wat er moet gebeuren
  KANDIDATEN=()   # bestanden (relatief) die het script mag wijzigen
  BUN=; NPM=; BUNV=; NPMV=
  if [ -n "$PKG" ]; then
    [ "$PKGVERS" = "$VERSIE" ] || TEDOEN+=("package.json ^$PKGVERS -> ^$VERSIE")
    KANDIDATEN+=(package.json)
    if [ -f "$D/bun.lock" ]; then
      BUN=1; BUNV=$(grep -oE 'holie__tools@[0-9]+\.[0-9]+\.[0-9]+' "$D/bun.lock" | grep -oE '[0-9.]+$' | head -1)
      [ "$BUNV" = "$VERSIE" ] || TEDOEN+=("bun.lock ${BUNV:-?} -> $VERSIE (bun install + --frozen-lockfile)")
      KANDIDATEN+=(bun.lock)
    fi
    if [ -f "$D/package-lock.json" ]; then
      NPM=1; NPMV=$(pl_versie "$D/package-lock.json")
      [ "$NPMV" = "$VERSIE" ] || TEDOEN+=("package-lock.json ${NPMV:-?} -> $VERSIE (npm install --package-lock-only)")
      KANDIDATEN+=(package-lock.json)
    fi
    [ -n "$BUN" ] || [ -n "$NPM" ] || echo "   let op: geen bun.lock of package-lock.json; enkel package.json wordt aangepast"
  fi
  NIETGOED=()
  for f in "${IMPORTS[@]+"${IMPORTS[@]}"}"; do
    if grep -oE "$IMP" "$D/$f" | sort -u | grep -qvxF "$GOED"; then NIETGOED+=("$f"); fi
  done
  if [ ${#NIETGOED[@]} -gt 0 ]; then
    TEDOEN+=("${#NIETGOED[@]} van ${#IMPORTS[@]} bestanden met jsr:@holie/tools-imports -> ^$VERSIE")
  fi
  KANDIDATEN+=("${IMPORTS[@]+"${IMPORTS[@]}"}")
  # deno.lock: enkel als er imports zijn en er @holie/tools in de lock staat
  DLOCKS=(); DLOCKTE=()
  if [ ${#IMPORTS[@]} -gt 0 ]; then
    for L in deno.lock supabase/functions/deno.lock; do
      [ -f "$D/$L" ] && grep -q 'holie/tools' "$D/$L" || continue
      DLOCKS+=("$L")
      if ! grep -q "\"@holie/tools@$VERSIE\"" "$D/$L"; then
        DLOCKTE+=("$L"); TEDOEN+=("$L vernieuwen (deno cache --frozen=false)")
      fi
      KANDIDATEN+=("$L")
    done
  fi

  # repo's met een gebundelde MCP-server (bv. hapklik): de pre-commit-hook eist een verse bundel
  BUNDEL=
  if [ ${#TEDOEN[@]} -gt 0 ] && [ -n "$PKG" ] && grep -q '"bundle:mcp"' "$D/package.json" && [ -f "$D/supabase/functions/mcp/index.ts" ]; then
    BUNDEL=1; TEDOEN+=("npm run bundle:mcp (supabase/functions/mcp/index.ts opnieuw bouwen)"); KANDIDATEN+=(supabase/functions/mcp/index.ts)
  fi
  if [ ${#TEDOEN[@]} -eq 0 ]; then echo "   al op $VERSIE"; continue; fi
  echo "   branch $BRANCH; te doen:"
  for t in "${TEDOEN[@]}"; do echo "     - $t"; done
  [ ${#NIETGOED[@]} -eq 0 ] || { printf '       import-bestanden: %s\n' "${NIETGOED[@]:0:3}"; [ ${#NIETGOED[@]} -le 3 ] || echo "       ... en $((${#NIETGOED[@]} - 3)) meer"; }
  if [ -z "$UIT" ]; then
    echo "   zou doen: wijzigen, controleren, committen van enkel de gewijzigde bestanden${PUSH:+; push}"
    continue
  fi

  # --- uitvoeren ---
  VUIL=$(git -C "$D" status --porcelain -- "${KANDIDATEN[@]}")
  [ -z "$VUIL" ] || { fout "te wijzigen bestanden hebben al onopgeslagen wijzigingen (van een andere sessie?): $VUIL"; continue; }
  BAK=$(mktemp -d)
  for f in "${KANDIDATEN[@]}"; do [ -f "$D/$f" ] && { mkdir -p "$BAK/$(dirname "$f")"; cp -p "$D/$f" "$BAK/$f"; }; done
  herstel() { for f in "${KANDIDATEN[@]}"; do [ -f "$BAK/$f" ] && cp -p "$BAK/$f" "$D/$f"; done; }
  stop() { herstel; fout "$1; teruggezet"; }
  ok=1
  if [ -n "$PKG" ]; then
    sed -i -E "s#${RE}#\1^$VERSIE#" "$D/package.json"
    grep -qE "${PRE}\^$VERSIE\"" "$D/package.json" || { stop "sed op package.json faalde"; continue; }
    if [ -n "$BUN" ]; then
      (cd "$D" && bun install >/dev/null 2>&1) || { stop "bun install faalde (bestaat holie-tools $VERSIE op JSR?)"; continue; }
      (cd "$D" && bun install --frozen-lockfile >/dev/null 2>&1) || { stop "bun install --frozen-lockfile faalde na de bump"; continue; }
      [ "$(grep -oE 'holie__tools@[0-9]+\.[0-9]+\.[0-9]+' "$D/bun.lock" | grep -oE '[0-9.]+$' | head -1)" = "$VERSIE" ] || { stop "bun.lock bevat $VERSIE niet na bun install"; continue; }
    fi
    if [ -n "$NPM" ]; then
      (cd "$D" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) || { stop "npm install --package-lock-only faalde (bestaat holie-tools $VERSIE op JSR?)"; continue; }
      [ "$(pl_versie "$D/package-lock.json")" = "$VERSIE" ] || { stop "package-lock.json bevat $VERSIE niet na npm install"; continue; }
    fi
  fi
  for f in "${NIETGOED[@]+"${NIETGOED[@]}"}"; do
    sed -i -E "s#${IMP}#${GOED}#g" "$D/$f"
  done
  if [ ${#IMPORTS[@]} -gt 0 ] && grep -rhoE "$IMP" "${IMPORTS[@]/#/$D/}" | sort -u | grep -qvxF "$GOED"; then stop "imports staan niet allemaal op ^$VERSIE na sed"; continue; fi
  if [ -n "$BUNDEL" ]; then
    (cd "$D" && npm run bundle:mcp >/dev/null 2>&1) || { stop "npm run bundle:mcp faalde"; continue; }
  fi
  for L in "${DLOCKTE[@]+"${DLOCKTE[@]}"}"; do
    LD=$(dirname "$D/$L"); LB=$(basename "$L")
    # bestanden met imports, relatief aan de map van de lock
    REL=(); for f in "${IMPORTS[@]}"; do case $f in *.ts|*.tsx) REL+=("$(realpath --relative-to="$LD" "$D/$f")") ;; esac; done
    if (cd "$LD" && deno cache --lock="$LB" --frozen=false "${REL[@]}" >/dev/null 2>&1) \
       && grep -q "\"@holie/tools@$VERSIE\"" "$LD/$LB" \
       && (cd "$LD" && deno cache --lock="$LB" --frozen "${REL[@]}" >/dev/null 2>&1); then
      echo "   $L bijgewerkt"
    else
      cp -p "$BAK/$L" "$D/$L"; echo "   WAARSCHUWING: $L niet bijgewerkt (deno cache faalde of de lock mist $VERSIE); bestand teruggezet, vernieuw met de hand"; fouten=$((fouten + 1))
    fi
  done
  # enkel wat echt wijzigde en door git gevolgd wordt
  COMMIT=()
  for f in "${KANDIDATEN[@]}"; do
    git -C "$D" ls-files --error-unmatch -- "$f" >/dev/null 2>&1 || { [ -f "$D/$f" ] && git -C "$D" check-ignore -q -- "$f" && echo "   $f wordt door git genegeerd: bijgewerkt maar niet gecommit"; continue; }
    git -C "$D" diff --quiet -- "$f" || COMMIT+=("$f")
  done
  rm -rf "$BAK"
  [ ${#COMMIT[@]} -gt 0 ] || { echo "   niets gewijzigd (onverwacht), niet gecommit"; fouten=$((fouten + 1)); continue; }
  git -C "$D" add -- "${COMMIT[@]}"
  git -C "$D" -c user.name=Peter -c user.email=ai@holie.be commit -q -m "@holie/tools $VERSIE (package.json, lockfiles en imports samen)" -- "${COMMIT[@]}" \
    || { fout "commit faalde"; continue; }
  echo "   gecommit: $(git -C "$D" log -1 --format=%h) (${#COMMIT[@]} bestanden)"
  if [ -n "$PUSH" ]; then git -C "$D" push origin "$BRANCH" || fout "push faalde"; fi
done
[ "$fouten" -eq 0 ] || { echo "klaar met $fouten melding(en)"; exit 1; }
echo klaar
