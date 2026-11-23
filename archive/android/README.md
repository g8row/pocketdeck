# Android era (archive)

Before Linux, the tablet ran rooted stock Android 7 as the desk display. What is left here:

| Path | Status |
|---|---|
| [debloat/](debloat/README.md) | **Still required:** the `tb7304x_strip` Magisk module. Without it Android's system_server crashes on this firmware and boot never completes, which matters because Android is the rollback system in `recovery` ([install stage 1](../../docs/install/01-backup-unlock-root.md)). Package lists: `packages-{stock,stripped}.txt` |
| [kiosk/](kiosk/README.md) | Historical: PocketJS drawing to the framebuffer with the Android framework stopped |

The Android PocketJS host (APK, `pocketjs/hosts/android/build.sh`) is frozen. The Linux UI is built from the same
crate (`pocketjs-kiosk`, musl) until pocketjs gets `hosts/linux`.

Android-side tuning that mattered (if Android is ever used as the display again): MTK hotplug parked 2 cores and the
clock bounced 221 MHz ↔ 1.09 GHz (18–49 ms frame spikes): `/proc/hps/num_base_perf_serv=4` and an 858 MHz floor
(the module's `service.sh`). wgpu over GLES on the Mali blob was ~4× slower than the software renderer.

Docs from that period: [docs/history](../../docs/history/README.md).
