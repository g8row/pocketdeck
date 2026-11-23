# Stage 1 · Back up, unlock, root

Stage 1 of 5 · **you are here:** stock Android · **you need:** stage 0, mtkclient · **you end with:** a full
partition dump in `backup/partitions/`, an unlocked bootloader, Android with Magisk root and the `tb7304x_strip`
module
Previous: [00](00-prerequisites.md) · Next: [02 repartition](02-repartition.md) · If it fails: [recovery](recovery.md#brom-and-mtkclient)

Why root: Android stays on the tablet as the rollback system (stage 3 moves it to `recovery`), and its root shell is
one of the ways to repair the Linux side. The dump is the only way back to stock, and the builds read the stock
DTB and LK from it.

## 1. Full backup (BROM)

Power the tablet off, hold **Vol+ and Vol−**, plug in USB. mtkclient waits with `Waiting for PreLoader VCOM`.
Run it from a real terminal (it may need `sudo`; afterwards `chown` `tools/mtkclient/hwparam.json` back to you).

```sh
git clone https://github.com/bkerler/mtkclient tools/mtkclient
python3 -m venv tools/venv && tools/venv/bin/pip install -r tools/mtkclient/requirements.txt
cd tools/mtkclient
../venv/bin/python mtk rl ../../backup/partitions        # every partition, ~4.6 GB, incl. gpt, lk, boot, nvram
```

Copy `backup/` somewhere safe as well. **Never publish it:** `nvram`/`nvdata` hold the IMEI and calibration.
`.gitignore` excludes `backup/`.

## 2. Unlock

```sh
../venv/bin/python mtk da seccfg unlock                  # rewrites seccfg; on our unit userdata was NOT wiped
```

From now on LK shows the "Orange State" warning for 5 s on every boot; only relocking removes it.

## 3. Magisk

1. Get the Magisk APK (v31.1 was used) and patch `backup/partitions/boot.bin` with it (on the tablet: *Install →
   Select and patch a file*, then pull the result to `tools/magisk/magisk-boot.img`).
2. Write it (BROM again): `../venv/bin/python mtk w boot ../magisk/magisk-boot.img`
3. Boot, `adb install` the APK, open it once, grant root to the shell: `adb shell su -c id` → `uid=0`.

Keep `magisk-boot.img`: stage 3 puts it into `recovery`.

## 4. The `tb7304x_strip` module (required)

```sh
adb push archive/android/debloat/module /data/local/tmp/tb7304x_strip
adb shell su -c 'cp -r /data/local/tmp/tb7304x_strip /data/adb/modules/ && chmod 755 /data/adb/modules/tb7304x_strip/service.sh'
tools/linux-test.sh to-fastboot     # NOT a bare `adb reboot`: see below
```

Without this module `system_server` crashes in PackageManagerService on this firmware and boot never completes.
Magisk counts boots that never complete and disables all modules after 2, which makes that permanent. So:
**leave Android only through `tools/linux-test.sh` or `pd reboot`**, which wait for `sys.boot_completed` and
reset Magisk's counter first. Details: [archive/android/debloat](../../archive/android/debloat/README.md),
[recovery](recovery.md).

Done when: `adb shell getprop sys.boot_completed` prints `1` and `adb shell su -c id` is root.

Next: [02 repartition](02-repartition.md)
