# kiosk: PocketJS without the Android framework

Kiosk mode keeps Lenovo's kernel and drivers but stops `zygote`, `system_server`, SurfaceFlinger and everything
above them. `pocketjs-kiosk` then draws straight to `/dev/graphics/fb0` (rotated, BGRA, with a pan after each
changed frame) and reads the `mtk-tpd` touchscreen from `/dev/input`. `adbd` is native, so USB and deskd keep working.

| | Android mode | Kiosk mode |
|---|---|---|
| MemAvailable | ~460–500 MB | ~705 MB |
| Frame cost (early desk app) | 2.4 ms mean / 6 ms worst | 0.56 ms mean / ~4 ms worst |

## Build and deploy

```bash
cd ../pocketjs/hosts/android
cargo ndk -t arm64-v8a -P 24 build --release --bin pocketjs-kiosk
adb shell mkdir -p /data/local/tmp/kiosk/bundle
adb push target/aarch64-linux-android/release/pocketjs-kiosk /data/local/tmp/kiosk/
adb push ../../../kiosk/kiosk.sh ../../../kiosk/udhcpc.sh ../../../kiosk/tap.sh /data/local/tmp/kiosk/
# bundle/ holds app.js, app.pak and viewport, the same files build.sh stages into the APK's assets
```

## Use

```bash
adb shell su -c 'sh /data/local/tmp/kiosk/kiosk.sh start'    # framework off, kiosk on
adb shell su -c 'sh /data/local/tmp/kiosk/kiosk.sh restart'  # new binary or bundle, Android stays off
adb shell su -c 'sh /data/local/tmp/kiosk/kiosk.sh stop'     # Android back (~15 s), Wi-Fi re-enabled
```

The **power button** inside kiosk mode also returns to Android. If the kiosk process exits on its own, Android is
restarted automatically.

**Wi-Fi without the framework** goes through these steps, in `kiosk.sh`:
1. power on the chip with `echo 1 > /dev/wmtWifi`;
2. start `wpa_supplicant` with the saved networks;
3. get an address with busybox `udhcpc` (`udhcpc.sh`).

This needs one narrow SELinux rule, applied live only and gone on reboot: `allow wpa magisk unix_dgram_socket sendto`.
SELinux stays enforcing.

`tap.sh X Y` injects a tap at landscape coordinates. It is handy for testing over adb.

> Kiosk mode survives until reboot only. Nothing here is installed at boot, and a reboot always lands in normal Android.
