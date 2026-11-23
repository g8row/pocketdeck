# Boot chain: Linux by default, Android one step away

Stock preloader and LK are never modified. LK boots U-Boot from `boot`; U-Boot reads a boot record (`tbstate`) and
boots Linux from a raw kernel slot, or Android from `recovery`. Ground truth: [`boot.cmd`](../../device/u-boot/boot.cmd),
[`tbstate.h`](../../device/u-boot/tbstate.h), [`init`](../../device/initramfs/init). LK internals, with addresses:
[research-lk-bootflow.md](../hardware/research-lk-bootflow.md). When something breaks: [recovery.md](../install/recovery.md).

## Overview

```
BROM → preloader → LK (stock)
  LK mode priority: preloader handshake → RTC fastboot bit → RTC recovery bit → BCB in para → keys (Vol+ menu) → KPOC → normal
  ├─ normal, KPOC, alarm      → `boot` = U-Boot (reads LK's bootmode + tbstate)
  │    ├─ bootmode 7 (alarm), 8/9 (charger plugged in while off)  → Android from `recovery` (normal mode)
  │    ├─ record unreadable or corrupt                            → Android
  │    ├─ oneshot=android, or default=android                     → Android (tbandroid: LK's DT, mode=normal)
  │    ├─ oneshot=fastboot                                        → U-Boot fastboot (0e8d:201c)
  │    └─ Linux (default): tbkern_<slot> + tbroot_<slot>, counted attempt; see "tbstate"
  ├─ RTC recovery bit, or Vol+ menu → Recovery → `recovery` = Android + Magisk, started by LK (ro.boot.mode=recovery)
  └─ RTC fastboot bit, or Vol+ menu → Fastboot → LK fastboot (0bb4:0c01, use tools/fbusb)
```

The RTC bits live in `RTC_PDN1` (PMIC `0x402c`): bit 13 = fastboot, bits [5:4] = `01` = recovery. Both are one-shot;
LK clears the recovery bit before loading, so a hanging image costs one boot. LK arms the watchdog at 10 s and leaves
it running; U-Boot reprograms it to 15 s; Linux `mtk_wdt` takes over. A hang before userspace therefore still resets.

## eMMC layout

14910 MiB eMMC, GPT with 30 entries. Entries 1–23 keep their stock numbers and start LBAs (Android's `by-name` links
are unchanged); only `userdata` was shrunk. Entries 24–30 are appended. Tables: `tools/tb-gpt.py`.

| # | Name | Size | Content | Written by |
|---|---|---|---|---|
| 1–6 | proinfo … para | — | stock | nobody (`para` never) |
| 7 | `boot` | 16 MiB | U-Boot (padded, LK-bootable, script `boot.cmd` as its ramdisk) | host: `pd flash uboot` |
| 8 | `recovery` | 16 MiB | Android + Magisk boot image | host, Magisk |
| 22 | `userdata` | 3072 MiB (was 9909) | Android data, force-encrypted | Android |
| 23 | `flashinfo` | 16 MiB | stock, at the end of the disk | nobody |
| 24 | `tbstate` | 1 MiB | boot record, two copies | U-Boot, Linux, Android (root) |
| 25 | `tbkern_a` | 64 MiB | raw Android-format image: Image.gz, DTB in `second`, initramfs | `pd install kernel` |
| 26 | `tbkern_b` | 64 MiB | same, slot B | `pd install kernel` |
| 27 | `tbrescue` | 64 MiB | known-good kernel + initramfs (rescue only) | by hand, once |
| 28 | `tbroot_a` | 2048 MiB | ext4 root A | `pd install rootfs` |
| 29 | `tbroot_b` | 2048 MiB | ext4 root B | `pd install rootfs` |
| 30 | `tbdata` | 2548.5 MiB | ext4 `/data`: home, persistent state, `/data/pocketdeck/slot-*` | Linux |

Write rules: **U-Boot only ever writes `tbstate`** (no `fastboot flash`, no filesystem writes). Linux writes
`tbstate`, the inactive `tbkern_*`/`tbroot_*` and `tbdata`. Android writes `recovery` (Magisk) and `tbstate`.
Nothing writes `lk`, `preloader`, `seccfg`, `nvram`, `nvdata`, `protect1/2` or `para`. An Android factory reset only
formats `userdata` and `cache`; every `tb*` partition survives it.

