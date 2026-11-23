# TB-7304X dual boot: the decided design (Linux by default, Android one step away)

**Date:** 2026-11-17. **Status:** decided. **Live layout since 2026-11-17 12:46: U-Boot in `boot`, Android in `recovery`** (T3 passed). **Linux boots by default since 13:16** (T4 passed). **Repartitioned; since ~20:00 Linux boots from the raw slot `tbkern_a` with its root on `tbroot_a`** (§6 steps 3–6, T9).
**Supersedes:** the U-Boot placement, ledger location, GUI actions and rootfs sections of
[plan-boot-recovery.md](../../plan-boot-recovery.md), and the long-term layout of [research-rootfs.md](research-rootfs.md).
**Evidence:** [research-lk-bootflow.md](research-lk-bootflow.md) (stock LK, disassembled, with addresses).

Decisions taken with the user on 2026-11-17:
- **No microSD.** Everything lives on the internal eMMC.
- **Wiping Android's data once is acceptable.** It holds 423 MB; Magisk needs re-setup afterwards.
- U-Boot goes in `boot` and autoboots Linux. Android moves to `recovery`.
- The boot menu (GUI) lives in Linux's stage-1 initramfs.

---

## 1. Boot chain

```
BROM → preloader → LK (stock, never modified)
  │  LK checks, in this order (lk.bin 0x41e02c60): RTC fastboot bit, RTC recovery bit, BCB, Vol+ menu, KPOC
  ├─ default: cold power-on, reboot, alarm, charger plug-in (KPOC)
  │     → boot = U-Boot (padded image, research-lk-bootflow §4)
  │          reads LK's bootmode (atag,boot) and tbstate (§4)
  │          ├─ KPOC (8/9) or alarm (7)      → Android from `recovery` (stock charging UI / alarm)
  │          ├─ tbstate: android-once         → Android (tbandroid: LK's DT, bootmode and firmware/android/mode = normal)
  │          ├─ tbstate: fastboot             → U-Boot fastboot (`fastboot boot` from RAM, development)
  │          └─ default: Linux slot A/B       → kernel slot (raw), boot counter; failures → other slot → rescue → Android
  ├─ RTC recovery bit (one-shot, cleared by LK before loading) or Vol+ menu → Recovery
  │     → recovery = Android + Magisk, started by LK directly, U-Boot not involved (runs with ro.boot.mode=recovery)
  └─ RTC fastboot bit or Vol+ menu → Fastboot → LK fastboot (`mainline/scripts/fbusb`: flash boot/recovery)
```

Properties this gives:
- **Linux by default** with no RTC re-arming.
- **Two ways to Android that bypass U-Boot:** the Vol+ menu (needs no software at all) and the RTC bit (one-shot,
  self-healing). A corrupt, hung or bad U-Boot costs at most one menu press.
- **No BCB, ever.** LK never clears it, and it hides the volume menu.
- **Android in normal mode** whenever U-Boot starts it.

## 2. eMMC layout

The eMMC is 14910 MiB (last LBA 30535679). The GPT has **23 entries**. Every existing partition keeps its start LBA;
only the end of `userdata` moves. LK reads up to 128 entries (`calloc(0x81, 0x14)` at `0x41e04dcc`) and never
writes the GPT. The preloader's GPT parsing is **not analysed**; the fallback is BROM writing back
`backup/partitions/gpt.bin` and `gpt_backup.bin`.

