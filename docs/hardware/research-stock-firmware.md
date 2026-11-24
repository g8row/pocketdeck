# TB-7304X stock firmware: DTB, boot image, LK

Status: current

Facts read from the stock partition backups (`backup/partitions/boot.bin`, `lk.bin`; not in the repo) and the
decompiled stock DTB (`device/stock/stock.dts`). The LK boot flow and image contract are in
[research-lk-bootflow.md](research-lk-bootflow.md); the display blocks in [research-display.md](research-display.md);
the I2C inventory and charger in [research-power.md](research-power.md).

## Stock boot image (`boot.bin`)
- Android boot header v0, page 2048. `kernel_addr 0x40080000`, `ramdisk_addr 0x44000000`, `second_addr 0x40f00000`,
  `tags_addr 0x4e000000`: base 0x40000000 with offsets kernel 0x80000, ramdisk 0x04000000, second 0x00f00000,
  tags 0x0e000000.
- os_version 7.0.0, patch level 2018-07, board/name `1535456354`, cmdline `bootopt=64S3,32N2,64N2`.
- Kernel: gzip arm64 Image (17.8 MB, `Linux version 3.18.35+ … Tue Aug 28 2018`, build path
  `ZA1962_601__A/kernel-3.18`), followed by a 65694-byte DTB (appended).
