# Mainline Linux on the Lenovo TB-7304X (MT6737M): bring-up and current system

Status (2026-11-19): **mainline 7.0.10 is the tablet's main system.** U-Boot in `boot` boots Alpine from the
internal eMMC (kernel slot `tbkern_a`, root `tbroot_a`) by default; Android + Magisk stay in `recovery`.
Display (mediatek-drm, 60 Hz), touch, buttons, all 4 CPU cores, eMMC, USB, WiFi, charger/battery/RTC/thermal,
accelerometer, IOMMU and the PocketJS kiosk work. Current support, measurements and the ordered todo list:
[docs/mainline/STATUS.md](../docs/mainline/STATUS.md).

> Section 0 below is the **2026-11-16 bring-up record**, not the current hardware status. The live layout is
> U-Boot in `boot`, Android in `recovery`, and Linux by default from the raw slots
> ([plan-dualboot.md](../docs/mainline/plan-dualboot.md)). Anything LK boots directly must pass
> `scripts/analysis/lk_image_check.py` ([research-lk-bootflow.md](../docs/mainline/research-lk-bootflow.md) §4).

## 0. Bring-up results (2026-11-16)

> Historical snapshot. For the current state see [docs/mainline/STATUS.md](../docs/mainline/STATUS.md).

| Area | State | Notes |
|---|---|---|
| Boot | works (then) | `fb_send.py out/boot-mainline.img flash:recovery`, then `fb_send.py - "oem reboot-recovery"` (TEST-PLAN.md). |
| Display | works, simpledrm (then) | See "Display findings" below. No DRM pipeline or panel driver at the time. |
| Touch | works | Goodix GT9293 on i2c1 @0x5d, `goodix,gt911` compatible, portrait coordinates, no axis swap. |
| Buttons | work | Vol+/Vol- on the SoC keypad (`mediatek,mt6779-keypad` @0x10003000), Power via `mt6328-keys`. |
| CPUs | all 4 work, hotplug works | New enable-method `mediatek,mt6735-smp` (`patches/smp_mt6735.c`). See "SMP findings". |
| USB | works (peripheral) | Legacy CDC gadget `0525:a4aa` (ECM + ACM) takes the UDC. Device 172.16.42.1, telnet without login. |
| eMMC | probes (then) | Not mounted by `init` at the time; now the root is on `tbroot_a`. |
| WiFi/BT | no driver (then) | MT6625L via CONSYS had no mainline driver then; WiFi works now and BT is WIP (STATUS.md). |
| Charger, battery, RTC, thermal, sensors | not done (then) | All implemented now (STATUS.md). |
| IOMMU (M4U) | deferred (then) | "mm dts parse fail". SMI larbs had no IOMMU at the time; display now runs through it. |

### Boot and tooling findings
- LK's fastboot has no `boot`, and the stock `fastboot` tool stalls in the `download:` data phase.
  `scripts/analysis/fb_send.py` (pyusb, 1 MiB bulk writes) uploads reliably. Usage: `fb_send.py <file> <cmd>`,
  or `fb_send.py - "<cmd>"` to send a command only.
- **LK keeps only 99 characters** of the boot image's cmdline. `build-in-docker.sh` fails the build if ours is longer.
  LK prepends its own items (including `console=tty0`).
- `scripts/mlsh.py` is a telnet shell to the tablet. `mlsh.py wait` waits for the gadget and touches `/tmp/stay`
  (this cancels the 300 s auto-reboot). On the host, use a dedicated NetworkManager profile for the tablet's `enx*`
  interface, with 172.16.42.2/24 and `never-default`. **Never run `nmcli d connect`**: it can move the host's main
  wired profile onto the tablet link.
- `reboot -f` can hang. `echo b > /proc/sysrq-trigger` always works.

### Display findings
- LK leaves OVL0 (0x14007000) scanning its framebuffer at 0x7f7b0000 (600x1024, pitch 2432) in DSI video mode.
  `mtk-lk-fb` hands that framebuffer to simpledrm.
