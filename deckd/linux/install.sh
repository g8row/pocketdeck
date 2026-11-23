#!/bin/sh
# Install deckd as a systemd user service for this checkout and start it.
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
[ -x "$BUN" ] || { echo "bun not found (https://bun.sh)"; exit 1; }
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/deckd.service"
mkdir -p "$(dirname "$UNIT")"
OLD="$(dirname "$UNIT")/deskd.service"   # unit from before the deskd -> deckd rename
if [ -f "$OLD" ]; then systemctl --user disable --now deskd.service 2>/dev/null || true; rm -f "$OLD"; fi
sed -e "s|@DECKD_DIR@|$DIR|" -e "s|@BUN@|$BUN|" "$DIR/linux/deckd.service" > "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now deckd.service
echo "deckd installed: $UNIT"
echo "logs: journalctl --user -u deckd -f    studio: http://127.0.0.1:7778/"
