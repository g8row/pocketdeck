#!/usr/bin/env bash
# Build PocketJS for the tablet's mainline Alpine and install it as the `pocketjs` OpenRC service.
#   mainline/scripts/pocketjs-deploy.sh [app-manifest]      (default: apps/desk/pocket.json)
# Needs on the host (user-level is fine): rustup + target aarch64-unknown-linux-musl, Zig (cross C compiler for
# QuickJS; ZIG=path, default ~/.local/opt/zig-*/zig), Bun. Links with Rust's own rust-lld + self-contained musl,
# so the binary is static and needs nothing from Alpine.
# Env: TAB=root@172.16.42.1, NO_BUILD=1 (push what is already built), NO_START=1.
set -euo pipefail
# macOS tar would add AppleDouble ._* files for files with extended attributes; harmless elsewhere
export COPYFILE_DISABLE=1
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../pocketjs" && pwd)
OVL=$(cd "$HERE/../rootfs/overlay" && pwd)
MANIFEST=${1:-apps/desk/pocket.json}
TAB=${TAB:-root@172.16.42.1}
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"
ZIG=${ZIG:-$(ls -d "$HOME"/.local/opt/zig-*/zig 2>/dev/null | tail -n1)}
TRIPLE=aarch64-unknown-linux-musl
BIN="$ROOT/hosts/android/target/$TRIPLE/release/pocketjs-kiosk"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
ssh_tab() { ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes "$TAB" "$@"; }

if [ -z "${NO_BUILD:-}" ]; then
	[ -x "$ZIG" ] || { echo "zig not found (set ZIG=)"; exit 1; }
	# zig cc as the C compiler: drop the flags rustc/cc-rs add that zig does not take.
	cat > "$WORK/cc" <<EOF
#!/usr/bin/env bash
a=(); for x in "\$@"; do case "\$x" in --target=*|-Wl,--fix-cortex-a53-843419) ;; *) a+=("\$x");; esac; done
exec "$ZIG" cc -target aarch64-linux-musl "\${a[@]}"
EOF
	printf '#!/bin/sh\nexec "%s" ar "$@"\n' "$ZIG" > "$WORK/ar"; chmod +x "$WORK/cc" "$WORK/ar"
	echo "▸ pocketjs-kiosk ($TRIPLE)"
	(cd "$ROOT/hosts/android" &&
		CC_aarch64_unknown_linux_musl="$WORK/cc" AR_aarch64_unknown_linux_musl="$WORK/ar" \
		CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
		CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C linker-flavor=ld.lld -C link-self-contained=yes" \
		cargo build --release --target $TRIPLE --bin pocketjs-kiosk >"$WORK/cargo.log" 2>&1) ||
		{ tail -n 30 "$WORK/cargo.log"; echo "build failed"; exit 1; }
	grep -E "^ *Finished" "$WORK/cargo.log"
	echo "▸ app bundle ($MANIFEST)"
	# A fresh checkout has no generated styles module yet, and the typecheck before the build needs one.
	G="$ROOT/framework/src/styles.generated.ts"
	[ -f "$G" ] || echo 'export const STYLE_IDS: Record<string, number> = {};' > "$G"
	(cd "$ROOT" && bun pocket compile --target android --manifest "$MANIFEST" --project-root . >/dev/null)
fi

OUTNAME=$(cd "$ROOT" && bun -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).app.output)")
mkdir -p "$WORK/bundle"
cp "$ROOT/dist/$OUTNAME.js" "$WORK/bundle/app.js"
cp "$ROOT/dist/$OUTNAME.pak" "$WORK/bundle/app.pak"
(cd "$ROOT" && bun -e "const m=JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'));const v=m.app?.viewport?.fixed?.logical??[480,272];console.log(v[0]+' '+v[1])") > "$WORK/bundle/viewport"

echo "▸ push to $TAB:/opt/pocketjs"
ssh_tab 'mkdir -p /opt/pocketjs/bundle.new && rm -f /opt/pocketjs/bundle.new/*'
ssh_tab 'cat > /opt/pocketjs/pocketjs-kiosk.new && chmod 755 /opt/pocketjs/pocketjs-kiosk.new' < "$BIN"
tar -C "$WORK/bundle" -c . | ssh_tab 'tar -C /opt/pocketjs/bundle.new -x --no-same-owner'
tar -C "$OVL" -c etc/init.d/pocketjs etc/conf.d/pocketjs | ssh_tab 'tar -C / -x --no-same-owner'
ssh_tab 'set -e; cd /opt/pocketjs
	rc-service pocketjs stop >/dev/null 2>&1 || true
	mv pocketjs-kiosk.new pocketjs-kiosk; rm -rf bundle; mv bundle.new bundle
	rc-update add pocketjs default >/dev/null
	sync'
if [ -z "${NO_START:-}" ]; then
	ssh_tab 'rc-service pocketjs start && sleep 3 && rc-service pocketjs status; tail -n 8 /var/log/pocketjs.log'
fi
