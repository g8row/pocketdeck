#!/bin/sh
# Install a kernel and/or root filesystem into a slot (A or B) on the running tablet.
#   tools/tb-install.sh [--slot a|b] kernel          device/out/boot-mainline-uboot.img -> tbkern_<slot> (verified)
#   tools/tb-install.sh [--slot a|b] rootfs          device/rootfs/out/rootfs.img -> tbroot_<slot> (grown to fit)
#   tools/tb-install.sh [--slot a|b] kernel rootfs   both
# Default slot: the one NOT running (tb.slot= on the tablet's cmdline), so the running system stays intact and is
# the fallback. Writing the running slot's root is refused; for that, RAM-boot first (tools/ramboot.sh).
# What the image does not contain is carried over from the running root (or, after a RAM boot, from the old root
# of the target slot): /opt/pocketjs, /etc/firmware (WiFi firmware + NVRAM), dropbear host keys, root's
# authorized_keys (the image only has the build key). /data is not
# touched. With BACKUP=1 the old target root is first saved to backup/tbroot_<slot>-<date>.tar.gz on this host.
# What was installed is recorded on the tablet in /data/pocketdeck/slot-<slot>.{kernel,rootfs} (with BUILDINFO).
# A slot boots tbkern_<slot> WITH tbroot_<slot>: install both into a slot unless the other half is known good.
# Then: `pd slot <slot> && pd reboot linux`; it is good once `pd state` shows healthy with last_good_slot=<slot>.
set -eu
R=$(cd "$(dirname "$0")/.." && pwd)
TB=$R/tools/tb.sh
KIMG=${KIMG:-$R/device/out/boot-mainline-uboot.img}
RIMG=${RIMG:-$R/device/rootfs/out/rootfs.img}
SLOT=
if [ "${1:-}" = --slot ]; then SLOT=${2:?--slot a|b}; shift 2; fi
[ $# -gt 0 ] || { sed -n '2,12p' "$0"; exit 2; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
# the tablet resolves the labels itself (by-partlabel may not exist under mdev)
dev() { "$TB" "for d in /sys/class/block/mmcblk0p*; do grep -q '^PARTNAME=$1\$' \$d/uevent && echo /dev/\${d##*/}; done; true"; }
"$TB" true || { echo "tablet not reachable (tools/tb.sh)"; exit 1; }

RUNNING=$("$TB" "sed -n 's/.*tb\.slot=\([a-z]*\).*/\1/p' /proc/cmdline")
case $SLOT in
'') case $RUNNING in a) SLOT=b ;; b) SLOT=a ;; *) echo "running slot is '${RUNNING:-?}': pass --slot a|b"; exit 2 ;; esac ;;
a|b) ;;
*) echo "--slot must be a or b"; exit 2 ;;
esac
echo "running slot: ${RUNNING:-?}, installing into slot: $SLOT"

# record_buildinfo <kernel|rootfs> <sha256>: stdin (BUILDINFO or nothing) + the installed hash and time
record_buildinfo() {
	"$TB" "mkdir -p /data/pocketdeck && { cat; echo sha256_installed=$2; echo installed=\$(date -u +%Y-%m-%dT%H:%MZ); } > /data/pocketdeck/slot-$SLOT.$1 && sync"
}

KDONE= RDONE=
for what in "$@"; do case $what in
kernel)
	[ -f "$KIMG" ] || { echo "no $KIMG (pd build kernel)"; exit 1; }
	KDEV=$(dev tbkern_$SLOT); [ -n "$KDEV" ] || { echo "no tbkern_$SLOT"; exit 1; }
	n=$(wc -c < "$KIMG" | tr -d ' ')
	echo "kernel: $KIMG ($n bytes) -> $KDEV (tbkern_$SLOT)"
	"$TB" "cat > $KDEV && sync" < "$KIMG"
	want=$(sha "$KIMG" | cut -c1-64)
	have=$("$TB" "head -c $n $KDEV | sha256sum" | cut -c1-64)
	[ "$want" = "$have" ] || { echo "kernel read-back mismatch ($have != $want)"; exit 1; }
	echo "kernel: written and verified ($want)"
	{ [ -f "$R/device/out/BUILDINFO" ] && cat "$R/device/out/BUILDINFO"; true; } | record_buildinfo kernel "$want"
	KDONE=1 ;;
