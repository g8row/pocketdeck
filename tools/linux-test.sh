#!/usr/bin/env bash
# TB-7304X fastboot test from a Linux host. Every device command has a hard timeout.
# The Mac could not get a single byte through LK's `download:` (even 4 KB stalls, USB 3 port or USB 2 hub).
# This script checks whether a Linux host does better, and runs step 1 of TEST-PLAN.md (RAM-only `fastboot boot`).
#
#   mainline/scripts/linux-test.sh fetch    # download the boot images from the GitHub release into mainline/out/
#   mainline/scripts/linux-test.sh probe    # tablet in fastboot: raw protocol probe (16 B) — shows which phase stalls
#   mainline/scripts/linux-test.sh uploads  # tablet in fastboot: RAM-only uploads 4 KB → 4 MB (fastboot stage)
#   mainline/scripts/linux-test.sh boot [image]   # tablet in fastboot: step 1, `fastboot boot` (RAM only)
# Layout since 2026-11-17: `boot` = U-Boot (boots Linux by default), `recovery` = Android + Magisk
# (docs/mainline/plan-dualboot.md, "How to reach each target").
#   mainline/scripts/linux-test.sh flash <image> <boot|recovery>  # LK fastboot: WRITES a partition (fb_send.py).
#                                                 # recovery holds ANDROID now: needs YES=1. boot must pass lk_image_check.
#   mainline/scripts/linux-test.sh run            # LK fastboot: `oem reboot-recovery` = Android from `recovery`
#   mainline/scripts/linux-test.sh shell          # wait for the mainline gadget, cancel the auto-reboot (mlsh.py wait)
#   mainline/scripts/linux-test.sh to-fastboot    # Android -> LK fastboot, safely (see below)
#   mainline/scripts/linux-test.sh to-linux       # Android -> Linux: boot record default=linux, attempts=0, reboot
#   mainline/scripts/linux-test.sh to-uboot       # Android -> U-Boot fastboot once (`fastboot boot <img>`)
#   mainline/scripts/linux-test.sh ml-to-fastboot # running mainline (either stage) -> LK fastboot directly
#   mainline/scripts/linux-test.sh ml-to-android  # running mainline -> Android once (stage 2: via U-Boot, normal
#                                                 # mode; stage 1: LK's RTC flag -> `recovery`)
#   mainline/scripts/linux-test.sh ml-to-linux    # running mainline -> Linux again
#   mainline/scripts/linux-test.sh state          # print the boot record (from Android, or from Linux over telnet)
# The boot record tool (out/tbstate, built with the initramfs) is pushed to Android's /data/local/tmp when needed.
#
# ALWAYS leave Android with to-fastboot / to-recovery, never a bare `adb reboot ...`: Magisk counts every boot that
# does not reach sys.boot_completed and enters safe mode after 2 (all modules disabled). Without tb7304x_strip,
# system_server crashes in PackageManagerService, so the tablet then boot-loops for good. adb answers long before
# boot completes. These commands wait for boot_completed, then reset Magisk's counter anyway, then reboot.
#
# Only `flash` writes flash. After a stall LK is wedged until the tablet reboots (hold Power ~15 s).
# Stop any adb server first (`adb kill-server`), and nothing else should poll USB.
set -u
cd "$(dirname "$0")/../.." || exit 1          # repo root
REL=mainline-test-1
OUT=mainline/out
# Hard timeout. GNU `timeout` on Linux hosts; macOS has none, so fall back to perl's alarm (exit 124 like timeout).
if command -v timeout >/dev/null; then tmo() { timeout -k 2 "$@"; }
else tmo() { perl -e '$s = shift; $p = fork // die; if (!$p) { exec @ARGV or exit 127 } $SIG{ALRM} = sub { kill "KILL", $p; exit 124 }; alarm $s; waitpid $p, 0; exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$@"; }; fi
T() { local s=$1; shift; tmo "$s" "$@"; local r=$?; [ $r = 124 ] && echo "*** TIMEOUT after ${s}s: $*"; return $r; }

# Wait for Android to finish booting, zero Magisk's boot-loop counter, then `adb reboot $1`.
adb_leave_android() {
  local b= i
  T 180 adb wait-for-device || return 1
  for i in $(seq 1 60); do
    b=$(T 10 adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r'); [ "$b" = 1 ] && break; sleep 5
  done
  [ "$b" = 1 ] || echo "!! Android did not finish booting (boot loop?); resetting Magisk's counter anyway"
  T 20 adb shell "su -c \"magisk --sqlite \\\"UPDATE settings SET value=0 WHERE key='bootloop'\\\"\"" ||
    echo "!! could not reset Magisk's bootloop counter"
  T 20 adb shell "su -c \"magisk --sqlite 'SELECT value FROM settings WHERE key=\\\"bootloop\\\"'\"" 
  T 20 adb reboot ${1:+"$1"}
}

ping() { echo "== ping"; T 5 fastboot getvar version 2>&1; }

# The boot record tool (built with the initramfs into out/tbstate, static aarch64) on Android
push_tbstate() {
  [ -f $OUT/tbstate ] || { echo "no $OUT/tbstate (build the initramfs)"; return 1; }
  T 20 adb push $OUT/tbstate /data/local/tmp/tbstate >/dev/null && T 10 adb shell chmod 755 /data/local/tmp/tbstate
}

case "${1:-}" in
fetch)
  mkdir -p "$OUT"
  gh release download "$REL" -R g8row/desk-companion -D "$OUT" --clobber
  # sha256sum: Linux, macOS 15+; shasum (perl): older macOS
  (cd "$OUT" && if command -v sha256sum >/dev/null; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi) ;;
probe)
  adb kill-server 2>/dev/null
  ping || exit 1
  # needs pyusb (pip install pyusb) and USB access: run this script with sudo, or add a udev rule
  "${PY:-python3}" -I mainline/scripts/analysis/fb_probe.py "${2:-16}" "${3:-512}" ;;
