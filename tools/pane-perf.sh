#!/bin/sh
# Jump the tablet to each pane (via deckd's Studio API), let the swipe settle,
# then print two clean 300-frame "tick cost" windows from logcat and save a
# screenshot. Usage: tools/pane-perf.sh [tag] [panes...]
TAG=${1:-perf}; [ $# -gt 0 ] && shift
PANES=${*:-"home claude pulse deck music board focus system"}
TOKEN=$(curl -s http://127.0.0.1:7778/ | sed -n 's/.*name="deck-token" content="\([^"]*\)".*/\1/p')
OUT=$(dirname "$0")/../shots
for p in $PANES; do
  curl -s -X POST -H "x-deck-token: $TOKEN" -H 'content-type: application/json' -d "{\"pane\":\"$p\"}" http://127.0.0.1:7778/api/nav >/dev/null
  sleep 6                      # the first window after a switch includes the swipe
  adb logcat -c; sleep 10.6    # two 5 s windows
  adb logcat -d -s pocketjs:V | grep "tick cost" | tail -2 | sed "s/.*tick cost: /$p: /"
  adb exec-out screencap -p > "$OUT/$TAG-$p.png"
done
