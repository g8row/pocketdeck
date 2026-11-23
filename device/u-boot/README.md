# U-Boot for the TB-7304X (chainloaded by stock LK)

U-Boot 2023.04-rc1 from the mt6735 fork, pinned at `3d74bf1686`, packed as an Android boot image that stock LK
loads like a kernel. Status, test history and the next plan:
[docs/mainline/handoff-uboot-2026-11-17.md](../../docs/mainline/handoff-uboot-2026-11-17.md).

## Status (2026-11-17)

| | |
|---|---|
| ✅ | Console on LK's framebuffer, USB fastboot (`0e8d:201c`), `fastboot boot` of mainline Linux, eMMC read |
| ✅ | `tbandroid` boots stock Android + Magisk in **normal** mode: patches `atag,boot` and `/firmware/android/mode` |
| ✅ | **Deterministic start from LK** since the image is padded: T1 passed in the state where the old image hung |
| ✅ | `fastboot continue` carries on with the default target (fixed by patch 0002; it used to reset the tablet) |
| ✅ | Linux is the default: `boot.cmd` boots the raw slot `tbkern_<slot>` with root `tbroot_<slot>`; Android is one-shot/default via `tbstate` |

**Why the old image looped:** LK reads the DTB it hands over from the last 512 KiB of the kernel area **in the
partition**. Our 0x5883b-byte kernel area made that read underflow, and LK fell back to whatever DTB the previous
boot left in RAM. `build-uboot.sh` now zero-pads the gzip stream so the kernel area is ≥ 512 KiB. It refuses to
output an image that fails `mainline/scripts/analysis/lk_image_check.py`. Details:
[research-lk-bootflow.md](../../docs/mainline/research-lk-bootflow.md).

Since 2026-11-17 12:46, U-Boot is in **`boot`** and Android in **`recovery`**, as decided in
[plan-dualboot.md](../../docs/mainline/plan-dualboot.md). T3 passed. Escape: hold Vol+ at power-on → Recovery
(LK boots Android directly). Never write a `boot-recovery` BCB to
`para`: LK never clears it, it hides the volume-key menu, and only BROM (mtkclient) gets the tablet back.

## Files

| File | Role |
|---|---|
| `tb7304x_defconfig` | Board config (text base `0x40080000`, top 16 MiB hidden, WDT 15 s, hush, MMC, video console, fastboot RAM only) |
| `mt6737m-lenovo-tb7304x.dts` | Control DT: simple-framebuffer `0x7f7b0000`, `mmc0` without pinctrl/regulators, USB peripheral |
| `tb7304x_entry.S` | Saves LK's DTB pointer (`x0`), paints the "entered" band |
| `tb7304x_debug.c` | Bands, LK display hand-over (OVL0 L0/L3), console start (`console_init_r`), status lines |
| `tb7304x_android.c` | `tb_lk_info` (reads LK's DT, picks `android_part`), `tbandroid` command |
| `boot.cmd` | Boot script, becomes the image's ramdisk. Target from the boot record (oneshot > default, default **linux**). Linux from the raw slot `tbkern_<slot>` (fallback `/cache/linux/boot-mainline-uboot.img`), passing `tb.slot=` on the cmdline. Counts Linux attempts; `tbrescue` after 3 unhealthy ones, then Android. LK bootmode 7/8/9 (alarm, charger) → Android |
| `tbstate.h`, `tb7304x_tbstate.c` | Boot record format (shared with `mainline/initramfs/tbstate.c`) and the `tbstate` command: the only eMMC writes U-Boot makes, limited to the two record sectors of the 1 MiB `tbstate` partition (docs/mainline/plan-dualboot.md §4) |
| `0001-musb-mt6735-register-dm-gadget-udc.patch` | Fixes the fork's MT6735 MUSB glue for DM gadget (fastboot) |
| `0002-musb-mt6735-unregister-udc-on-remove.patch` | Unregisters the UDC before the glue frees the musb on remove; without it `fastboot continue` / Ctrl-C used freed memory and reset the tablet |
| `build-uboot.sh` | Builds in the `tb7304-build` container. Pads the kernel area to ≥ 512 KiB and gates on `lk_image_check.py`. Outputs `out/u-boot-tb7304x.img` and `out/boot-mainline-uboot.img`. The build host also needs `mainline/scripts/analysis/lk_image_check.py`. |

## Build and install

```sh
scp mainline/u-boot/* $BUILD_HOST:$BUILD_DIR/mainline/u-boot/
ssh $BUILD_HOST "M=$BUILD_DIR/mainline; docker run --rm -v \$M:/m -v tb7304-ubuild:/uout tb7304-build bash /m/u-boot/build-uboot.sh"
scp $BUILD_HOST:$BUILD_DIR/mainline/out/u-boot-tb7304x.img mainline/out/
```

**U-Boot lives in `boot`, never in `recovery`** — `recovery` holds Android + Magisk now. From LK fastboot, write it
to `boot` (the image passes `lk_image_check.py`):

```sh
mainline/scripts/fbusb mainline/out/u-boot-tb7304x.img flash:boot
# or, from a Linux host with the tablet in LK fastboot:
mainline/scripts/linux-test.sh flash mainline/out/u-boot-tb7304x.img boot
```

Stock `fastboot` stalls on LK downloads; LK itself has no `fastboot boot`. U-Boot does, and that is the RAM-test
path. Do not write a `boot-recovery` BCB to `para`.
