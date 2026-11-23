#!/bin/sh
# RAM-boot a kernel image through U-Boot fastboot without writing anything: the next normal boot is the installed one.
#   mainline/scripts/ramboot.sh [image]      default: mainline/out/boot-mainline-uboot.img (scripts/build.sh)
# From running mainline Linux (`tb-reboot uboot`) or with the tablet already in U-Boot fastboot. macOS or Linux host
# with `fastboot` (Linux: USB access for the fastboot device, e.g. a udev rule, or run as root).
# Note: without `tb.slot=` on the cmdline the initramfs uses the old root image in /cache (/cache/linux/rootfs.img),
# not tbroot_a. If the image panics, the tablet reboots into the installed kernel after 10 s; read the panic with
# `mount -t pstore pstore /sys/fs/pstore; cat /sys/fs/pstore/console-ramoops-0`.
set -eu
M=$(cd "$(dirname "$0")/.." && pwd)
IMG=${1:-$M/out/boot-mainline-uboot.img}
TB=$M/scripts/tb.sh
[ -f "$IMG" ] || { echo "no $IMG"; exit 1; }
command -v fastboot >/dev/null || { echo "fastboot not found (macOS: brew install android-platform-tools; Debian: apt install fastboot)"; exit 1; }
in_fastboot() { fastboot devices 2>/dev/null | grep -q fastboot; }
if ! in_fastboot; then
	"$TB" true 2>/dev/null || { echo "tablet neither in U-Boot fastboot nor reachable over ssh"; exit 1; }
	echo "rebooting into U-Boot fastboot"
	# ssh does not return when the tablet reboots under it; give it a few seconds
	"$TB" 'sync; tb-reboot uboot' > /dev/null 2>&1 &
	pid=$!
	i=0; while ! in_fastboot; do i=$((i + 1)); [ $i -gt 60 ] && { echo "no fastboot device after 120 s"; exit 1; }; sleep 2; done
	kill $pid 2> /dev/null || true
fi
fastboot boot "$IMG"
echo "waiting for ssh"
i=0; while ! "$TB" true 2>/dev/null; do i=$((i + 1)); [ $i -gt 50 ] && { echo "no ssh after 150 s (panic? see the header of this script)"; exit 1; }; sleep 3; done
"$TB" 'uname -v; cat /proc/cmdline'
