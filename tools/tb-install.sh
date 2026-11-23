#!/bin/sh
# Install the kernel and/or the root filesystem into slot A on the tablet (no A/B: slot B stays unused).
#   mainline/scripts/tb-install.sh kernel          out/boot-mainline-uboot.img -> tbkern_a (raw, verified)
#   mainline/scripts/tb-install.sh rootfs          rootfs/out/rootfs.img -> tbroot_a (grown to the partition)
#   mainline/scripts/tb-install.sh kernel rootfs   both
# rootfs needs the tablet running from another root, i.e. RAM-booted (scripts/ramboot.sh: root = /cache image).
# Before it overwrites tbroot_a it saves the old root to backup/tbroot_a-<date>.tar.gz on this host (BACKUP=0
# skips), and carries over what the image does not contain: /opt/pocketjs, the WiFi firmware + NVRAM
# (/etc/firmware) and dropbear's host keys. /data (tbdata: saved WiFi networks) is not touched.
# Afterwards: reboot (`tb.sh 'sync; tb-reboot linux'`): U-Boot boots tbkern_a with root tbroot_a.
# macOS or Linux host.
set -eu
R=$(cd "$(dirname "$0")/../.." && pwd)
TB=$R/mainline/scripts/tb.sh
KIMG=${KIMG:-$R/mainline/out/boot-mainline-uboot.img}
RIMG=${RIMG:-$R/mainline/rootfs/out/rootfs.img}
[ $# -gt 0 ] || { sed -n '2,11p' "$0"; exit 2; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
# the tablet resolves the labels itself (by-partlabel may not exist under mdev)
dev() { "$TB" "for d in /sys/class/block/mmcblk0p*; do grep -q '^PARTNAME=$1\$' \$d/uevent && echo /dev/\${d##*/}; done; true"; }
"$TB" true || { echo "tablet not reachable (scripts/tb.sh)"; exit 1; }

for what in "$@"; do case $what in
kernel)
	[ -f "$KIMG" ] || { echo "no $KIMG (scripts/build.sh)"; exit 1; }
	KDEV=$(dev tbkern_a); [ -n "$KDEV" ] || { echo "no tbkern_a"; exit 1; }
	n=$(wc -c < "$KIMG" | tr -d ' ')
	echo "kernel: $KIMG ($n bytes) -> $KDEV"
	"$TB" "cat > $KDEV && sync" < "$KIMG"
	want=$(sha "$KIMG" | cut -c1-64)
	have=$("$TB" "head -c $n $KDEV | sha256sum" | cut -c1-64)
	[ "$want" = "$have" ] || { echo "kernel read-back mismatch ($have != $want)"; exit 1; }
	echo "kernel: written and verified ($want)" ;;
rootfs)
	[ -f "$RIMG" ] || { echo "no $RIMG (rootfs/build-rootfs.sh)"; exit 1; }
	RDEV=$(dev tbroot_a); [ -n "$RDEV" ] || { echo "no tbroot_a"; exit 1; }
	# resize2fs is in e2fsprogs-extra (in the image; add it to the running root if missing: apk add e2fsprogs-extra)
	"$TB" "command -v resize2fs >/dev/null" || { echo "no resize2fs on the running root: apk add e2fsprogs-extra, rerun"; exit 1; }
	"$TB" "grep -q '^$RDEV / ' /proc/mounts" && { echo "$RDEV is the running root: RAM-boot first (scripts/ramboot.sh)"; exit 1; }
	# every mount of it goes (a forgotten second mount would be written under)
	unmount_all="cd /; i=0; while grep -q '^$RDEV ' /proc/mounts; do umount $RDEV || exit 1; i=\$((i + 1)); [ \$i -lt 5 ] || exit 1; done"
	"$TB" "$unmount_all; mkdir -p /mnt/oldroot && mount -o ro $RDEV /mnt/oldroot" ||
		{ echo "cannot mount the old $RDEV"; exit 1; }
	if [ "${BACKUP:-1}" = 1 ]; then
		B=$R/backup/tbroot_a-$(date +%Y%m%d-%H%M).tar.gz
		echo "rootfs: backing up the old root to $B"
		"$TB" "tar -C /mnt/oldroot -cf - . | gzip -1" > "$B"
		ls -la "$B"
	fi
	echo "rootfs: keeping /opt/pocketjs, /etc/firmware, dropbear host keys"
	"$TB" "rm -rf /tmp/keep && mkdir -p /tmp/keep && cd /mnt/oldroot && tar -cf /tmp/keep/keep.tar \$(ls -d opt/pocketjs etc/firmware etc/dropbear/*_host_key* 2>/dev/null) && $unmount_all"
	"$TB" "! grep -q '^$RDEV ' /proc/mounts" || { echo "$RDEV still mounted, not writing"; exit 1; }
	n=$(wc -c < "$RIMG" | tr -d ' ')
	echo "rootfs: $RIMG ($n bytes) -> $RDEV"
	gzip -1 -c "$RIMG" | "$TB" "gunzip -c > $RDEV && sync"
	want=$(sha "$RIMG" | cut -c1-64)
	have=$("$TB" "head -c $n $RDEV | sha256sum" | cut -c1-64)
	[ "$want" = "$have" ] || { echo "rootfs read-back mismatch ($have != $want)"; exit 1; }
	"$TB" "cd /; e2fsck -f -y $RDEV > /tmp/e2fsck.log 2>&1; [ \$? -lt 4 ] || { cat /tmp/e2fsck.log; exit 1; }
		resize2fs $RDEV > /tmp/resize2fs.log 2>&1 || { cat /tmp/resize2fs.log; exit 1; }
		mount $RDEV /mnt/oldroot && tar -C /mnt/oldroot -xf /tmp/keep/keep.tar && sync && df -h /mnt/oldroot | tail -1 &&
		ls /mnt/oldroot/opt /mnt/oldroot/etc/firmware 2>/dev/null | tr '\n' ' '; cd /; umount /mnt/oldroot; rm -rf /tmp/keep"
	echo; echo "rootfs: written, verified, grown; kept files restored" ;;
*) echo "unknown: $what (kernel, rootfs)"; exit 2 ;;
esac; done
echo "done. Reboot into it: $TB 'sync; tb-reboot linux'"
