# Stage 2 · Repartition

Stage 2 of 5 · **you are here:** rooted Android · **you need:** stage 1's dump, BROM access · **you end with:** a
GPT with `tbstate`, `tbkern_a/b`, `tbrescue`, `tbroot_a/b`, `tbdata` carved from `userdata`, Android working again
Previous: [01](01-backup-unlock-root.md) · Next: [03 U-Boot](03-uboot.md) · If it fails: [recovery](recovery.md#brom-and-mtkclient)

> This was done once, on one unit, on 2026-11-17 (from a Linux system booted through U-Boot, before the current
> stage order existed). The steps below are that procedure in install order; they have not been re-run from stock.
> Have BROM ready and read the whole page first.

The layout and why: [boot-chain.md](../architecture/boot-chain.md) (eMMC layout). Only `userdata`'s end moves
(9909 → 3072 MiB); entries 1–23 keep their start LBAs and numbers, new entries 24–30 are appended. Android's
`by-name` links and fstab are unaffected.

## 1. Fresh dumps of what changes

The primary GPT (first 512 KiB of the eMMC) and the backup GPT (last 1 MiB), plus `boot`, `recovery`, `metadata`,
`para`. With mtkclient in BROM (`mtk rl` from stage 1 already has them) or from Android as root:

```sh
adb shell su -c 'dd if=/dev/block/mmcblk0 bs=512 count=1024 > /sdcard/gpt-first.bin'
adb shell su -c 'dd if=/dev/block/mmcblk0 bs=512 skip=30533632 count=2048 > /sdcard/gpt-last.bin'
adb pull /sdcard/gpt-first.bin /sdcard/gpt-last.bin backup/partitions/
```

## 2. Build and check the new tables

```sh
python3 -I tools/tb-gpt.py build backup/partitions/gpt-first.bin backup/partitions/gpt-last.bin backup/newgpt
python3 -I tools/tb-gpt.py show  backup/newgpt/primary-lba1-9.bin       # CRCs, overlaps, layout.txt
```

`tb-gpt.py` writes the primary header + entries (LBA 1–9), the backup entries and the backup header, and refuses
anything but this tablet's 30535680-sector eMMC.

## 3. Write both tables

Write the primary (LBA 1) and the backup (entries at LBA 30534656, header at the last LBA) from a root shell
(Android or Linux) with `dd` (on Android: `dd bs=512 seek=…`, then `sync` and read back with `cmp`; toybox `dd`
has no `conv=`), or with mtkclient from BROM. Then reboot. LK and Android must still start; the kernel lists
p1–p30 with the `tb*` names.

## 4. Wipe `userdata` once

Android refuses the shrunken, still-encrypted `userdata` until it is formatted:

1. Put the stock `backup/partitions/recovery.bin` into `recovery`, boot it (`adb reboot recovery` or the Vol+ menu),
   run *Wipe data/factory reset*. That formats `userdata` at its new size and clears the encryption footer in
   `metadata`.
2. Put the original `recovery.bin` back, boot Android (it re-encrypts), reinstall the Magisk app, re-add
   `tb7304x_strip` (stage 1 §4). Check `ro.crypto.state` and `su -c id`.

A factory reset formats only `userdata` and `cache`; the `tb*` partitions survive it.

Done when: `adb shell ls /dev/block/platform/mtk-msdc.0/11230000.msdc0/by-name/` lists `tbstate` … `tbdata`, and
Android boots rooted.

Next: [03 U-Boot](03-uboot.md)