## The `tbstate` boot record

Two 512-byte copies at sectors 0 and 128 of `tbstate`, each with magic `TBS1`, version, generation and CRC32.
Readers take the valid copy with the higher generation; writers write generation+1 over the older copy, so a power
loss leaves the other intact. Tool: `tbstate` (initramfs; `/usr/local/sbin/tbstate` in stage 2; pushed to
`/data/local/tmp` on Android by `pd`). U-Boot command: `tbstate load|save|show|attempt|fail|set`.

| Field (as `tbstate` prints it) | Values | Written by |
|---|---|---|
| `default` | linux / android | `pd boot default`, `tb-reboot default-*`, `linux-test.sh to-linux` |
| `oneshot` | none / linux / android / fastboot | `tb-reboot`, boot menu; U-Boot consumes it (sets `none`) |
| `slot` | a / b / cache | `pd slot` (also sets `attempts=0 error=none`) |
| `attempts`, `max` | count, 3 | U-Boot +1 before each Linux boot; `healthy` resets to 0 |
| `stage` (`last_stage`) | none / uboot / kernel / init / healthy | U-Boot `uboot`; stage 1 `kernel`, `init`; stage 2 `healthy` |
| `error` (`last_error`) | none / attempts / corrupt / no-image / bootm | U-Boot, when it falls back |
| `last_good_slot` | a / b / cache | `healthy`, from `tb.slot=` |
| `linux_boots`, `fallbacks` | counters | diagnostic |

Blank: U-Boot creates the record (default linux). Corrupt: U-Boot rewrites it, sets `error=corrupt`, boots Android.
Stage 2 (`/etc/local.d/tb-autoreboot.start`) writes `healthy` 60 s after reaching userspace.

U-Boot's Linux decision, by `attempts` before this boot is counted:

| `attempts` | U-Boot boots |
|---|---|
| < 3 | `tbkern_<slot>` with `tb.slot=<slot>`; stage 1 mounts `tbroot_<slot>` |
| = 3 | `tbrescue` once with `tb.slot=rescue`: initramfs only, shell, then Android (RTC recovery bit) after 300 s |
| > 3 | Android with `error=attempts`, every boot, until re-armed (`pd slot`, `linux-test.sh to-linux`) |

A slot without a valid `ANDROID!` image (`error=no-image`), or a `bootm` that returns, falls back to the legacy
image `/cache/linux/boot-mainline-uboot.img` (`tb.slot=cache`); without that, Android. Stage 1 also falls back to
the cache root if `tbroot_<slot>` fails to check or mount.

## Slots and updates

A slot is `tbkern_<x>` **with** `tbroot_<x>`. `pd install kernel|rootfs` writes the slot that is **not** running
(from `tb.slot=` in `/proc/cmdline`), verifies by SHA-256 read-back, refuses to write the mounted root, and records
what it installed in `/data/pocketdeck/slot-<x>.{kernel,rootfs}`. Then `pd slot b && pd reboot linux` tries it
(good once `pd state` shows `stage=healthy`, `last_good_slot=b`); `pd slot a && pd reboot linux` rolls back.

`last_good_slot` is recorded but **nothing acts on it**: U-Boot never switches slots by itself. Unhealthy boots of
the selected slot go to `tbrescue` and then Android, not to the other slot. Rollback is a manual `pd slot <old>`.
`tbrescue` is never written by updates.

## Stage-1 boot menu

`device/initramfs/bootmenu.c`, run by stage 1 on `/dev/fb0` before the root is mounted (USB gadget already up).
Countdown 3 s (`tb.menu=<s>`, `0` = off); any failure, crash or 30 s idle continues with Linux.

Rows: **Linux** (continue, the default) · **Android** (`oneshot=android`; RTC recovery bit if the record is not
writable) · **Android without U-Boot** (RTC recovery bit) · **Rescue shell** (stay in the initramfs, no auto-reboot)
· **U-Boot fastboot** (`oneshot=fastboot`) · **LK fastboot** (RTC fastboot bit). Every row but the first reboots.

Input: **double-tap** a row (two taps < 0.8 s each, < 40 px movement, within 1.5 s), or Vol± to move and Power to
choose. Single taps only highlight. The cracked glass produces ghost touches at fixed spots every few seconds;
anything that is not a double-tap on a row is ignored and does not stop the countdown.

