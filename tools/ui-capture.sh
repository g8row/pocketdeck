#!/bin/sh
# Capture every pane of the running deck UI on the tablet as PNGs (what the panel shows, rail included).
#   tools/ui-capture.sh [out-dir] [panes]     default: device/out/work/ui-capture, 6 panes
# Swipes back to the first pane with the tablet's `swipe` injector (it touches a clean spot right of the rail),
# then for each pane asks the UI host to dump its DRM front buffer (SIGUSR1) and converts it with fb2png.py.
set -eu
R=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$R/device/out/work/ui-capture}
N=${2:-6}
TB=$R/tools/tb.sh
mkdir -p "$OUT"
"$TB" "swipe /dev/input/event2 r $N 400" >/dev/null
sleep 2
i=1
while [ "$i" -le "$N" ]; do
	"$TB" 'd=/tmp/pocketjs-front.raw; rm -f $d; kill -USR1 $(pidof pocketjs-kiosk); i=0
		while [ $i -lt 40 ] && [ "$(stat -c %s $d 2>/dev/null)" != 2457600 ]; do sleep 0.05; i=$((i+1)); done; sleep 0.05; cat $d' > "$OUT/pane-$i.raw"
	python3 -I "$R/tools/fb2png.py" "$OUT/pane-$i.raw" "$OUT/pane-$i.png" && rm -f "$OUT/pane-$i.raw"
	echo "$OUT/pane-$i.png"
	[ "$i" -lt "$N" ] && "$TB" "swipe /dev/input/event2 l 1 0" >/dev/null && sleep 1.5
	i=$((i + 1))
done
