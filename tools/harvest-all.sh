#!/bin/zsh
# Harvest a whole list to completion, unattended.
#
# One harvest-batch pass walks the list top to bottom: it skips a show whose
# TMDB seasons are already fully stored and tops up the rest, in list order.
# A pass ends early only when Chrome dies (lid closed), the site challenges, or
# the run is killed - so this loops the pass with a pause, and stops once two
# passes in a row add no catalogue rows at all (transient site failures also add
# none, hence two). Every pass is committed and pushed, so a killed run loses at
# most the one show it was in the middle of, and the TV sees each sitting.
#
# usage: nohup tools/harvest-all.sh [list] [log] &
set -u
cd "$(dirname "$0")/.."

LIST="${1:-tools/shows-all.txt}"
LOG="${2:-tools/.run-all.log}"
KEY=$(grep -m1 '^TMDB_API_KEY=' ../NuvioTV-dev/local.properties | cut -d= -f2-)
[ -z "$KEY" ] && { echo "=== no TMDB_API_KEY in ../NuvioTV-dev/local.properties" | tee -a "$LOG"; exit 1; }

rows() {
  node -e "const f=require('fs');let n=0;for(const x of f.readdirSync('catalogue'))if(x.endsWith('.json')&&x!=='index.json')n+=JSON.parse(f.readFileSync('catalogue/'+x,'utf8')).rows.length;process.stdout.write(''+n)"
}

PROFILE="tools/.chrome-profile"
PORT=9334
# A leftover Chrome holds the profile and the debug port. A fresh launch then
# hands off to it and exits, and the page the batch was driving vanishes under
# it ("chrome window closed"), which ends the pass with nothing done. Start each
# pass from nothing: kill what is left and wait for the port to stop answering.
clean_chrome() {
  pkill -f "user-data-dir=.*chrome-profile" 2>/dev/null
  for i in {1..60}; do
    curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
}

echo "=== harvest-all start $(date '+%F %T') list=$LIST (pid $$)" >> "$LOG"
stale=0
while :; do
  before=$(rows)
  echo "=== pass start $(date '+%F %T') rows=$before" >> "$LOG"
  clean_chrome
  TMDB_API_KEY="$KEY" node tools/harvest-batch.mjs \
    --file "$LIST" --all-seasons --max-eps 0 \
    --wait-429 15 --wait-challenge 300 --min-gap-ms 1200 \
    --profile "$PROFILE" --port "$PORT" >> "$LOG" 2>&1
  after=$(rows)
  echo "=== pass end $(date '+%F %T') rows=$after (+$((after-before)))" >> "$LOG"
  if [ -n "$(git status --porcelain catalogue)" ]; then
    git add catalogue
    git commit -q -m "catalogue: harvest $(date '+%F %H:%M')" && git push -q origin main
    echo "=== pushed $(date '+%T')" >> "$LOG"
  fi
  if [ "$after" -le "$before" ]; then
    stale=$((stale+1))
    echo "=== no rows added (stale $stale/3)" >> "$LOG"
    [ "$stale" -ge 3 ] && { echo "=== stopping $(date '+%F %T')" >> "$LOG"; break; }
    sleep 600
  else
    stale=0
    sleep 20
  fi
done
