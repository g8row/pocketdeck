# Building

All device images build in Docker, on an arm64 host natively or on x86_64 as a cross build. Without local Docker,
set `PD_BUILD_HOST` (an ssh alias) and `PD_BUILD_DIR` in `.pd.env`: `pd build` then rsyncs `device/` there, runs
the same scripts, and copies the outputs back into `device/out/`, `device/rootfs/out/` and `device/gpu/out/`.

| Command | Produces | Script |
|---|---|---|
| `pd build kernel` | `device/out/`: `initramfs.cpio.gz`, `boot-mainline.img` (LK-bootable), `u-boot-tb7304x.img`, `boot-mainline-uboot.img` (what U-Boot boots; slots and `pd ramboot`), `tbstate`, tablet tools, `BUILDINFO`, `kernel-build.log` | `device/build/build.sh` |
| `pd build wcn` | compile check of the WiFi driver only | `device/build/wcn-build.sh` |
| `pd build rootfs` | `device/rootfs/out/rootfs.img` (Alpine 3.24, ext4, 512 MiB; grown on install) | `device/rootfs/build-rootfs.sh` |
| `pd build mesa` | `device/gpu/out/mesa-opt.tar.gz` (Mesa 24.3 Panfrost, no LLVM, for `/opt/mesa`) | `device/gpu/build-mesa.sh` |
| `pd build all` | kernel, then rootfs | |
| `pd deploy` | the UI host + bundle, built locally (Rust musl + Zig + Bun), installed on the tablet | `tools/pocketjs-deploy.sh` |

## Inputs

- **Kernel:** `gitlab.com/mt6735-mainline/linux`, branch `mt6735-stable-7.0.y` (tag `v7.0.10-mt6735`, 046883c),
  cloned into `device/src/linux` on first build. Base config from pmaports' `linux-postmarketos-mediatek-mt6735`
  (sparse clone into `device/src/pmaports`), plus `device/patches/config-tb7304x.fragment`. Our changes:
  `device/patches/0*.sh` (idempotent tree edits: new drivers, DTS hookup) and `0*.patch` (skipped when applied).
- **U-Boot:** `gitlab.com/mt6735-mainline/u-boot`, pinned by `PIN=` in `device/u-boot/build-uboot.sh`, plus the board
  files and patches in `device/u-boot/`.
- **Stock firmware:** `backup/partitions/boot.bin` (stage 1 dump, mounted read-only at `/stock`): the build checks
  that it repacks byte-identically with our mkbootimg settings and makes a stock-kernel control image from it.
  The stock DTB that U-Boot carries for LK is committed as `device/stock/stock.dtb` (decompiled: `stock.dts`).
- **Container:** `tb7304-build` (Debian trixie, gcc 14.2, Debian mkbootimg, busybox-static), object volumes
  `tb7304-kbuild` and `tb7304-ubuild`. Incremental builds take about a minute; a cold one several.

## Checks the build enforces

- The LK cmdline (≤ 99 characters), the 28 MiB gunzip limit for LK, the kernel's end below ATF's reserved memory.
- U-Boot's image must pass `device/analysis/lk_image_check.py`, else it is renamed `*.REJECTED`. U-Boot is built
  with no flash-writing features except `tbstate`.
- A failing kernel compile stops the build (the log is `device/out/kernel-build.log`).

## Build identity

`build.sh` passes `git describe --always --dirty` (from the checkout `pd` runs in) into the kernel as
`KBUILD_BUILD_VERSION`, so `uname -v` shows `#<describe>` instead of a per-machine counter, and writes
`device/out/BUILDINFO` (describe, time, kernel/U-Boot commits, image hashes). `pd install` stores it on the tablet in
`/data/pocketdeck/slot-<x>.kernel`; `pd state` prints it. Kernels before this change show `#18`-style numbers that
differ between build machines.

## Mesa

Alpine's `mesa-dri-gallium` pulls LLVM (~210 MB), too big for the root. `build-mesa.sh` cross-builds Mesa 24.3.4 with
only Panfrost + kmsro using Zig against Alpine's aarch64 packages (needs `PD_ZIG_TARBALL`, an x86_64 Zig release
tarball; the container runs as linux/amd64 because the build host need not emulate arm64). Executables must be
PIE, and the shader disk cache is off (no ELF build-id). 24.3 because later Panfrost needs `mesa_clc` on the
build host.

## Reproducibility

Content is reproducible, bytes are not (timestamps, build version). Compare builds by what they contain, and
identify installed ones by BUILDINFO.
