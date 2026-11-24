# When something goes wrong

Ordered from least to most invasive: try the sections in order. Before writing anything, read
[Never write](#never-write). Design background: [boot-chain.md](../architecture/boot-chain.md).
`pd state` (from Linux or Android) prints the boot record; start there.

## Linux did not come up after an install

**Symptoms:** after `pd install …`, `pd slot <x>`, `pd reboot linux`, no ssh on 172.16.42.1.

Each Linux boot that does not reach `healthy` increments `attempts`. The tablet sorts itself out:
1. Boots 1–3: the selected slot again (watchdog or `CONFIG_PANIC_TIMEOUT=10` reboots a hung or panicked kernel).
2. Boot 4: `tbrescue` (`tb.slot=rescue`): initramfs only, USB gadget up, shell over telnet (`tools/linux-test.sh shell`).
   From there: `tbstate set slot=<old> attempts=0 error=none`, then `echo b > /proc/sysrq-trigger`.
3. After 300 s in rescue, or any boot after it: Android (`error=attempts`), until Linux is re-armed.

From Android (adb up), go back to the slot that worked:
```
pd slot a                    # slot=a attempts=0 error=none (record written via adb + su)
pd reboot linux              # = tools/linux-test.sh to-linux: default=linux, waits for boot_completed, reboots
```
`last_good_slot` in `pd state` names the slot that last reached `healthy`. U-Boot never switches back by itself.

## Boot counter tripped during testing

**Symptoms:** Linux was fine, but after a few quick test reboots the tablet lands in rescue or Android;
`pd state` shows `attempts=4` (or more) and `error=attempts`.

Cause: three reboots in a row before stage 2 wrote `healthy` (60 s after userspace starts). Fix from Android:
`pd reboot linux` (resets `attempts`). Prevention: between test reboots wait until `pd state` shows
`stage=healthy` and `attempts=0`.

## Leaving Android safely

Magisk counts every boot that does not reach `sys.boot_completed` and enters safe mode after 2 (all modules
disabled), after which the tablet can boot-loop for good. adb answers long before boot completes.
- Never a bare `adb reboot …`. Use `pd reboot linux|uboot|bootloader` or `tools/linux-test.sh
  to-linux|to-uboot|to-fastboot`: they wait for `sys.boot_completed`, reset Magisk's counter, then reboot.
- Manual reset of the counter, and re-enabling modules after a safe-mode boot (`adb shell`, then):
```
su -c "magisk --sqlite \"UPDATE settings SET value=0 WHERE key='bootloop'\""
su -c 'rm -f /data/adb/modules/*/disable'
```

## Kernel panics

`CONFIG_PANIC_TIMEOUT=10`: a panicking kernel reboots after 10 s (that boot counts as an attempt). The log survives
in RAM; read it on the next Linux boot:
```
mount -t pstore pstore /sys/fs/pstore; cat /sys/fs/pstore/console-ramoops-0
```
A RAM-booted test image (`pd ramboot`) that panics reboots into the installed kernel.

## Hangs

- Shell still alive: `echo 1 > /proc/sys/kernel/sysrq; echo b > /proc/sysrq-trigger` (`tb-reboot` does s, u, b).
  `reboot -f` can hang on this kernel.
- Nothing responds: hard reset by holding **Power 10–15 s**. The watchdog also resets hangs before userspace
  (LK 10 s, U-Boot 15 s, then Linux `mtk_wdt`).

## Vol+ menu at power-on

Needs no working U-Boot or Linux. Power off (hold Power if needed), then hold **Vol+** while pressing Power. LK's
menu: **Vol+ moves, Vol− selects**.
- **Recovery** → Android from `recovery`, started by LK directly (U-Boot not involved).
- **Fastboot** → LK fastboot ([below](#lk-fastboot)).

Do **not** hold Vol− at power-on: it is LK's factory-mode key.

## Writing a partition from Android

Android rooted and running, the image on the host. toybox `dd` has no `conv=`:
```
adb push img.bin /data/local/tmp/img.bin
adb shell su
B=/dev/block/platform/mtk-msdc.0/11230000.msdc0/by-name
dd if=/data/local/tmp/img.bin of=$B/<part> bs=1048576; sync
head -c $(stat -c %s /data/local/tmp/img.bin) $B/<part> | cmp - /data/local/tmp/img.bin && echo OK
```
An image for `boot` or `recovery` must pass `device/analysis/lk_image_check.py` first.

## LK fastboot

Reach it with `pd reboot bootloader`, or the [Vol+ menu](#vol-menu-at-power-on) → Fastboot. LK fastboot enumerates
as `0bb4:0c01`; the stock `fastboot` tool stalls in `download:` there. Use `tools/fbusb` (pyusb), with no adb server
or anything else polling USB:
```
pd flash uboot                                   # lk_image_check, then device/out/u-boot-tb7304x.img -> boot
tools/fbusb device/out/u-boot-tb7304x.img flash:boot
tools/fbusb <android-magisk-boot.img> flash:recovery
tools/fbusb - "oem reboot-recovery"              # leave: Android from recovery
```
(U-Boot fastboot, `pd reboot uboot`, is `0e8d:201c` and works with the stock tool; it cannot write flash.)

### Stock fastboot stalled

**Symptoms:** `fastboot` hangs in `download:`, LK no longer answers. LK is wedged until the tablet resets: hold
**Power ~15 s**, enter LK fastboot again, use `tools/fbusb`.

## BROM and mtkclient

Last resort, works with any eMMC content (bad `boot`/`recovery`, broken GPT, a BCB in `para`). Needs the stage-1
dump in `backup/partitions/` and mtkclient in `tools/mtkclient/` (see `01-backup-unlock-root.md`).
1. Power off completely (hold Power 10–15 s with USB unplugged).
2. Start mtkclient **with sudo from a real terminal** (it prompts and waits for the device), e.g.
   `cd tools/mtkclient && sudo ../venv/bin/python mtk w boot,recovery ../../backup/partitions/boot.bin,../../backup/partitions/recovery.bin`.
3. Hold **Vol+ and Vol−**, plug in USB; release once mtkclient reports the handshake.
4. Afterwards: `sudo chown "$USER" tools/mtkclient/hwparam.json` (sudo leaves it root-owned).

The GPT fallback is `backup/partitions/gpt.bin` and `gpt_backup.bin`.

## Never write

- `lk`, `preloader`, `seccfg`, `nvram`, `nvdata`, `protect1`, `protect2`, `para`. The one exception is restoring
  your own `para` backup from BROM to remove a BCB.
- Never write a BCB (`boot-recovery`) to `para`: LK never clears it, it forces `recovery` on every boot and hides
  the Vol+ menu; only BROM undoes it.
- Partition backups (`backup/`) contain the IMEI, NVRAM and calibration data of this device. Never publish or
  commit them.