## How to reach each target

`pd` acts over ssh when Linux runs (`tb-reboot`), over adb when Android runs (`tools/linux-test.sh`, which waits for
`sys.boot_completed` first).

| Want | Command | Mechanism |
|---|---|---|
| Linux | power on; `pd reboot linux` | Linux: `oneshot=linux`. Android: `default=linux oneshot=none attempts=0 error=none` |
| Linux slot | `pd slot a\|b` | `slot=`, `attempts=0`, `error=none`; applies on the next Linux boot |
| Default OS | `pd boot default linux\|android` | `default=` |
| Android once, normal mode | `pd reboot android` (from Linux) | `oneshot=android` → U-Boot → `recovery` |
| Android without U-Boot | `pd reboot android-direct` (Linux); Vol+ menu → Recovery | RTC recovery bit → LK → `recovery` |
| Charger / alarm boot | automatic | LK bootmode 7/8/9 → U-Boot → Android |
| U-Boot fastboot | `pd reboot uboot`; `pd ramboot [img]` | `oneshot=fastboot`; leave with `fastboot continue` (default target) or `fastboot reboot` |
| LK fastboot | `pd reboot bootloader`; Vol+ menu → Fastboot | RTC fastboot bit (Android: `adb reboot bootloader` after boot completes) |
| Inspect | `pd state` | prints the record from Linux or Android |

## LK constraints

Every image LK boots (`boot`, `recovery`) must pass [`lk_image_check.py`](../../device/analysis/lk_image_check.py)
(`pd flash uboot` runs it; `build-uboot.sh` renames a failing image `*.REJECTED`). Key rules
([research-lk-bootflow.md §4](../hardware/research-lk-bootflow.md)):
- LK reads the DTB it hands over from the **last 512 KiB of the kernel area** in the partition. The kernel area must
  be ≥ 512 KiB, the FDT appended at its end (U-Boot: gzip ‖ zero padding ‖ stock DTB). Smaller, and LK boots with
  whatever DTB a previous boot left at `0x4e000000`, or spins until the watchdog fires.
- Header cmdline ≤ **99 characters** and containing `bootopt=64S3,32N2,64N2`; `kernel_addr` 512 KiB aligned; gzip kernel.
- The started code must kick or take over the watchdog within ~10 s.

Images for U-Boot only (`boot-mainline-uboot.img`, the slot images) carry the DTB in `second` and no `bootopt`; they
fail the check and are **not LK-bootable by design**. Never put one in `boot` or `recovery`.

## Why BCB / `para` is never used

LK checks a `boot-recovery` BCB in `para` before the keys and never clears it: a BCB forces `recovery` on every boot
and hides the Vol+ menu. Only BROM restores a usable tablet after that. The RTC bits do the same job one-shot.

## History

Migrated on 2026-11-17: U-Boot moved to `boot` and Android to `recovery`, the GPT gained entries 24–30 (with
`userdata` shrunk), and the root moved from a loop file on `cache` into `tbroot_a`. The step-by-step
procedure is in git history: tag `android-era-final`, `docs/mainline/plan-dualboot.md`.

| Test | Proved | Date |
|---|---|---|
| T0, T1 | unpadded U-Boot hangs in LK after a U-Boot-launched Android + heavy I/O (stale DTB); padded boots | 2026-11-17 |
| Mode fix | `tbandroid` gives Android `ro.boot.mode=normal`; Magisk works | 2026-11-17 |
| T3 | U-Boot in `boot`, Android in `recovery`: reboot and cold power-on reach Android in normal mode | 2026-11-17 |
| T4 | Linux by default; reboots in both directions; stage-1 fallback to Android | 2026-11-17 |
| T5 | charger plugged in while off → Android charging UI, charges, long press boots | 2026-11-17 |
| T7 | record created, stages recorded, `healthy` resets; 3 crashes before `healthy` → Android, `error=attempts` | 2026-11-17 |
| T8 | boot menu: Vol±, double-tap, 3 s countdown ignores ghost touches | 2026-11-17 |
| T9 | raw slots: `tbkern_a`/`tbroot_a`; empty slot → `no-image` → cache; `attempts=3` → rescue → Android | 2026-11-17 |
| T2, T6 | Vol+ menu → Recovery with U-Boot in place; Magisk direct install to `recovery` | pending |
