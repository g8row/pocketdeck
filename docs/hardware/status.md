# TB-7304X hardware status

Alpine Linux on kernel 7.0.10 (mt6735-mainline `v7.0.10-mt6735`, 046883c, plus the patches in `device/`) is the tablet's main system; Android + Magisk stay in `recovery` as rollback ([boot chain](../architecture/boot-chain.md)).
Verified on: build `ae95761` (kernel `7.0.10-tb7304x #ae95761`, rootfs sha256 `9a5f5368…`) in slot B, 2026-11-23;
slot A still holds the 2026-11-17 build (`#18`) as fallback.
Future entries name builds by `git describe` from `device/out/BUILDINFO` (shown by `pd state`), not by `#N`.

Research notes: [display](research-display.md), [power/charger/sensors](research-power.md), [power off](research-poweroff.md), [root filesystem](research-rootfs.md), [WiFi/BT](research-wifi.md), [stock LK boot flow](research-lk-bootflow.md), [stock firmware (DTB, boot image, LK)](research-stock-firmware.md).

## Device functionality

| Function | Status | How / notes | Next step |
|---|---|---|---|
| Boot | ✅ | Stock LK → U-Boot (`boot`) → Linux from raw slot `tbkern_a`/`tbkern_b`, root `tbroot_a`/`tbroot_b`; boot record in `tbstate`, 3 unhealthy boots → `tbrescue` → Android. Stage-1 boot menu (3 s). Details: [boot-chain.md](../architecture/boot-chain.md). Anything LK boots directly must pass `device/analysis/lk_image_check.py` | — |
| CPU, 4× A53 | ✅ 4 cores, hotplug, cpufreq 1040–1196 MHz | `mediatek,mt6735-smp` enable-method (PSCI CPU_ON + SPM MTCMOS, `patches/smp_mt6735.c`). cpufreq-dt on ARMPLL + MT6328 VPROC, schedutil; ARMPLL /1 only (see "cpufreq") | Idle below 1040 MHz (needs a CPU clock mux); long-term 1196 MHz validation |
| Display | ✅ mediatek-drm, 60 Hz | RDMA0 → DSI0 → NT51021B GX (`panel-novatek-nt51021b.c`), D2 mutex table, through the IOMMU. `/dev/dri/card1`, `fb0` = mediatekdrmfb (console). VFP stretched 35 → 141 lines for 60.0 Hz (65.9 Hz with LK's porches). One burst of ~10 IOMMU faults at boot, before the first fb is attached | OVL0 path for hardware planes |
| Backlight | ✅ | `pwm-backlight` on DISP_PWM, `/sys/class/backlight/backlight` 0–255, default 200 | — |
| GPU (Mali-T720 MP1, 450 MHz) | ✅ Panfrost + Mesa 24.3 | `/dev/dri/card0`, VCORE1 as mali-supply; Mesa in `/opt/mesa` in the rootfs image (see "GPU") | GPU devfreq/OPPs |
| Touch | ✅ at 1.0 s | Goodix GT9293, i2c1 @0x5d, `goodix,gt911`, IRQ GPIO10, reset GPIO62, VGP1 2.8 V. `FW_LOADER_USER_HELPER` off (its fallback for `goodix_9293_cfg.bin` delayed probe to 62 s). Cracked glass: see "Phantom touches" | — |
| Buttons | ✅ | Vol± on the SoC keypad (`mt6779-keypad`), Power on `mt6328-keys` | — |
| USB | ✅ peripheral | CDC gadget `0525:a4aa` (ECM + ACM), tablet at 172.16.42.1 (ssh, telnet, httpd) | Host mode, VBUS/ID detection |
| eMMC | ✅ 50 MHz | Root, `/data` = `tbdata`, kernel slots read by U-Boot | HS200 |
| Root filesystem | ✅ Alpine 3.24.4 | ext4 slots `tbroot_a`/`_b` (2 GiB), `e2fsck -p` + mount in stage 1. Built by `device/rootfs/build-rootfs.sh`, installed by `pd install rootfs` (keeps `/opt/pocketjs`, `/etc/firmware`, host keys) | — |
| Internet / time | ✅ | WiFi at boot (`wifi` service, `/data/wifi`). Without WiFi: `tools/tablet-net.sh` (host proxy over `ssh -R`). busybox `ntpd` once online; RTC read at boot, `hwclock` service | — |
| Reboot target | ✅ | `tb-reboot android\|linux\|android-direct\|default-android\|default-linux\|uboot\|bootloader`; host side `pd reboot`, `pd boot default` | — |
| Panic / watchdog | ✅ | `CONFIG_PANIC_TIMEOUT=10`; `mtk_wdt` | — |
| Charger (SM5414, i2c3 @0x49) | ✅ | `patches/sm5414_charger.c`: `sm5414-charger` supply (online/status/health, writable CV, current, input limit, `charge_behaviour` auto/inhibit-charge). Policy from DT `battery`: CV 4.10 V (~75–80 %), 500 mA, top-off 150 mA, input limit 1 A (LK's 450 mA starved the battery under load), AICL 4.5 V. Stops outside 0–45 °C (battery NTC zone, 3 °C hysteresis; tested). Registers polled every 10 s, re-applied if changed; no IRQ | BC1.2 type detection; IRQ instead of polling |
| Battery | ✅ | `voltage_now` (MT6328 AUXADC BATSNS); `current_now` from the PMIC fuel gauge (FGADC over R_FG 10 mΩ, IIO channel 7 in `mt6328-auxadc.c`; 500 mA set → 440 mA read); `temp` (NCP15XH103 NTC, 50 °C hot trip); `capacity` from the stock 25 °C OCV table with OCV = V − I × 150 mΩ. ISENSE is the system rail, not the battery. VCDT via `voltage-divider` (5.16 V on USB) | Coulomb counting (FG_CAR); critical-battery trip |
| RTC | ✅ rtc0 | MT6328 RTC = MT6323/MT6397 block at 0x4000 (`patches/0012`, `mediatek,mt6328-rtc` → rtc-mt6397), year − 1968 as stock. HCTOSYS + SYSTOHC; survives `tb-reboot` (boot-mode flags share the block) | What Android does with it |
| SoC thermal | ✅ | `patches/0009`: `mediatek,mt6735-thermal` (MT8173 data, 3 banks). 45 °C idle, 60 °C after 30 s on 4 cores. Trips 85 °C passive, 110 °C critical | — |
| Accelerometer | ✅ iio:device0 | Bosch BMA2xx @0x18 on i2c2 (ID 0xFA), `bosch,bma255` → bmc150-accel, polled. `mount-matrix` 0 −1 0; −1 0 0; 0 0 −1 (stock `direction = 7`). MC3433 @0x4c not fitted | Screen rotation if wanted |
| IOMMU (M4U) | ✅ | larbs 0–2 after the D2 address fix (larb3 dropped); RDMA0 translates | OVL0 ports |
| WiFi | ✅ 2.4 GHz only | MT6625L via CONSYS: WMT/STP/BTIF + wlan_gen2 (frank-w 5.15 + MT6735 BSP layer, ported to 7.0, built in: `device/wcn`, `patches/0011`). `wifi-up join`/`save`; firmware/NVRAM via `tools/wifi-deploy.sh`. [research-wifi.md](research-wifi.md) | Rename to wlan0 |
| Bluetooth | ⚠️ powers on, scans find nothing | `hci0` registers, BD address from NVRAM, LE enables; LE scan and inquiry return nothing (also with WiFi off) | MTK vendor init commands (radio, sleep, TX power) |
| Audio, camera, modem | ❌ | — | Not planned |

## cpufreq
- OPPs: 1040 / 1092 MHz at 1.25 V; boost (overclock, enabled by `local.d/tb-cpu.start`) 1144 MHz at 1.275 V and
  1196 MHz at 1.30 V. Voltages from the stock kernel's MT6737M table (`{kHz, uV/10, uV/10}` at 0xfac558 in the stock
  Image: 1092 MHz at 1.25 V down to 221 MHz at 0.95 V), +25/+50 mV for the overclocks.
- ARMPLL (ARMPLL_CON1 0x10209204, measured through `/dev/mem`): pcw changes are safe at any time; post-divider
  /2 → /1 with the VCO moved first works; **/1 → /2 hangs the SoC** (the stock kernel parks the CPU on MAINPLL first;
  mainline has no CPU mux); pcw writes above ~0xb8000–0xba000 at /1 (≈1.2 GHz) or VCO ~2 GHz at /2 are dropped,
  some writes get dropped by timing.
- So every OPP is at /1; the only post-divider change is the first step up from LK's 793 MHz. `patches/0007`
  (PLL_POSTDIV_SAFE), `0008` (re-write pcw until it reads back), `0005` (VPROC vsel register; VPROC_CON11 = 0x58 =
  1.15 V at 793 MHz), `0006` (PLL `fmax`; without it every `clk_set_rate` became 0 Hz).
- 1196 MHz: 4-core NEON/scalar cross-check clean (30 s at 1.30 V); single core 21 % faster than 988 MHz. The UI barely
  changed: its frames are memory-bound. VSRAM (LDO, 1.35 V from LK) stays above every VPROC level.
- Stock CPU mux: `TOP_CKMUXSEL` bits [3:2]; infracfg+0x0 (0x10001000) reads 0 on this chip, so the register is elsewhere. Not found.

## GPU: Panfrost + Mesa
- `&gpu` (`mediatek,mt6735-mali`, `arm,mali-t720`), mali-supply VCORE1 as on the Galaxy Grand Prime+. Panfrost id
  0x720, 1 shader core, 1 L2, 450 MHz (LK's mfg_sel). card0 = panfrost, card1 = display.
- Alpine's `mesa-dri-gallium` needs ~210 MB with LLVM, so `device/gpu/build-mesa.sh` cross-builds Mesa 24.3.4
  (Panfrost + kmsro, no LLVM; later Panfrost needs mesa_clc on the build host) with Zig against Alpine's aarch64
  packages. 17 MB in `/opt/mesa`; needs `libdrm expat zstd-libs`.
- Pitfalls: zig links non-PIE without copy relocations for musl data (getopt loops, getenv crashes) → PIE; no ELF
  build-id → Panfrost disk cache crashes → `-Dshader-cache=disabled`.
- Result: OpenGL ES 2.0 Mesa 24.3.4 on `Mali-T720 (Panfrost)`; kmscube 60 fps vsync-locked, no kernel errors.

## PocketJS on Linux
- `pocketjs-kiosk` (static aarch64 musl) runs as the OpenRC service `pocketdeck-ui` (`pd deploy`); config in
  `/etc/conf.d/pocketdeck-ui`. DRM/KMS scanout on card1 (two dumb buffers, page flip at vblank; `POCKETJS_DISPLAY=fb`
  for fbdev), touch Goodix, keys `mt6779-keypad` + `mtk-pmic-keys`, VT in KD_GRAPHICS. deckd over `ssh -R 7777`.
- The landscape UI is rotated 90° in software (the display engine only does 0/180°): full frame 110 ms column walk →
  19 ms tiled → 7.6 ms NEON 4×4. Raster in row bands, rotate on 2 threads; more threads gain nothing (memory-bound).
- Page slides: 8 fps at the start → **59–62 fps with even pacing**; average full-screen frame 10.3 ms; rotate+present ~7.5 ms, no tearing.
- Pacing: 60 Hz tick phase-locked to flip events (frame starts 8 ms after vblank); every animation flip lands on the
  next refresh (963/963 over 3 runs; free-running timer 97–99 %). `POCKETJS_PACE=timer`, `POCKETJS_PHASE_MS`.
- Tools: `swipe /dev/input/event2 l|r N gap_ms`; `POCKETJS_STATS=1|2`; `tools/fb2png.py` (fbdev dumps only).

## Phantom touches (cracked glass)
- With nobody touching, phantom contacts come in bursts: ~1.4/s mostly at panel x 370–470, y 0–125 (landscape left
  edge), or storms of 10–20/s along panel x ≈ 500–530 (landscape strip just under the nav). Mostly 15–250 ms and
  stationary; some stick for minutes.
- The framework followed one primary contact until lift, so a stuck phantom blocked real taps. Fixes in the Linux
  host and framework, set in `/etc/conf.d/pocketdeck-ui`: `POCKETJS_TOUCH_MASK` (contacts starting in fixed rects
  dropped), `POCKETJS_TOUCH_LEARN=1` (40 px cells with repeated stationary contacts masked at run time),
  `POCKETJS_TOUCH_STALE_MS=3000` (a contact still for 3 s is hidden until lift); deck app `tapMaxFrames: 60`.
- Verified with a stuck phantom present (injected taps on all 8 nav cells work). Not yet seen live: the learner during a storm.
- **UI rule of thumb:** keep tap targets off the landscape left edge (x < 64, y 60–120) and the strip under the nav
  (y 35–60); the nav bar itself is clean. Untried fix: drop broken channels from the GT9293 config.

## Boot time (power-on to the UI)
| Stage | Before | Now |
|---|---|---|
| Preloader + LK (`bootprof.pl_t` / `lk_t`) | 4.5 + 9.1 s | same; 5 s of LK is the unlocked "Orange State" warning |
| Kernel to /init | 1.7 s | 0.46 s (no RAID6 benchmark, no ftrace `trace_eval_sync`) |
| Stage 1 initramfs | 7.3 s | 0.4 s |
| OpenRC to the UI | ~20 s | ~4 s (`mdev -s` persistent-storage on 51 block devices was 11.3 s) |
| Touch | 62 s | 1 s |
| UI usable | ~77 s | ~19 s (ssh ~24 s after a reboot command) |

## Known issues
- **D2 die display addresses.** Mainline `mt6735.dtsi` has the D1 MMSYS layout; this chip has an OVL1 slot at
  0x14008000, so every block after OVL0 is +0x1000 (SPI +1): RDMA0 0x14009000, DSI0 0x14012000, MUTEX 0x14015000,
  larb0 0x14016000, smi_common 0x14017000, MIPI_TX 0x14018000. Fixed in our DTS; table in research-display §1.
  The stage-1 display watcher's `larb0=`/`smi=` labels are off by one block.
- **Protected RAM 0x5e700000..0x5fffffff (25 MiB).** Reads 0, writes dropped, every boot (an EMI MPU region set by the
  boot firmware, owner unknown). As free RAM it silently zeroed page-cache pages under memory pressure. Found with
  `device/analysis/memtest.c`; fixed by a `memory@5e700000` no-map node. Open: other LK boot modes, and what the
  dtsi's `memory@78000000` (77 MiB) covers here.
- **`clk_summary` lockup.** Reading `/sys/kernel/debug/clk/clk_summary` locks up the tablet (watchdog reset), probably a
  read in a powered-off domain; pstore had nothing. Don't read it.
- **`reboot -f` can hang**; `echo b > /proc/sysrq-trigger` works.
- Leaving Android with `adb reboot` before boot completes trips Magisk's boot counter into safe mode (boot loop); use
  `pd reboot` / `tools/linux-test.sh`. See [lessons](../dev/lessons.md).
- LK looped on its logo when the image's kernel area was < 512 KiB (it reads the DTB from its tail); U-Boot images are
  padded. Never write a `boot-recovery` BCB to `para`. See [research-lk-bootflow.md](research-lk-bootflow.md), [lessons](../dev/lessons.md).
- Patch 0002 (skip larb port config without IOMMU) may be unnecessary now that the larb addresses are fixed.

## Performance expectations
- CPU: 4× Cortex-A53 1.04–1.2 GHz, 1 GB LPDDR3; about a Raspberry Pi Zero 2 W / Pi 3. Fine for a terminal,
  daemons, a light Wayland compositor and a custom UI; Chromium/Electron will struggle, mainly for RAM.
- GPU: Mali-T720 MP1 (Pi 3 class), GLES 2.0 via Panfrost; enough for 2D compositing at 600×1024.

## Next
- Bluetooth: MTK vendor init commands.
- Display: OVL0 path (hardware planes, IOMMU ports).
- cpufreq below 1040 MHz (CPU clock mux); GPU OPPs.
- Charger: BC1.2 type detection; coulomb counting for battery %.
- Rootfs: `apk fix` for the skipped package scripts.
- RTC: check what Android does with it.