- No MTK 512-byte "mkimg" headers on kernel or ramdisk. The ramdisk is the stock Android one (not Magisk's).
- Re-created **byte-identically** by
  ```
  mkbootimg --base 0x40000000 --kernel_offset 0x80000 --ramdisk_offset 0x04000000 --second_offset 0xf00000 \
    --tags_offset 0x0e000000 --pagesize 2048 --header_version 0 --os_version 7.0.0 --os_patch_level 2018-07 \
    --board 1535456354
  ```
  plus patching `second_addr` back to 0x40f00000 (Debian's mkbootimg writes 0 there when there is no second stage).
  The kernel build re-checks this repack on every run.

## Stock DTB
- Model `MT6735M`, compatible `mediatek,MT6735M` (`mediatek,mt6735m-*` nodes); Android reports `ro.hardware=mt6735`.
  MT6737M is a re-spin of MT6735M (same CPU cluster and peripheral map), so mainline `mt6735m.dtsi` applies.
- 4× Cortex-A53, PSCI 0.1 (`method = "smc"`, cpu_on 0x84000003), stock `enable-method = "mt-boot"` (see SMP below).
- Memory placeholder `0x40000000 + 0x1f000000`; LK rewrites `/memory` from its mblock table (real RAM 1 GB).
- Reserved memory: ATF @0x43000000 (+0x30000); `ram_console` @0x43f00000; `pstore` @0x43f10000 (+0xe0000);
  `minirdump` @0x43ff0000; CCCI modem (dynamic, 0x3810000); CONSYS (dynamic, 1 MB).
- MTKFB `reg = <0x7f000000 0x1000000>` (top 16 MB): a placeholder; the real address comes from `atag,videolfb`.
- UARTs: `apuart0..3` @0x11002000 / 0x11003000 / 0x11004000 / 0x11005000. Stock bootargs `console=ttyMT0,921600n1`.
  No UART pads are known.
- eMMC: msdc0 @0x11230000, 8-bit, HS200/HS400 1.8 V. SD: msdc1 @0x11240000, 4-bit UHS.
- USB: `usb20@11200000` (musb), PHY @0x11210000, `drvvbus` GPIO 83, `iddig` GPIO 67.
- I2C:

  | Bus | Devices |
  |---|---|
  | i2c0 | cameras 0x10 / 0x3c |
  | i2c1 | touch Goodix `cap_touch@5d` (kernel strings `GT9293,BOE`, `GT9293,GX`, `GT9293,NEW_GX`), alternative FocalTech FT5x46 @0x38. EINT 10, `tpd-resolution 600x1024`, 5 fingers |
  | i2c2 | accelerometer @0x4c / @0x18, capsensor @0x28 / @0x20 |
  | i2c3 | charger SM5414 @0x49 (EINT 68, chgen GPIO 124, nINT GPIO 68, shdn GPIO 63) |

- PMIC MT6328 via pwrap. Keys: hardware power key plus volume keys on the SoC keypad matrix (map 0x73 / 0x72).
- LCM: `gpio_lcd_pwr` 83, `gpio_lcd_rst` 146. LK and the kernel carry four DSI video-mode drivers and pick one by panel
  ID: `nt51021b_dsi_vdo_dj`, `nt51021b_dsi_vdo_gx`, `nt35521z_dsi_vdo_gx`, `hx8394d_dsi_vdo_boe`. This unit has
  `nt51021b_dsi_vdo_gx` (LK's `lcmname`; research-display.md appendix).
- The display block addresses in the stock DTB are the D2 layout (RDMA0 0x14009000, DSI0 0x14012000, MIPI_TX
  0x14018000), not mainline's D1 `mt6735.dtsi`; full table in research-display.md §1.

## SMP power-on
The stock ATF's PSCI `CPU_ON` only records the entry point; it does not power the core. The stock kernel
(`mt-boot`) calls `CPU_ON` and then powers the core's MTCMOS domain itself through the SPM (0x10006000). This is the
"firmware issue" the Doogee X5 Pro DTS mentions. `device/patches/smp_mt6735.c` (`mediatek,mt6735-smp`) does the same:
- before each SPM write, write the project key `0x0b160001` to `POWERON_CONFIG_SET`;
- power on: `PWR_ON`, then `PWR_ON_2ND`; wait for the status bits; clear `ISO`; clear `L1_PDN` and wait for its ack;
  set `SRAM_ISOINT_B`; clear `SRAM_CKISO` and `CLK_DIS`; set `RST_B`;
- hotplug off does the reverse, after the core is in WFI.

Verified: all 4 cores at boot, IPIs and timers on every core, cpu3 offline/online (powers back on from
`PWR_CON=0x32`). Should apply to other MT6735/MT6737 devices on stock ATF.

## LK (`lk.bin`)
- 0x200-byte MTK header; ARM32/Thumb-2, linked at 0x41E00000 (from the reset-vector literals), position-independent
  (`ldr rX,[pc]; add rX,pc`). Build time "Aug 28 2018 19:30:47". Fastboot product string `HQ8735B_TB_N`.
- Fastboot commands (registered in one function at 0x41e20dfe..0x41e20f82): `getvar:`, `download:`, `flash:`,
  `erase:`, `continue`, `reboot`, `reboot-bootloader`, `oem p2u`, `oem reboot-recovery`, `oem append-cmdline`,
  `oem off-mode-charge`. **No `boot`** (answers "unknown command"); the chainloaded U-Boot provides `fastboot boot`.
  The stock `fastboot` tool stalls in the `download:` data phase; `device/analysis/fb_send.py` (pyusb, 1 MiB bulk
  writes) and `tools/fbusb` work.
- Kernel load (around 0x41e1f480): requires `kernel_addr & 0x7FFFF == 0` ("64 bit kernel can't boot at …"); finds the
  DTB by scanning backwards from the end of the kernel blob for `d0 0d fe ed`; gunzips to `kernel_addr` with a max
  output of 0x1C00000 (28 MiB). MTK mkimg headers are optional ("no mkimg header in kernel image").
- Keeps only **99 characters** of the image cmdline and prepends its own items (including `console=tty0`). It needs
  `bootopt=64S3,32N2,64N2` to pick a 64-bit boot. Its default cmdline string mentions `console=ttyMT3,921600n1`.
- `/chosen` passed to the kernel: `atag,videolfb` (`u64 fb_base; u32 islcmfound, fps, vram; char lcmname[]`),
  `atag,boot` (boot mode), `atag,mem`, `atag,devinfo`, `atag,mdinfo`, `atag,meta`, `linux,initrd-start/end`, `bootargs`.
- Not proven from the binary: whether LK leaves TOPRGU (watchdog) armed at the jump (research-lk-bootflow §3.8).

### LK framebuffer state at handover
- OVL0 (0x14007000) scans LK's framebuffer at 0x7f7b0000 (600×1024, pitch 2432) in DSI video mode, physical addresses
  (larb0 MMU_EN = 0). Full register readout: research-display.md appendix.
- OVL0 **layer 3** (0x7fa10000) holds the unlocked "Orange State" warning overlay. Disabling the layer (SRC_CON bit 3)
  **stalls OVL** until reset (RGB columns or black); setting its constant alpha to 0 (`L3_CON` 0x14007090, low byte)
  hides it safely.
- fbcon (`console=tty0` from LK) clears and redraws fb0.

### Reproducing the disassembly
`device/analysis/` (Python 3 + capstone), all taking `lk.bin` and a vaddr range in hex:
- `lk_strrefs.py lk.bin <lo> <hi>`: code that builds pointers to strings in [lo, hi);
- `lk_fastboot_cmds.py lk.bin <lo> <hi>`: strings in the fastboot command-table area and their references;
- `lk_disasm.py lk.bin <lo> <hi>`: Thumb-2 disassembly with pc-relative string pointers annotated;
- `lk_image_check.py <image>`: offline model of LK's checks on a 64-bit boot image (exit 0 = boots deterministically).

File offset = vaddr − 0x41E00000 + 0x200.

## Sources
- mt6735 mainline kernel: https://gitlab.com/mt6735-mainline/linux (`v7.0.10-mt6735`, 046883c; Doogee X5 Pro DTS)
- postmarketOS `linux-postmarketos-mediatek-mt6735` (pmaports ce3ebdba08cd), kernel config base
- MT6735 U-Boot port: https://gitlab.com/alifilhan0/u-boot
- MediaTek LK background: https://www.lieberbiber.de/?p=149