| # | Name | Start LBA | End LBA | Size | Content | Written by |
|---|---|---|---|---|---|---|
| 1–6 | proinfo … para | — | — | — | stock, untouched (`para` never written) | nobody |
| 7 | `boot` | 60416 | 93183 | 16 MiB | **U-Boot** (padded, gated by `lk_image_check.py`) | host, via LK fastboot or Android/Linux `dd` |
| 8 | `recovery` | 93184 | 125951 | 16 MiB | **Android + Magisk** boot image | host / Magisk |
| 9–21 | logo … cache | — | — | — | stock; `cache` is Android's again once `/cache/linux` is retired | Android |
| 22 | `userdata` | 10207232 | **16498687** | **3072 MiB** (was 9909) | Android, force-encrypted | Android |
| 24 | `tbstate` | 16498688 | 16500735 | 1 MiB | raw boot record, two copies + CRC (§4) | **the only thing U-Boot writes**; Linux, Android tile |
| 25 | `tbkern_a` | 16500736 | 16631807 | 64 MiB | raw kernel slot A: Android-format image (Image.gz, DTB in `second`, initramfs + menu) | Linux updater |
| 26 | `tbkern_b` | 16631808 | 16762879 | 64 MiB | raw kernel slot B | Linux updater |
| 27 | `tbrescue` | 16762880 | 16893951 | 64 MiB | raw known-good rescue kernel + initramfs | written once, by hand |
| 28 | `tbroot_a` | 16893952 | 21088255 | 2048 MiB | ext4 root A | Linux updater |
| 29 | `tbroot_b` | 21088256 | 25282559 | 2048 MiB | ext4 root B | Linux updater |
| 30 | `tbdata` | 25282560 | 30501887 | 2548.5 MiB | ext4: `/home`, persistent `/var/lib`, logs, pstore copies | Linux |
| 23 | `flashinfo` | 30501888 | 30534655 | 16 MiB | stock, untouched | — |

Notes:
- **Raw kernel slots:** U-Boot only needs `mmc read` and a checksum, so there is no filesystem code on the boot
  path. The image format is the one `fastboot boot` already uses (`boot-mainline-uboot.img`). U-Boot checks the
  header's SHA-1 `id` before booting it.
- **Root filesystems:** plain ext4, so `e2fsck -p` can run in the initramfs before mounting. No loop file, no
  double journaling.
- **Entry numbers:** new entries are appended (24–30). Existing numbers keep their `mmcblk0pN` names, so Android's
  `by-name` links and fstab are unaffected. Type GUIDs: Linux filesystem (`0FC63DAF-…`) for the ext4
  partitions, Linux data for the raw ones. Names are ≤ 36 characters (LK copies at most 36, `0x41e052bc`).
- **Survives Android:** a factory reset formats only `userdata` and `cache`, so every `tb*` partition survives.

## 3. Who may write what

| Writer | May write | Must never write |
|---|---|---|
| LK | nothing on the eMMC in our flows (RTC bits only) | — |
| U-Boot | `tbstate` (until §6: the record sectors at the end of `boot`) | everything else (no `fastboot flash`, no ext4/FAT write, enforced by `build-uboot.sh`) |
| Linux | `tbstate`, inactive `tbkern_*`/`tbroot_*`, `tbdata`; `boot`/`recovery` only by explicit admin command | `para`, Android partitions |
| Android | `recovery` (Magisk updates), `tbstate` (from the "boot Linux/Android" tile) | everything `tb*` except `tbstate` |
| Host | anything, via LK fastboot (`fbusb`) or BROM | — |

## 4. `tbstate` boot record (implemented 2026-11-17)

**Format:** [`mainline/u-boot/tbstate.h`](../../mainline/u-boot/tbstate.h), shared by the U-Boot command
(`tb7304x_tbstate.c`) and the Linux/Android tool (`mainline/initramfs/tbstate.c`, built static into the initramfs
and `out/tbstate`).
- **Copies:** two 512-byte copies, the second 64 KiB after the first. Each has magic `TBS1`, version, generation and
  CRC32 (zlib), plus `default` (linux/android), `oneshot` (none/linux/android/fastboot), `attempts`, `max` (3),
  `last_stage` (none/uboot/kernel/init/healthy), `last_error` (none/attempts/corrupt/no-image/bootm),
  `slot` (`cache`/`a`/`b`: what U-Boot boots), `last_good_slot` (set by `healthy` from `tb.slot=`), and the counters `linux_boots` and `fallbacks`.
- **Location:** sectors 0 and 128 of the 1 MiB `tbstate` partition (mmcblk0p24), since 2026-11-17 ~20:00. Both
  U-Boot and the tool refuse a `tbstate` partition outside 256–2048 sectors. Until then the record lived in the last
  1 MiB of `boot` (sectors 30720/30848); that stale copy is still there and nothing reads it. `build-uboot.sh` still
  keeps U-Boot below 15 MiB, so an old tool writing there cannot hit the image.
- **Reading:** the valid copy with the higher generation. `blank` (no magic anywhere): U-Boot creates the record
  with default Linux. `corrupt` (magic but no valid copy): U-Boot rewrites it, records `error=corrupt`, and boots
  Android once.