rootfs)
	[ -f "$RIMG" ] || { echo "no $RIMG (pd build rootfs)"; exit 1; }
	RDEV=$(dev tbroot_$SLOT); [ -n "$RDEV" ] || { echo "no tbroot_$SLOT"; exit 1; }
	# resize2fs is in e2fsprogs-extra (in the image; add it to the running root if missing: apk add e2fsprogs-extra)
	"$TB" "command -v resize2fs >/dev/null" || { echo "no resize2fs on the running root: apk add e2fsprogs-extra, rerun"; exit 1; }
	"$TB" "grep -q '^$RDEV / ' /proc/mounts" && { echo "$RDEV is the running root: install into the other slot, or RAM-boot first (tools/ramboot.sh)"; exit 1; }
	# every mount of it goes (a forgotten second mount would be written under)
	unmount_all="cd /; i=0; while grep -q '^$RDEV ' /proc/mounts; do umount $RDEV || exit 1; i=\$((i + 1)); [ \$i -lt 5 ] || exit 1; done"
	"$TB" "$unmount_all" || { echo "cannot unmount $RDEV"; exit 1; }
	if [ "${BACKUP:-0}" = 1 ]; then
		"$TB" "mkdir -p /mnt/oldroot && mount -o ro $RDEV /mnt/oldroot" || { echo "cannot mount the old $RDEV for the backup"; exit 1; }
		B=$R/backup/tbroot_$SLOT-$(date +%Y%m%d-%H%M).tar.gz
		echo "rootfs: backing up the old root to $B"
		"$TB" "tar -C /mnt/oldroot -cf - . | gzip -1" > "$B"
		ls -la "$B"
		"$TB" "$unmount_all"
	fi
	# files the image does not carry: from the running root if it is an installed one, else from the old target root
	KEEP="opt/pocketjs etc/firmware etc/dropbear/*_host_key* root/.ssh/authorized_keys"
	if "$TB" "grep -q '^/dev/mmcblk0p[0-9]* / ' /proc/mounts && grep -q tbroot_ /sys/class/block/\$(sed -n 's|^/dev/\(mmcblk0p[0-9]*\) / .*|\1|p' /proc/mounts)/uevent"; then
		FROM=/; echo "rootfs: keeping $KEEP from the running root"
	else
		"$TB" "mkdir -p /mnt/oldroot && mount -o ro $RDEV /mnt/oldroot" || { echo "cannot mount the old $RDEV"; exit 1; }
		FROM=/mnt/oldroot; echo "rootfs: keeping $KEEP from the old $RDEV"
	fi
	"$TB" "rm -rf /tmp/keep && mkdir -p /tmp/keep && cd $FROM && tar -cf /tmp/keep/keep.tar \$(ls -d $KEEP 2>/dev/null); cd /; $unmount_all"
	"$TB" "! grep -q '^$RDEV ' /proc/mounts" || { echo "$RDEV still mounted, not writing"; exit 1; }
	n=$(wc -c < "$RIMG" | tr -d ' ')
	echo "rootfs: $RIMG ($n bytes) -> $RDEV (tbroot_$SLOT)"
	gzip -1 -c "$RIMG" | "$TB" "gunzip -c > $RDEV && sync"
	want=$(sha "$RIMG" | cut -c1-64)
	have=$("$TB" "head -c $n $RDEV | sha256sum" | cut -c1-64)
	[ "$want" = "$have" ] || { echo "rootfs read-back mismatch ($have != $want)"; exit 1; }
	"$TB" "cd /; e2fsck -f -y $RDEV > /tmp/e2fsck.log 2>&1; [ \$? -lt 4 ] || { cat /tmp/e2fsck.log; exit 1; }
		resize2fs $RDEV > /tmp/resize2fs.log 2>&1 || { cat /tmp/resize2fs.log; exit 1; }
		mkdir -p /mnt/newroot && mount $RDEV /mnt/newroot && { [ ! -s /tmp/keep/keep.tar ] || tar -C /mnt/newroot -xf /tmp/keep/keep.tar; } && sync &&
		df -h /mnt/newroot | tail -1 && ls /mnt/newroot/opt /mnt/newroot/etc/firmware 2>/dev/null | tr '\n' ' '
		cd /; umount /mnt/newroot; rm -rf /tmp/keep"
	echo; echo "rootfs: written, verified, grown; kept files restored"
	record_buildinfo rootfs "$want" < /dev/null
	RDONE=1 ;;
*) echo "unknown: $what (kernel, rootfs)"; exit 2 ;;
esac; done
[ -n "$KDONE$RDONE" ] && echo "done. Boot it: pd slot $SLOT && pd reboot linux   (back: pd slot ${RUNNING:-a})"
