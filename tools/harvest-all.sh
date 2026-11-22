#!/bin/zsh
# Harvest a whole list to completion, unattended.
#
# One harvest-batch pass walks the list top to bottom: it skips a show whose
# TMDB seasons are already fully stored and tops up the rest, in list order.
# A pass ends early only when Chrome dies (lid closed), the site challenges, or
# the rate limit outlasts the wait - so this loops the pass, and only stops when
# a pass walks the list and adds nothing without being cut short.
#
# The pace is owned here, across passes: a pass that hit a 429 starts the next
# one slower, and a clean pass earns a faster one. --min-gap-ms is deliberately
# passed on every pass, because the batch's own learning drifts back to the 600ms
# floor and the site punishes that with 15-minute waits; the pass-level signal is
# the only one that sees the whole cost.
#
# Every pass is committed and pushed, so a killed run loses at most the one show
# it was in the middle of, and the TV sees each sitting.
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

# Start slow. 1200ms is the proven-smooth rate for a healthy connection, but a
# connection that just took two 429s needs more room than that to recover.
SEED=2500
stale=0
echo "=== harvest-all start $(date '+%F %T') list=$LIST (pid $$)" >> "$LOG"
while :; do
  before=$(rows)
  echo "=== pass start $(date '+%F %T') rows=$before gap=${SEED}ms" >> "$LOG"
  clean_chrome
  PASS=$(mktemp)
  TMDB_API_KEY="$KEY" node tools/harvest-batch.mjs \
    --file "$LIST" --all-seasons --max-eps 0 \
    --wait-429 15 --wait-challenge 300 --min-gap-ms "$SEED" \
    --profile "$PROFILE" --port "$PORT" > "$PASS" 2>&1
  cat "$PASS" >> "$LOG"
  after=$(rows)
  echo "=== pass end $(date '+%F %T') rows=$after (+$((after-before)))" >> "$LOG"
  if [ -n "$(git status --porcelain catalogue)" ]; then
    git add catalogue
    git commit -q -m "catalogue: harvest $(date '+%F %H:%M')" && git push -q origin main
    echo "=== pushed $(date '+%T')" >> "$LOG"
  fi
  # A pass cut short by the site or the browser says nothing about the list:
  # it is not evidence of completion, and it is the signal to slow down.
  cut=0
  grep -q "429 too many" "$PASS" && cut=1
  grep -q "rate-limiting this connection" "$PASS" && cut=1
  grep -q "chrome window closed" "$PASS" && cut=1
  # The startup banner says "waiting for the challenge" on every run, so match
  # only the lines that mean the run actually gave up on one.
  grep -qE "^  challenge (did not clear|appeared mid-run)" "$PASS" && cut=1
  rm -f "$PASS"
  if [ "$cut" = 1 ]; then
    SEED=$((SEED * 3 / 2)); [ "$SEED" -gt 20000 ] && SEED=20000
    echo "=== cut short by the site; next pass gap=${SEED}ms" >> "$LOG"
    sleep 600
    continue
  fi
  # Clean pass. A full list that adds nothing is finished - but a single quiet
  # pass can also be a wall of permanent misses, hence two in a row.
  if [ "$after" -le "$before" ]; then
    stale=$((stale+1))
    echo "=== no rows added (stale $stale/2)" >> "$LOG"
    [ "$stale" -ge 2 ] && { echo "=== done $(date '+%F %T')" >> "$LOG"; break; }
    sleep 300
  else
    stale=0
    SEED=$((SEED * 9 / 10)); [ "$SEED" -lt 1200 ] && SEED=1200
  fi
done