uploads)
  adb kill-server 2>/dev/null
  ping || exit 1
  tmp=$(mktemp -d)
  for k in 4 64 512 4096; do
    head -c $((k*1024)) /dev/urandom > "$tmp/blob$k"
    echo "== stage ${k}KB"; T 20 fastboot stage "$tmp/blob$k" 2>&1 || { echo ">> stalled at ${k}KB"; exit 2; }
  done
  ping ;;
boot)
  adb kill-server 2>/dev/null
  ping || exit 1
  img=${2:-$OUT/boot-stock-kernel-initramfs.img}
  echo "== fastboot boot $img"; T 60 fastboot boot "$img" 2>&1; echo "exit=$?" ;;
flash)
  img=${2:?flash <image> <boot|recovery>}; part=${3:?flash <image> <boot|recovery>}
  case "$part" in
  recovery) [ "${YES:-}" = 1 ] || { echo "recovery holds Android + Magisk (plan-dualboot.md). Set YES=1 to overwrite it."; exit 1; } ;;
  boot) python3 -I mainline/scripts/analysis/lk_image_check.py "$img" || { echo "LK would not boot $img reliably"; exit 1; } ;;
  *) echo "only boot or recovery"; exit 1 ;;
  esac
  T 120 "${PY:-python3}" -I mainline/scripts/analysis/fb_send.py "$img" "flash:$part" ;;
run)
  T 20 "${PY:-python3}" -I mainline/scripts/analysis/fb_send.py - "oem reboot-recovery" ;;
shell)
  T 250 python3 -I mainline/scripts/mlsh.py wait ;;
ml-to-fastboot|ml-to-android|ml-to-recovery|ml-to-linux)
  # Stage 2 has tb-reboot (boot record + RTC); stage 1 only the RTC flag (android/recovery = LK's recovery flag,
  # linux = plain reboot). Reboot from a detached subshell: mlsh appends "; echo marker", so a bare trailing "&"
  # would be a syntax error, and a plain background job dies with the telnet session.
  m=${1#ml-to-}; t=$m; [ "$m" = fastboot ] && t=bootloader; [ "$m" = recovery ] && t=android-direct
  r=$m; [ "$m" = fastboot ] && r=bootloader; [ "$m" = android ] && r=recovery; [ "$m" = linux ] && r=normal
  F=/sys/devices/platform/rtc-boot-mode/next_boot
  T 20 python3 -I mainline/scripts/mlsh.py \
    "if [ -x /usr/local/sbin/tb-reboot ]; then (setsid /usr/local/sbin/tb-reboot $t </dev/null >/dev/null 2>&1 &); echo tb-reboot $t; else echo $r > $F; echo next boot: \$(cat $F); (setsid sh -c 'sleep 2; sync; echo 1 > /proc/sys/kernel/sysrq; echo s > /proc/sysrq-trigger; sleep 1; echo u > /proc/sysrq-trigger; sleep 1; echo b > /proc/sysrq-trigger' </dev/null >/dev/null 2>&1 &); fi"
  ;;
state)
  if T 5 adb get-state >/dev/null 2>&1; then push_tbstate && T 15 adb shell "su -c '/data/local/tmp/tbstate'"
  else T 15 python3 -I mainline/scripts/mlsh.py '/usr/local/sbin/tbstate 2>/dev/null || tbstate'; fi ;;
to-fastboot)
  adb_leave_android bootloader ;;
to-linux|to-uboot)
  T 30 adb wait-for-device || exit 1
  push_tbstate || exit 1
  if [ "$1" = to-uboot ]; then a='oneshot=fastboot'; else a='default=linux oneshot=none attempts=0 error=none'; fi
  T 20 adb shell "su -c 'rm -f /cache/linux/boot-target; echo 0 > /cache/linux/bootcount; /data/local/tmp/tbstate set $a'" || exit 1
  adb_leave_android "" ;;
to-recovery)
  echo "to-recovery would only reach Android again (recovery holds Android). Use to-linux or to-uboot."; exit 1 ;;
*) sed -n 2,24p "$0"; exit 1 ;;
esac