- **Writing:** generation+1 goes into copy `generation & 1`, which always overwrites the **older** copy, then is
  read back. Linux/Android use `O_DIRECT|O_SYNC`. The tool refuses to write unless `boot` starts with an
  Android-format image that ends before the area.
- **Who writes what:**
  - U-Boot: consumes `oneshot`; `attempt` (attempts+1, stage=uboot) before every Linux boot it starts.
  - Stage 1: `stage kernel` after mounting `cache`, `stage init` before `switch_root`, and copies the tool to
    `/usr/local/sbin`.
  - Stage 2: `tbstate healthy` at 60 s (attempts=0, stage=healthy, error=none).
- **Fallback:** at `attempts >= max`, U-Boot records `error=attempts` and boots Android **until Linux is re-armed**
  (`linux-test.sh to-linux`, or `tbstate set attempts=0 error=none` from Android).
- **Cover for early hangs:** the watchdog. LK leaves 10 s armed, U-Boot reprograms 15 s, and Linux `mtk_wdt` takes
  it over. A kernel that hangs or panics before stage 1 still resets, and the count advances.

Tool usage (Linux: `/usr/local/sbin/tbstate`, initramfs: `tbstate`, Android: `/data/local/tmp/tbstate` as root):
`tbstate` (show) · `tbstate set default=android oneshot=fastboot attempts=0 error=none max=3` · `tbstate stage init`
· `tbstate healthy`. U-Boot: `tbstate load|save|show|attempt|fail <error>|set default|oneshot|error|max <v>`.

## 5. Boot menu (GUI) (implemented 2026-11-17)

