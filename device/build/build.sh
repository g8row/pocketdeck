#!/bin/sh
# Host entry point (macOS with OrbStack/Docker Desktop, or Linux with Docker). Reproduces everything in device/out/:
# initramfs, kernel, boot images, WiFi userspace, U-Boot and boot-mainline-uboot.img (what U-Boot boots).
#   device/build/build.sh            everything (U-Boot is incremental and repackages the kernel: always run it)
#   device/build/build.sh wcn        compile only the WiFi driver (fast check after editing device/wcn)
set -e
M=$(cd "$(dirname "$0")/.." && pwd)
# Build identity: shown by `uname -v` instead of a per-machine build counter, and recorded in out/BUILDINFO.
# A remote build has no .git: `pd build` passes PD_VERSION from the checkout it was started in.
PD_VERSION=${PD_VERSION:-$(git -C "$M" describe --always --dirty --abbrev=7 --match 'v*' 2>/dev/null || echo unknown)}
docker build -t tb7304-build -f "$M/build/Dockerfile" "$M/build"
[ -d "$M/src/linux" ] || git clone --depth 1 -b mt6735-stable-7.0.y https://gitlab.com/mt6735-mainline/linux.git "$M/src/linux"
[ -d "$M/src/pmaports" ] || { git clone --depth 1 --filter=blob:none --sparse https://gitlab.postmarketos.org/postmarketOS/pmaports.git "$M/src/pmaports";
  (cd "$M/src/pmaports" && git sparse-checkout set --no-cone '/device/*/linux-postmarketos-mediatek-mt6735/*'); }
docker volume create tb7304-kbuild >/dev/null
if [ "${1:-}" = wcn ]; then exec docker run --rm -v "$M":/m -v tb7304-kbuild:/kout tb7304-build bash /m/build/wcn-build.sh; fi
docker run --rm -e PD_VERSION="$PD_VERSION" -v "$M":/m -v tb7304-kbuild:/kout -v "$M/../backup/partitions":/stock:ro tb7304-build bash /m/build/build-in-docker.sh
PIN=$(sed -n 's/^PIN=//p' "$M/u-boot/build-uboot.sh")
[ -d "$M/src/u-boot" ] || git clone https://gitlab.com/mt6735-mainline/u-boot.git "$M/src/u-boot"
[ "$(git -C "$M/src/u-boot" rev-parse HEAD)" = "$PIN" ] || git -C "$M/src/u-boot" -c advice.detachedHead=false checkout -q "$PIN"
docker volume create tb7304-ubuild >/dev/null
docker run --rm -v "$M":/m -v tb7304-ubuild:/uout tb7304-build bash /m/u-boot/build-uboot.sh
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
{
	echo "version=$PD_VERSION"
	echo "built=$(date -u +%Y-%m-%dT%H:%MZ)"
	echo "kernel_src=$(git -C "$M/src/linux" rev-parse --short=12 HEAD 2>/dev/null)"
	echo "uboot_src=$(git -C "$M/src/u-boot" rev-parse --short=12 HEAD 2>/dev/null)"
	(cd "$M/out" && sha boot-mainline-uboot.img u-boot-tb7304x.img 2>/dev/null | awk '{print "sha256 " $2 " " $1}')
} > "$M/out/BUILDINFO"
cat "$M/out/BUILDINFO"