- **fbcon** (`console=tty0` comes from LK) clears and redraws fb0, wiping anything else drawn there. `init` unbinds it.
- OVL0 **layer 3** (0x7fa10000) holds LK's "orange state" warning overlay. Disabling the layer (SRC_CON bit 3)
  **stalls OVL** until reset: the screen shows RGB columns or goes black. Setting its constant alpha to 0
  (`L3_CON` 0x14007090, low byte) hides it safely. `init` does that.
- **The mainline `mt6735.dtsi` display addresses are wrong for this chip.** The stock DTB has RDMA0 0x14009000,
  DSI0 0x14012000, MUTEX 0x14013000 and MIPI_TX 0x14018000; the dtsi has 14008000, 14011000 and 14017000.
  Wrong addresses read back `0x1234`. This must be fixed before `DRM_MEDIATEK` can drive the panel.
- With no IOMMU bound, `mtk_smi_larb_resume` dereferenced `larb->mmu` (NULL). Patch 0002 skips the port
  configuration in that case.
- `init` has a display-register watcher (`[disp]` lines in dmesg and `/www/disp.log`). Turn it off with `tb.dispwatch=0`.

### SMP findings
- The stock ATF's PSCI `CPU_ON` only records the entry point. It does not power the core.
  The stock kernel's `enable-method = "mt-boot"` calls PSCI `CPU_ON` and then powers the core's MTCMOS domain
  itself through the SPM (0x10006000). This is the "firmware issue" the Doogee DTS mentions.
- `patches/smp_mt6735.c` does the same in mainline:
  - It is hooked into `arch/arm64/kernel/cpu_ops.c` by `patches/0003-arm64-mt6735-smp.sh`.
  - Before each SPM write it writes the project key `0x0b160001` to `POWERON_CONFIG_SET`.
  - Power-on order: `PWR_ON`, then `PWR_ON_2ND`; wait for the status bits; clear `ISO`; clear `L1_PDN` and wait for
    its ack; set `SRAM_ISOINT_B`; clear `SRAM_CKISO` and `CLK_DIS`; set `RST_B`.
  - Hotplug off does the reverse, after the core is in WFI.
- Verified on the tablet:
  - All 4 cores come up at boot (`SMP: Total of 4 processors activated`).
  - A 4-way busy loop runs at about 88% on every core, and timer interrupts and IPIs reach every core.
  - cpu3 goes offline and back online, and powers back on from `PWR_CON=0x32`.
- This should also work on other MT6735/MT6737 devices running stock ATF.

## TL;DR (2026-11-16 research snapshot)

> For the current system see [docs/mainline/STATUS.md](../docs/mainline/STATUS.md); these were the findings that
> started the bring-up.

- A working MT6735-family mainline kernel exists: **gitlab.com/mt6735-mainline/linux**, 7.0.10, the same one postmarketOS
  packages as `linux-postmarketos-mediatek-mt6735`. Our MT6737M is close to the Doogee X5 Pro (MT6735P) in that tree.
- **Stock LK has no `fastboot boot` command** (found by disassembly, details below). A RAM-only test through LK fastboot
  was therefore expected to fail. At the time the fallback was flashing the **recovery** partition (backed up) and
  running `fastboot oem reboot-recovery`. The chainloaded U-Boot now provides `fastboot boot`; see
  [plan-dualboot.md](../docs/mainline/plan-dualboot.md).
- Built: `out/boot-mainline.img` (mainline + new DTS + sign-of-life initramfs), `out/boot-mainline-noovl.img`
  (safer framebuffer probing), and `out/boot-stock-kernel-initramfs.img` (control: stock 3.18 kernel + same initramfs).
  All use the stock header layout, which we verified by re-packing the stock `boot.bin` byte-for-byte.
- Sign of life without a panel driver:
  - The screen is painted red, then green, then blue, on the framebuffer LK left running.
  - A USB gadget (ACM serial shell + ECM ethernet 172.16.42.1 with telnet and http) shows up on the Mac.
  - The tablet reboots itself after 300 s.

## 1. Research findings