`mainline/initramfs/bootmenu.c` is a static program in the stage-1 initramfs. It draws on `/dev/fb0` (600×1024,
Terminus 16×32, generated at build time from the kernel's `lib/fonts/font_ter16x32.c`) and reads every
`/dev/input/event*` (Goodix touch, keypad Vol±, `mt6328-keys` Power).
- **When it runs:** stage 1 starts it after the USB gadget is up, so telnet works meanwhile, and before mounting
  the root.
- **Countdown:** **3 s**. `tb.menu=<s>` on the command line changes it; `tb.menu=0` turns the menu off.
- **Exit status = choice.** It never acts itself; stage 1 does.
- **Log:** `/www/menu.log`, copied into stage 1's log, which is `/var/log/tb7304-stage1.log` in stage 2.

| Row | Stage 1 does | Reboot? |
|---|---|---|
| Linux (default: countdown, 30 s idle, or any failure) | carries on | no |
| Android | `tbstate set oneshot=android` (falls back to the RTC flag) → U-Boot → Android in normal mode | yes |
| Android without U-Boot | RTC recovery flag → LK boots `recovery` directly | yes |
| Rescue shell | no stage 2, no auto-reboot; telnet/serial shell in the initramfs | no |
| U-Boot fastboot | `tbstate set oneshot=fastboot` | yes |
| LK fastboot | RTC fastboot flag | yes |

**Input:**
- **Touch:** **double-tap** a row, two short (< 0.8 s), non-sliding (< 40 px) taps within 1.5 s. The first tap only
  highlights the row.
- **Keys:** Vol+/Vol− move the highlight, and Power chooses it.
- **What stops the countdown:** only a real tap on a row or a key. After that, 30 s without input continues with
  Linux.
- **Why the strict touch rules:** the tablet's glass is cracked, and it produces **ghost touches** at fixed spots
  every few seconds, even with nobody touching it (logged at (7,118), (461,7–118)). They are short, at least 2.5 s
  apart, and outside the rows. A touch that isn't a tap on a row has no effect at all.
- **Display:** the console is set to `KD_GRAPHICS` on tty0 while the menu runs, so kernel messages don't draw over
  it.
- **Failure:** no framebuffer within 4 s, a crash or a signal all mean exit 0 (Linux). The menu can't block or
  redirect a boot by itself.

Superseded: Linux slot A/B/rescue is implemented with the raw kernel slots from §6 and U-Boot boots them directly
(T9); `kexec` is not used. Android can never be kexec'd: its 3.18 kernel depends on LK's DT handoff, so it always
costs a reboot. Getting back to Linux from Android is a plain reboot (U-Boot's default is Linux).

## 6. Migration (one session, after §8 passes)

Escape for every step: Vol+ menu → Recovery/Fastboot; BROM + mtkclient with `backup/partitions/*` (GPT, boot,
recovery, para).

1. **Back up everything.** Fresh dumps: GPT (primary and backup), `boot`, `recovery`, `metadata`, `para`, and
   `/cache/linux/rootfs.img`. Take a tar of the Alpine root as files.
2. **Layout swap (T3, §8).** U-Boot to `boot`, Android to `recovery`. Live with it for at least a day before
   repartitioning.
3. **Write the new GPT**, both primary and backup. Only `userdata`'s end LBA changes, plus entries 24–30 and the
   entry count. Write it from mainline Linux with `sgdisk`, or with mtkclient from BROM. Reboot, then check LK and
   Android still start. Android will refuse the oversized encrypted `userdata`; that is expected.
   **Done 2026-11-17 ~15:50** with `mainline/scripts/tb-gpt.py` (tables in `backup/partitions/2026-11-17-newgpt/`,
   pre-write dumps in `2026-11-17-prepart/`, read-back in `2026-11-17-postpart/`), written with `dd` from mainline
   Linux, backup first. After a reboot, preloader → LK → U-Boot → Linux came up and the kernel lists p1–p30 with the
   `tb*` names. Android not yet checked.
4. **Wipe `userdata`:**
   1. Put the stock `backup/partitions/recovery.bin` into `recovery` once.
   2. Boot it with the RTC bit and run "Wipe data/factory reset". That formats `userdata` at its new size and clears
      the encryption footer in `metadata`.
   3. Put Android back into `recovery`.
   4. On first boot Android re-encrypts. Reinstall the Magisk app and finish its setup. Check `ro.crypto.state` and
      root.
5. **Format and fill the Linux partitions** from Linux: `mkfs.ext4` the roots and `tbdata`. Copy the Alpine root from
   the loop file into `tbroot_a` as files. Write the kernel image to `tbkern_a` and the rescue image to `tbrescue`.
   Write the first `tbstate`.
   **Done 2026-11-17 ~19:30** from Linux: `tbroot_a`/`tbroot_b` formatted (`tbroot_b` empty), the live root copied
   into `tbroot_a` with `tar` from a bind mount of `/` (md5 of every file compared, only live logs differ),
   `tbdata` was already ext4 and is mounted at `/data`. `boot-mainline-uboot.img` (`95f2572e…`) is in `tbkern_a`,
   `tbrescue` and `/cache/linux` (old one kept as `.prev`). First record: `slot=a`. `tbkern_b` is empty.
   The first copy attempt crashed userspace: see "Protected RAM" in STATUS.md (fixed in the DTS before the retry).
6. **Switch U-Boot's script** from `/cache/linux/boot-target` to `tbstate` and the raw slots. Keep `/cache/linux` as
   a fallback until A/B has worked for a week, then delete it.
   **Done 2026-11-17 ~19:45** (U-Boot `88be1836…`, previous one in `mainline/out/u-boot-tb7304x-prev.img`). The
   Linux part of `boot.cmd`, by the attempt count before this boot:
   - `attempts < max`: the record's slot. `a`/`b`: header page of `tbkern_<slot>`, check `ANDROID!`, read
     header + kernel + ramdisk + second (+16 KiB) if it fits the partition, `bootm` with `bootargs=tb.slot=<slot>`
     (U-Boot prepends `bootargs` to the image cmdline). An invalid image (`error=no-image`) or a returning `bootm`
     falls back to `/cache/linux/boot-mainline-uboot.img` with `tb.slot=cache`. Slot `cache` goes there directly.
   - `attempts == max`: `tbrescue` once with `tb.slot=rescue` (stage 1 stays in the initramfs; its 300 s
     auto-reboot goes to Android with the RTC flag).
   - `attempts > max`: Android with `error=attempts` until re-armed.
   Stage 1 (`init`): `tb.slot=a|b` → `e2fsck -p` (static, from Debian's `e2fsck-static`; it still sets
   `broken_system_clock`, a harmless leftover from before the RTC) and mount `tbroot_<slot>`, falling back to the
   cache image;
   `cache` (or no `tb.slot`, an older U-Boot) → the loop image as before; `rescue` → no stage 2. `tbdata` is
   checked and mounted at `/data` in every stage-2 case. `/mnt/cache` is still mounted when it exists.
   Not done: no integrity hash on the raw slots (the header check and the attempt counter cover a bad image), no
   updater writing the inactive slot (§7), `/cache/linux` still in use as the fallback.

## 7. Updates

1. Write the new kernel and root into the **inactive** slots, verify the checksums, and `e2fsck -n` the new root.
2. In `tbstate`: `slot=inactive`, `trial=1`, `boot_attempt=0`, `generation++`.
3. Reboot. Stage 2 reaching `healthy` sets `last_good_slot`. N failures roll back to `last_good_slot`.
4. Never write the active slot. `tbrescue` is never touched by updates.

## 8. Validation status

| Test | Layout | Result |
|---|---|---|
| T0 (old image, U-Boot-launched Android + 2.5 GB read, `adb reboot recovery`) | Android `boot`, old U-Boot `recovery` | ✅ reproduced: no U-Boot, `wdt_by_pass_pwk`, Android back on its own (2026-11-17 12:35) |
| T0a (old image, **LK**-launched Android + 1.5 GB read) | same | U-Boot started. That kernel keeps its DTB at `0x4e000000` protected, so heavy I/O alone is not enough. |
| T1 (padded image, same sequence as T0) | Android `boot`, padded U-Boot `recovery` | ✅ U-Boot fastboot after 13 s (12:39) |
| Mode fix (`tbandroid` sets `/firmware/android/mode`) | same | ✅ Android `rtc`, `ro.boot.mode=normal`, Magisk OK (sha256 `672f2f9a…`) |
| T2 Vol+ menu → Recovery with padded U-Boot | same | pending (needs hands) |
| **T3** padded U-Boot in `boot`, Android in `recovery` | swap (done 12:46, both verified with `cmp`) | ✅ T3a: 1.5 GB read, then `adb reboot` → Android from `recovery`, `mode=normal`, Magisk + encryption OK. ✅ T3b: power off, then Power on → U-Boot → Android normal (seen by the user) |
| **T4** Linux by default (interim: `boot.cmd` default `linux`, image `/cache/linux/boot-mainline-uboot.img`; U-Boot `19d6778a…`) | swap | ✅ (2026-11-17 13:00–13:34) RAM boot via U-Boot `fastboot boot`: no "Kernel image misaligned", `memory@78000000` reserved, `mtk_wdt` takes over. Plain reboot from Android → **Linux** (gadget 16 s after reset). Linux reboot → Linux. `linux-test.sh ml-to-android` → Android (`rtc`/`recovery`, 32 s). `to-linux` → Linux. Stage-1 fallback (`bootcount=2`): stage 1 holds, auto-reboots after 300 s with the RTC flag → Android. Charger/alarm boots (LK bootmode 7/8/9) are routed to Android by `boot.cmd` (not re-tested since that change). |
| T5 charger plugged while off (KPOC) | swap | ✅ Power-off with USB attached → LK charger mode → U-Boot → Android `kpoc_charger` from `recovery`. The screen is off at first (the charger blanks it). A short press on Power shows the battery animation (display resume, `bootlogo_show_charging`, backlight 150; confirmed by the user). It charges (CC 650 mA), and a long press on Power boots normally. |
| T6 Magisk direct-install target with Android in `recovery` | swap | pending |
| **T7** boot record + U-Boot boot counter (U-Boot `bcccc39d…`, Linux image `48dddb36…`) | swap | ✅ (13:40–13:55) A blank area made U-Boot create the record. Every stage was recorded (gen 1→4), and `healthy` at 60 s reset `attempts` (gen 10). One-shot Linux and one-shot Android (normal mode) were consumed by U-Boot. **Crash test:** `sysrq c` before `healthy` on 3 boots in a row (`attempts` 1, 2, 3) → the 4th boot went to Android in normal mode with `error=attempts`, `fallbacks=1`. `to-linux` re-armed it, and Linux reached `healthy`. |
| **T9** raw slots (U-Boot `88be1836…`, image `95f2572e…`, record in `tbstate`) | repartitioned | ✅ (2026-11-17 19:45–20:10) Plain reboot → `tb.slot=a`, root `mmcblk0p28`, `/data` = `tbdata`, ssh 29 s after the reboot command, `healthy` at ~75 s uptime with `last_good_slot=a`. `slot=b` (empty `tbkern_b`) → `error=no-image`, cache image with `tb.slot=cache`. `attempts=3` → `tbrescue`, `tb.slot=rescue`, initramfs only. Reboot from there (`attempts=4`) → Android normal mode, `error=attempts`; the tool reads `tbstate` from Android (`/dev/block/mmcblk0p24`). `to-linux` → slot a, healthy. |
| **T8** boot menu (`fastboot boot` test copies with `tb.menu=20`, then the production image on cache) | swap | ✅ (14:00–14:40) Vol± move the highlight. Double-tap on Linux chose it (taps 0.43 s apart). Hands-off, the 20 s countdown continued to Linux. The production 3 s menu continued to Linux at 3.0 s while logging and ignoring 4 ghost touches, with nobody at the tablet. Found during testing: single-tap selection plus ghost touches had produced an unintended "Rescue shell", and ignored touches kept resetting the timers; both fixed. |

### How to reach each target in the current layout (`boot` = U-Boot, `recovery` = Android)

| Want | Do | Path |
|---|---|---|
| **Linux (default)** | power on, plain reboot; Linux `tb-reboot linux`; from Android `linux-test.sh to-linux` (also re-arms after a fallback) | LK → U-Boot (attempt counted) → `tbkern_<slot>` raw (fallback `/cache/linux/boot-mainline-uboot.img`) → root `tbroot_<slot>` |
| Pick the Linux slot | `tbstate set slot=a\|b\|cache` (Linux, or Android as root) | next boots use it |
| Android once, normal mode | Linux `tb-reboot android`; host `linux-test.sh ml-to-android` | record `oneshot=android` → U-Boot → `tbandroid` from `recovery` |
| Android by default | Linux `tb-reboot default-android`; back: `linux-test.sh to-linux` | record `default=android` |
| Android once, **without U-Boot** (escape) | Linux `tb-reboot android-direct`; `adb reboot recovery`; LK `oem reboot-recovery`; Vol+ menu → Recovery | LK RTC flag or menu → `recovery`, `ro.boot.mode=recovery` |
| Charger plugged in while off / RTC alarm | automatic | LK → U-Boot → Android (charging UI / alarm) |
| U-Boot fastboot (`fastboot boot <img>`) | Linux `tb-reboot uboot`; from Android `linux-test.sh to-uboot`. Leave with `fastboot continue` (default target) or `fastboot reboot`. | record `oneshot=fastboot` → U-Boot |
| LK fastboot (`fbusb … flash:`) | `adb reboot bootloader`, Linux `tb-reboot bootloader`, or Vol+ menu → Fastboot | LK |
| Inspect the record | `linux-test.sh state` (Android or Linux) | — |

`/cache/linux/boot-target` is no longer read; `tb-reboot` and `to-linux` delete leftovers.

Linux safety nets in this layout:
- **U-Boot's boot counter (§4):** 3 Linux boots in a row that never reach `healthy` → Android, with
  `error=attempts`. This covers kernels that panic or hang before stage 1.
- **Stage 1**, when it gives up on the root filesystem (2 failed tries of its own `bootcount`, `tb.r=0`, no
  image), reboots to Android after 300 s with the RTC flag.
- **Stage 2 `tb-autoreboot`** is off by default (`tb.autoreboot=` or `/etc/tb-autoreboot` enables it). It marks
  the boot good after 60 s (`bootcount`, `tbstate healthy`).
- **`linux-test.sh flash`** needs an explicit partition. `recovery` (Android) requires `YES=1`; `boot` must pass
  `lk_image_check.py`. On macOS the script uses a perl timeout (no GNU `timeout`).

Fixed U-Boot bug (2026-11-17): `fastboot continue` used to reset the tablet. Our MT6735 MUSB glue freed the
controller on remove without `usb_del_gadget_udc()`, and the `g_dnl_unregister()` that follows then used freed
memory (`u-boot/0002-musb-mt6735-unregister-udc-on-remove.patch`). `continue` now carries on with the default
target (Linux, counted as an attempt).

## 9. Open questions

- Why the BCB run and P2b failed (research-lk-bootflow §5). Neither route is used in this design.
- The preloader's GPT handling (test step 6.3, with BROM ready).
- The physical key behind LK's factory key (code 1).
