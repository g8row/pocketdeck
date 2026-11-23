#!/usr/bin/env bash
# Builds the Ridge boot screens: out/logo.bin and out/desk-bootanim.zip (Magisk module).
#   tools/bootscreens/build.sh
# Needs uv (pulls pillow/fonttools/brotli into a throwaway env) and the stock logo dump at backup/partitions/logo.bin.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd); OUT=$HERE/out
PY=(uv run -q --no-project --with pillow --with fonttools --with brotli python -I)
cd "$HERE"
"${PY[@]}" render.py "$ROOT"
"${PY[@]}" logo_pack.py replace "$ROOT/backup/partitions/logo.bin" "$OUT/logo.bin" 0="$OUT/logo.png" 39="$OUT/logo.png"

# bootanimation.zip must be STORED (no compression) or bootanimation refuses it
rm -f "$OUT/bootanimation.zip"
(cd "$OUT/anim" && zip -q -0 -r "$OUT/bootanimation.zip" desc.txt part0 part1)

# Magisk module: systemless overlay of /system/media/bootanimation.zip
M=$OUT/module; rm -rf "$M"; mkdir -p "$M/system/media"
cp "$OUT/bootanimation.zip" "$M/system/media/"
cat > "$M/module.prop" <<EOF
id=desk-bootanim
name=Desk boot animation (Ridge)
version=1
versionCode=1
author=pocketdeck
description=ASCII ridge boot animation for the TB-7304X desk display. Remove the module to get the stock animation back.
EOF
rm -f "$OUT/desk-bootanim.zip"; (cd "$M" && zip -q -r "$OUT/desk-bootanim.zip" .)
(cd "$OUT" && shasum -a 256 logo.bin bootanimation.zip desk-bootanim.zip | tee SHA256SUMS)