### Mainline MT6735 / MT6737 state
- Kernel tree: `https://gitlab.com/mt6735-mainline/linux`, branch `mt6735-stable-7.0.y`, tag `v7.0.10-mt6735`,
  commit **046883c0c2b956fd7436d3c1156f25512d1f6a90** ("arm64: dts: mediatek: Add support for Doogee X5 Pro", 2026-05-30).
  Other branches include `mt6735-staging` (newer work), `mt6735-stable-6.19.y` and the older `6.1.y`. Maintainer:
  Yassine Oudjana (Tooniis).
- postmarketOS: `device/*/linux-postmarketos-mediatek-mt6735` in pmaports (we used commit
  `ce3ebdba08cdd09a6fb9a01da7d750f05638a25e`) packages exactly that tag, pkgver 7.0.10. We took its kernel config as our base.
  The only pmOS device that used it, `samsung-grandpplte` (MT6737T), is now **archived**. It booted through U-Boot,
  not stock LK.
- DTS in the tree: `mt6735.dtsi`, `mt6735m.dtsi` (MT6735M/P pinctrl + pwrap variant), `mt6328.dtsi` (PMIC),
  `mt6735p-doogee-x5pro.dts` and `mt6737t-samsung-grandpplte.dts`.
- Drivers present for the platform:
  - clocks (topckgen, apmixed, infra, peri, mm, img, vdec, venc, mfg), pinctrl, pwrap + MT6328 regulators and keys
  - SCPSYS power domains, mtk-sd MMC, musb USB + tphy, i2c, watchdog, SMI/M4U
  - DRM display path (ovl, rdma, color, dither, dsi, mipi-tx), Mali-T720 node (panfrost)
  - The pmOS 6.1.9 update notes say DRM display "replaces simplefb".
- Known caveats from the Doogee DTS:
  - "Secondary CPUs are broken on this platform due to firmware issues": only CPU0 is used.
  - The VEN power domain does not come up.
  - The Doogee DTS boots with `clk_ignore_unused pd_ignore_unused regulator_ignore_unused`.
- Gaps for this tablet:
  - **WiFi/BT/GPS/FM (MT6625L via CONSYS/WMT): no mainline driver.** Biggest blocker for daily use.
  - Panel: a DSI panel driver is needed for whichever LCM it has (below). Until then, simplefb on LK's buffer.
  - Touch: Goodix GT9293 is supported by the mainline `goodix` driver. FocalTech FT5x46 by `edt-ft5x06`.
  - Charger SM5414: no mainline driver. Battery/fuel gauge: none.
  - Modem: none. Audio: none.
