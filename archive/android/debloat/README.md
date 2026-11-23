# debloat: the `tb7304x_strip` Magisk module

This module turns the stock TB-7304X into a lean desk display. It is **systemless**: nothing on `/system` is
modified, and deleting the module and rebooting restores stock behaviour.

## What it does

**Hides 83 system apps** (`module/system/**/.replace`). These include:
- Google Play Services, Play Store, Gboard and the Google apps;
- Lenovo OTA, privacy, launcher and launcher provider;
- MTK test and engineering tools;
- wallpapers, the print spooler and other apps a desk display never uses.

`remove.txt` is the full list, and `../backup/packages-{stock,stripped}.txt` show 124 → 45 packages.
`data-apps.txt` lists updates installed in `/data` that had to be uninstalled by hand once. Don't `pm uninstall`
GmsCore on Android 7: its shared UID crashes system_server.

**Applies a boot profile** (`module/service.sh`, which runs after `sys.boot_completed`):
- marks the device as provisioned (the setup wizards are gone);
- turns off all animations;
- keeps the screen on while plugged in;
- runs `dev.pocketjs.shell` in immersive mode;
- applies the **perf profile**: all 4 cores online (`/proc/hps/num_base_perf_serv=4`; MTK hotplug otherwise parks
  two) and an 858 MHz minimum clock. This took the worst frame from 18–49 ms to ~6 ms;
- stops native services a desk never needs: MTK loggers, engineering mode, video and Wi-Fi calling, GPS/AGPS,
  device-management agents, battery warning and camera. The modem daemons stay up;
- turns **LTE off and keeps Wi-Fi on**: airplane mode is limited to the cellular radio (`airplane_mode_radios=cell`).

## Install / remove

```bash
adb push module /data/local/tmp/tb7304x_strip
adb shell su -c 'cp -r /data/local/tmp/tb7304x_strip /data/adb/modules/'
adb reboot
# remove:  adb shell su -c 'rm -rf /data/adb/modules/tb7304x_strip' && adb reboot
# disable: adb shell su -c 'touch /data/adb/modules/tb7304x_strip/disable' && adb reboot
```

After every change, reboot and check that `getprop sys.boot_completed` is `1` and `adb logcat -b crash -d` is empty.

You will want a keyboard: we installed [Simple Keyboard](https://f-droid.org/packages/rkr.simplekeyboard.inputmethod/)
from F-Droid (650 KB).
