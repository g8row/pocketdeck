#!/bin/bash
# Quick compile of the WiFi driver only (drivers/misc/mediatek, from mainline/wcn), inside tb7304-build.
# Host: mainline/scripts/build.sh wcn. Shares the kernel build volume, so a full build afterwards is incremental.
set -uo pipefail
M=/m; K=$M/src/linux; O=/kout
[ "$(uname -m)" != aarch64 ] && export CROSS_COMPILE=aarch64-linux-gnu-
for p in $M/patches/0*.sh; do sh "$p" $K; done
for p in $M/patches/0*.patch; do patch -d $K -p1 -R -f -s --dry-run < "$p" >/dev/null 2>&1 && continue; patch -d $K -p1 -N -s < "$p"; done
cp $M/src/pmaports/device/*/linux-postmarketos-mediatek-mt6735/config-postmarketos-mediatek-mt6735.aarch64 $O/.config
cat $M/patches/config-tb7304x.fragment >> $O/.config
make -C $K O=$O ARCH=arm64 olddefconfig >/dev/null
make -C $K O=$O ARCH=arm64 -j"$(nproc)" -k drivers/misc/mediatek/ > /tmp/wcn.log 2>&1; rc=$?
echo "errors: $(grep -c 'error:' /tmp/wcn.log)  warnings: $(grep -c 'warning:' /tmp/wcn.log)"
grep -E 'error:' /tmp/wcn.log | sed -E 's|.*drivers/misc/mediatek/||' | sort | uniq -c | sort -rn | head -40
exit $rc
