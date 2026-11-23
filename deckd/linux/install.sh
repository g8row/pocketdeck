#!/bin/sh
# Install deskd as a systemd user service for this checkout and start it.
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
[ -x "$BUN" ] || { echo "bun not found (https://bun.sh)"; exit 1; }
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/deskd.service"
mkdir -p "$(dirname "$UNIT")"
sed -e "s|@DESKD_DIR@|$DIR|" -e "s|@BUN@|$BUN|" "$DIR/linux/deskd.service" > "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now deskd.service
echo "deskd installed: $UNIT"
echo "logs: journalctl --user -u deskd -f    studio: http://127.0.0.1:7778/"
