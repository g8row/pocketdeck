#!/bin/sh
# Install the MediaTek CONSYS WiFi/BT driver (mainline/wcn, see wcn/README.md) as drivers/misc/mediatek in the
# kernel tree in $1 and hook it into drivers/misc. Idempotent: the copy is replaced on every run.
set -e
K=$1; M=$(dirname "$0")/..
rm -rf "$K/drivers/misc/mediatek"
cp -R "$M/wcn" "$K/drivers/misc/mediatek"
rm -f "$K/drivers/misc/mediatek/README.md"
grep -q 'drivers/misc/mediatek/Kconfig' "$K/drivers/misc/Kconfig" || \
	sed -i 's|^source "drivers/misc/rp1/Kconfig"$|&\nsource "drivers/misc/mediatek/Kconfig"|' "$K/drivers/misc/Kconfig"
grep -q 'drivers/misc/mediatek/Kconfig' "$K/drivers/misc/Kconfig"
grep -q '^obj-y.*+= mediatek/' "$K/drivers/misc/Makefile" || echo 'obj-y				+= mediatek/' >> "$K/drivers/misc/Makefile"
