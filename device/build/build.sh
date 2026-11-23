#!/bin/sh
# Host entry point (macOS with OrbStack/Docker Desktop, or Linux with Docker). Reproduces everything in mainline/out/:
# initramfs, kernel, boot images, WiFi userspace, U-Boot and boot-mainline-uboot.img (what U-Boot boots).
#   mainline/scripts/build.sh            everything (U-Boot is incremental and repackages the kernel: always run it)
#   mainline/scripts/build.sh wcn        compile only the WiFi driver (fast check after editing mainline/wcn)
set -e
M=$(cd "$(dirname "$0")/.." && pwd)
docker build -t tb7304-build -f "$M/scripts/Dockerfile" "$M/scripts"
[ -d "$M/src/linux" ] || git clone --depth 1 -b mt6735-stable-7.0.y https://gitlab.com/mt6735-mainline/linux.git "$M/src/linux"
[ -d "$M/src/pmaports" ] || { git clone --depth 1 --filter=blob:none --sparse https://gitlab.postmarketos.org/postmarketOS/pmaports.git "$M/src/pmaports";
  (cd "$M/src/pmaports" && git sparse-checkout set --no-cone '/device/*/linux-postmarketos-mediatek-mt6735/*'); }
docker volume create tb7304-kbuild >/dev/null
if [ "${1:-}" = wcn ]; then exec docker run --rm -v "$M":/m -v tb7304-kbuild:/kout tb7304-build bash /m/scripts/wcn-build.sh; fi
docker run --rm -v "$M":/m -v tb7304-kbuild:/kout -v "$M/../backup/partitions":/stock:ro tb7304-build bash /m/scripts/build-in-docker.sh
PIN=$(sed -n 's/^PIN=//p' "$M/u-boot/build-uboot.sh")
[ -d "$M/src/u-boot" ] || git clone https://gitlab.com/mt6735-mainline/u-boot.git "$M/src/u-boot"
[ "$(git -C "$M/src/u-boot" rev-parse HEAD)" = "$PIN" ] || git -C "$M/src/u-boot" -c advice.detachedHead=false checkout -q "$PIN"
docker volume create tb7304-ubuild >/dev/null
docker run --rm -v "$M":/m -v tb7304-ubuild:/uout tb7304-build bash /m/u-boot/build-uboot.sh