- **MT6737M vs MT6735:** MediaTek's MT6737/MT6737M/MT6737T are re-spins of MT6735/MT6735M (same CPU cluster, same
  peripheral map). The device reports `ro.hardware=mt6735`, and the stock DTB says `model = "MT6735M"` with
  `mediatek,mt6735m-*` compatibles. The postmarketOS wiki redirects the MT6737 and MT6737M pages to MT6735. So we use
  `mt6735m.dtsi` unchanged. Not verified: per-chip efuse/speed-bin differences (they only matter for DVFS, which we don't use).
- Similar tablets: no mainline port for any Lenovo MT6735/MT6737 tablet was found. The closest base is the Doogee X5 Pro DTS.

### Stock LK (bootloader) — from disassembling `backup/partitions/lk.bin`
The analysis scripts are in `scripts/analysis/`. The LK image has a 0x200-byte MTK header. Code is ARM32/Thumb-2,
linked at 0x41E00000 (taken from the reset-vector literals), position-independent (`ldr rX,[pc]; add rX,pc`).
Fastboot product string: `HQ8735B_TB_N`.
- **Fastboot commands registered** (one function at 0x41e20dfe..0x41e20f82):
  - `getvar:`, `download:`, `flash:`, `erase:`, `continue`, `reboot`, `reboot-bootloader`
  - `oem p2u`, `oem reboot-recovery`, `oem append-cmdline`, `oem off-mode-charge`
  - The string `boot` exists only as the tail of `fastboot`. It is used elsewhere as a partition name, never in that
    function. **Conclusion: LK has no `fastboot boot`** (it answers "unknown command"). Our chainloaded U-Boot does
    provide it; see [plan-dualboot.md](../docs/mainline/plan-dualboot.md).
- Kernel loading (function around 0x41e1f480):
  - It checks `hdr->kernel_addr & 0x7FFFF == 0`; otherwise "64 bit kernel can't boot at …".
  - It finds the DTB by **scanning backwards from the end of the kernel blob for `d0 0d fe ed`**, so an appended DTB
    works, same as stock.
  - It gunzips the kernel to `kernel_addr` with a **max output of 0x1C00000 (28 MiB)**. Our Image is 26.9 MB, so it fits
    with 2.4 MB headroom. `build-in-docker.sh` checks this limit.
- MTK 512-byte "mkimg" headers on the kernel/ramdisk are **optional** (LK logs "no mkimg header in kernel image" and
  carries on). The stock image has none.
- LK passes `/chosen` properties to the kernel: `atag,videolfb` (fb_base, islcmfound, fps, vram, lcmname),
  `atag,boot`, `atag,mem`, `atag,devinfo`, `atag,mdinfo`, `atag,meta`, `linux,initrd-*`, and `bootargs`.
  It also rewrites `/memory` from its mblock table and needs `bootopt=64S3,32N2,64N2` in the cmdline to pick a 64-bit
  boot. Its default cmdline string mentions `console=ttyMT3,921600n1`.
- Not proven from the binary: whether LK leaves the hardware watchdog (TOPRGU) armed when it jumps to the kernel.

### Stock boot image (`backup/partitions/boot.bin`)
- Android boot header v0, page 2048, `kernel_addr 0x40080000`, `ramdisk_addr 0x44000000`, `second_addr 0x40f00000`,
  `tags_addr 0x4e000000`, so base 0x40000000 with offsets kernel 0x80000, ramdisk 0x04000000, second 0x00f00000,
  tags 0x0e000000.
- Other header fields: os_version 7.0.0 / 2018-07, board/name `1535456354`, cmdline `bootopt=64S3,32N2,64N2`.
- Kernel: gzip arm64 Image (17.8 MB, `Linux version 3.18.35+ … Tue Aug 28 2018`, build path
  `ZA1962_601__A/kernel-3.18`), followed by a 65694-byte DTB.
- No MTK headers. The ramdisk is the stock Android one, not Magisk's.
- `mkbootimg --base 0x40000000 --kernel_offset 0x80000 --ramdisk_offset 0x04000000 --second_offset 0xf00000
  --tags_offset 0x0e000000 --pagesize 2048 --header_version 0 --os_version 7.0.0 --os_patch_level 2018-07 --board 1535456354`
  re-creates `boot.bin` **byte-identically**. We also patch second_addr back to 0x40f00000, because Debian's mkbootimg
  writes 0 there.

### Stock DTB (`stock/stock.dts`, decompiled)
- Model `MT6735M`, compatible `mediatek,MT6735M`. PSCI 0.1 (`method = "smc"`, cpu_on 0x84000003). 4× Cortex-A53.
- Memory placeholder `0x40000000 + 0x1f000000`; LK rewrites it (real RAM is 1 GB).
- Reserved memory:
  - ATF @0x43000000 (+0x30000)
  - `ram_console` @0x43f00000, `pstore` @0x43f10000 (+0xe0000), `minirdump` @0x43ff0000
  - CCCI modem (dynamic, 0x3810000), CONSYS (dynamic, 1 MB)
- MTKFB node: `reg = <0x7f000000 0x1000000>`, top 16 MB of the 1 GB. This is a placeholder: the real address comes from
  LK's `atag,videolfb`.
- UARTs: `apuart0..3` @0x11002000/3000/4000/5000. Stock bootargs `console=ttyMT0,921600n1`. No UART pads are known.
- eMMC: msdc0 @0x11230000, 8-bit, HS200/HS400 1.8 V. SD: msdc1 @0x11240000, 4-bit UHS.
- USB: `usb20@11200000` (musb), phy @0x11210000, `drvvbus` GPIO 83, `iddig` GPIO 67.
- I2C buses:
  - i2c0: cameras 0x10 / 0x3c
  - **i2c1: touch Goodix `cap_touch@5d`** (kernel strings: `GT9293,BOE`, `GT9293,GX`, `GT9293,NEW_GX`), alternative
    FocalTech FT5x46 `@38`. Touch EINT 10, `tpd-resolution 600x1024`, 5 fingers.
  - i2c2: accelerometer `@4c` / `@18`, capsensor `@28` / `@20`
  - **i2c3: charger SM5414 `@49`** (EINT 68, chgen GPIO 124, nINT GPIO 68, shdn GPIO 63)
- **PMIC: MT6328** via pwrap (kernel strings `mediatek,mt6328`, `mt6328_dump_register`). Keypad: hardware power key
  plus volume keys on the keypad matrix (map 0x73 / 0x72).
- **LCM** (panel): GPIOs `gpio_lcd_pwr` 83, `gpio_lcd_rst` 146. LK and the kernel contain four drivers and pick one by
  reading the panel ID:
  - `nt51021b_dsi_vdo_dj`
  - `nt51021b_dsi_vdo_gx`
  - `nt35521z_dsi_vdo_gx`
  - `hx8394d_dsi_vdo_boe`

  All are DSI video mode. Which one this unit has is **unknown**. A cheap read-only check on Android:
  `adb shell su -c 'dmesg | grep -i -m5 lcm; cat /proc/cmdline'`. Our test kernel also prints it (`lkfb:` line).

## 2. What we built

| File | Purpose |
|---|---|
| `dts/mt6737m-lenovo-tb7304x.dts` | Minimal board DTS (from the Doogee X5 Pro DTS and the stock DTB). See below. |
| `patches/mtk-lk-fb.c` | New tiny driver, `CONFIG_MTK_LK_FB`. See below. |
| `patches/0001-soc-mediatek-mtk-lk-fb.sh` | Idempotently adds the driver and DTS to the kernel tree (Kconfig, Makefile, dts Makefile). |
| `patches/0002-memory-mtk-smi-skip-larb-port-config-without-iommu.patch` | Fixes a NULL dereference in `mtk_smi_larb_resume` when no IOMMU is bound. |
| `patches/0003-arm64-mt6735-smp.sh`, `patches/smp_mt6735.c` | The `mediatek,mt6735-smp` enable-method: PSCI CPU_ON plus the SPM power-on. |
| `scripts/analysis/fb_send.py`, `scripts/mlsh.py` | pyusb fastboot client (upload, flash, oem); telnet shell to the running tablet. |
| `patches/config-tb7304x.fragment` | Appended to the pmOS config. See below. |
| `initramfs/init`, `initramfs/lkpaint.c` | Busybox init and a static screen-fill tool. Work on both mainline and the stock 3.18 kernel. See below. |
| `scripts/Dockerfile`, `scripts/build.sh`, `scripts/build-in-docker.sh` | Reproducible build (OrbStack/Docker, Debian trixie arm64, native gcc 14.2, Debian `mkbootimg` 34.0.5, busybox-static 1.37.0). |
| `scripts/analysis/*.py` | LK disassembly helpers: string references and Thumb disassembly with string annotation. |
| `stock/` | Stock kernel, `Image`, `stock.dtb`/`stock.dts`, `lk.strings` (all extracted from backups). |
| `wcn/`, `patches/0011-wcn-mediatek.sh` | MediaTek CONSYS WiFi driver (WMT/STP/BTIF + wlan_gen2), copied into the kernel as `drivers/misc/mediatek`. Origin in `wcn/README.md`, bring-up in docs/mainline/research-wifi.md. |
| `wcn-tools/` | `wmt_loader`, `stp_uart_launcher` (built static into `out/`). |
| `rootfs/overlay/usr/local/sbin/wifi-up` | On the tablet: radio on, optional join + DHCP, `wifi-up off`. |
| `out/` | Build outputs plus `SHA256SUMS`, `kernel.config`, `kernel-build.log`, LK disassembly excerpts. |

Host scripts (`scripts/`, macOS and Linux; heavy work runs in Docker):

| Script | Purpose |
|---|---|
| `build.sh [wcn]` | Everything in `out/` incl. U-Boot and `boot-mainline-uboot.img`; `wcn` compiles only the WiFi driver. Stops on compile errors (`out/kernel-build.log`). |
| `tb.sh ['cmd']` | ssh to the running tablet (USB network), `/usr/local/sbin` in PATH. |
| `ramboot.sh [image]` | RAM-boot through U-Boot fastboot, nothing written; waits for ssh. |
| `wifi-deploy.sh` | WiFi firmware, NVRAM (from `backup/`, never committed), tools and `wifi-up` to the tablet, hash-verified. |
| `tb-install.sh kernel\|rootfs` | Write `boot-mainline-uboot.img` to `tbkern_a` / `rootfs/out/rootfs.img` to `tbroot_a` (verified; rootfs from a RAM boot, old root backed up to `backup/`, PocketJS/firmware/host keys kept). |
| `../rootfs/build-rootfs.sh <key>` | Alpine root image: packages, overlay, tools from `out/`, Mesa (`gpu/out/mesa-opt.tar.gz`). |
| `tablet-net.sh` | Internet for `apk` on the tablet through a proxy on the host. |
| `pocketjs-deploy.sh` | Build and install the PocketJS kiosk. |
| `linux-test.sh`, `fbusb` | LK fastboot / Android transitions (`fbusb` needs libusb: Homebrew or the distro). |
| `tb-gpt.py` | Build and check the dual-boot GPT. |

The DTS (`dts/mt6737m-lenovo-tb7304x.dts`):
- 4 CPUs with `enable-method = "mediatek,mt6735-smp"`
- touch (Goodix on i2c1, VGP1 at 2.8 V), SoC keypad (volume keys), MT6328 power key
- uart0, eMMC at a conservative 50 MHz (no HS200/HS400 tuning)
- pwrap + MT6328
- musb in `dr_mode = "peripheral"`
- ramoops at the stock pstore address, and the MTK `ram_console`/`minirdump` areas kept no-map

The driver (`patches/mtk-lk-fb.c`, `CONFIG_MTK_LK_FB`):
- It reads `/chosen/atag,videolfb` and the OVL0 layer registers @0x14007000: enable, address, pitch, size, format.
- It registers a `simple-framebuffer` platform device, so **simpledrm + fbcon** draw on the panel LK already lit.
- It logs everything with the prefix `lkfb:`.
- Cmdline overrides: `lkfb.addr= lkfb.stride= lkfb.width= lkfb.height= lkfb.format= lkfb.ovl=0 lkfb.enable=0`.

The config fragment (`patches/config-tb7304x.fragment`):
- no modules, `DRM_MEDIATEK` off (so nothing reprograms the display)
- evdev, Goodix touch, `mt6779-keypad`, MT6328 PMIC keys
- simpledrm + fbdev + fbcon + logo
- `/dev/mem` without STRICT_DEVMEM
- embedded initramfs
- pstore/ramoops, mtk watchdog, USB configfs (ACM/ECM/RNDIS)

The initramfs (`initramfs/init`, `initramfs/lkpaint.c`):
- It paints red, green, then blue: through `/dev/fb0`, or else through `/dev/mem` at LK's `fb_base`.
- It sets up a USB gadget: configfs on mainline, `android_usb` on the stock kernel. Vendor 0x1d6b, product 0x0104.
- Services: CDC-ACM root shell, ECM network 172.16.42.1 with DHCP for 172.16.42.2, telnetd, and httpd serving
  `init.log`, `dmesg.txt` and `status.txt`.
- It reboots itself after `tb.autoreboot=` seconds (default 300) unless `/tmp/stay` exists. If the reboot hangs, an
  unpetted `/dev/watchdog` is the fallback.

### Images (`out/`)
| Image | Kernel | Cmdline (LK appends its own items) |
|---|---|---|
| `boot-mainline.img` (13.3 MB) | 7.0.10-tb7304x+ Image.gz + `mt6737m-lenovo-tb7304x.dtb` | `bootopt=64S3,32N2,64N2 clk_ignore_unused pd_ignore_unused regulator_ignore_unused` (99-char LK limit; `init` defaults to `tb.autoreboot=300`) |
| `boot-mainline-noovl.img` | same | same + `lkfb.ovl=0` |
| `boot-stock-kernel-initramfs.img` (8.9 MB) | stock 3.18 kernel+DTB, byte-for-byte | `bootopt=64S3,32N2,64N2 panic=10 tb.autoreboot=300` |

All three fit in the 16 MiB recovery partition. Hashes are in `out/SHA256SUMS`. Builds are reproducible in content
but not bit-for-bit: build timestamps and the kernel build number change.

### Rebuild
```sh
cd mainline
./scripts/build.sh          # ~5 min cold on M-series (10 cores), ~1 min incremental; log in out/kernel-build.log
```
Hosts: macOS (OrbStack or Docker Desktop, native arm64) or Linux with Docker (x86_64 cross-compiles; `taos` is
one). Both verified 2026-11-17. The stock partition backups must be in `../backup/partitions` (mounted as `/stock`).
`build.sh`:
- builds the `tb7304-build` image
- clones the kernel and pmaports if they are missing
- uses the Docker volume `tb7304-kbuild` for kernel objects (and `tb7304-ubuild` for U-Boot)
- re-checks the stock repack and the size limits
- clones U-Boot at the pin in `u-boot/build-uboot.sh` if `src/u-boot` is missing

## 3. Honest list of unknowns / risks
1. **`fastboot boot`**: LK has no `boot` command (see above). The chainloaded U-Boot does support `fastboot boot`,
   and that is what the live layout uses for RAM tests. The flash-recovery route is no longer the main path.
2. **Display:** we assume LK leaves the panel running in DSI video mode, scanning OVL0 from `atag,videolfb.fb_base`.
   Other assumptions:
   - The atag struct layout (`u64 fb_base; u32 islcmfound, fps, vram; char lcmname[]`) comes from MTK sources of this
     era. It is not verified for this LK build.
   - The OVL register offsets come from the mt8173-compatible OVL that the mt6735 DTS uses.
   - If reading OVL hangs the bus (display clocks gated), use the `-noovl` image.
3. **USB gadget on mainline:** musb is in pmOS's config and the Doogee DTS. It is untested on MT6737M. VBUS/ID detection
   is not wired up; we force peripheral mode.
4. **SMP:** solved (see section 0). Add `maxcpus=1` to the cmdline in `build-in-docker.sh` to fall back to one core.
5. **Charger:** the SM5414 driver is in current kernels; the live `battery`/`sm5414-charger` supplies report
   charging state and capacity. The 2026-11-16 caution no longer applies.
6. **Watchdog:** mainline `mtk_wdt` (TOPRGU, 10 s) pets the watchdog from the kernel. Whether LK hands over an armed
   watchdog is unknown. If the kernel hangs before the watchdog driver probes, recovery may need a long press on Power.
7. **eMMC:** in use at 50 MHz; stage 1 mounts the ext4 root on `tbroot_a` and `/data` on `tbdata`. If mmc init
   misbehaves it costs both the root and the data partition.

## 4. Next steps
Linux boots by default through the chainloaded U-Boot, and display, rootfs, cpufreq, GPU, WiFi and the PocketJS
kiosk are working. The live status table, measurements and the ordered todo list are in
[`docs/mainline/STATUS.md`](../docs/mainline/STATUS.md). Next: Bluetooth, the OVL0 hardware-plane path, and an
updater for the inactive Linux slot.

## Sources
- mt6735 mainline group: https://gitlab.com/mt6735-mainline (kernel: https://gitlab.com/mt6735-mainline/linux)
- pmOS package: https://pkgs.postmarketos.org/package/main/postmarketos/aarch64/linux-postmarketos-mediatek-mt6735
- pmaports: https://gitlab.postmarketos.org/postmarketOS/pmaports (commit ce3ebdba08cd)
- pmOS wiki MT6735 page (redirects from MT6737/MT6737M): https://wiki.postmarketos.org/wiki/MediaTek_MT6735 (bot-blocked for us; status from search snippets)
- pmaports MR 3839 (6.1.9: full DRM display support): https://gitlab.postmarketos.org/postmarketOS/pmaports/-/merge_requests/3839
- MT6735 U-Boot port: https://gitlab.com/alifilhan0/u-boot
- MediaTek LK background: https://www.lieberbiber.de/?p=149
