# Lessons

Facts that cost time to learn. Each is still true for the current design; superseded beliefs are noted as such.
Sources are in git history (tag `android-era-final`, see [history](../history/README.md)).

## Boot chain and LK

- **Stock LK has no `fastboot boot`.** Its fastboot has `getvar: download: flash: erase: continue reboot
  reboot-bootloader` and `oem p2u|reboot-recovery|append-cmdline|off-mode-charge`. RAM-only tests go through
  U-Boot's fastboot (`pd ramboot`).
- **LK reads the DTB from the partition, not from RAM:** the last 512 KiB of the kernel area, last `d00dfeed` in it,
  copied to 0x4e000000. The offset is computed in 32 bits: a kernel area under 0x7f001 bytes underflows, the read
  fails quietly, and LK boots a stale FDT from RAM (or spins until the watchdog: the ~32 s logo loop). Pad to ≥ 512 KiB.
  Check every LK-bootable image with `device/analysis/lk_image_check.py`.
- **Route-dependent boot failures can be RAM leftovers.** An LK-started kernel keeps the FDT at 0x4e000000 intact;
  a U-Boot-started one moves it and heavy I/O overwrites the old copy. Test new boot images cold, or after a
  U-Boot-launched Android plus ~2 GB of I/O. (The old "only the RTC route works" matrix was this artifact.)
- LK keeps **99 characters** of the image cmdline and adds its own (`console=tty0`…); only for images LK boots
  directly. It takes gzip kernels only, ignores trailing padding, and MTK "mkimg" headers are optional.
- LK's boot-mode priority: preloader handshake → RTC fastboot bit → RTC recovery bit → BCB in `para` → keys (Vol+
  menu) → KPOC → normal. RTC bits live in `RTC_PDN1` (PMIC 0x402c): bit 13 fastboot, bits [5:4] = 01 recovery;
  one-shot, cleared by LK before loading, so a bad `recovery` image costs one boot.
- The RTC recovery bit used to mean "boot Linux"; now `recovery` holds Android, so it means Android started by LK
  directly (`pd reboot android-direct`, `adb reboot recovery`, `oem reboot-recovery`).
- **Never write a `boot-recovery` BCB to `para`.** LK never clears it and checks it before the keys, so the Vol+
  menu disappears on every boot; only BROM + mtkclient got the tablet back. BCB is rejected as a transport for good.
- LK arms the watchdog for 10 s and leaves it running: whatever it starts must take it over within ~10 s, or every
  hang becomes a reset (`wdt_by_pass_pwk` in `last_kmsg`).
- An unlocked bootloader costs 5 s of "Orange State" on every boot (its overlay is OVL0 layer 3).
- LK adds `/firmware/android/mode` with `fdt_add_subnode`; on a reused tree the old value stays. Starting Android in
  normal mode from a recovery-mode LK boot needs both `atag,boot` and that node patched (U-Boot's `tbandroid`).
- A corrupt `boot` image costs at most a Vol+ menu press: LK polls keys before loading and resets after 8 s on a
  header error. Don't hold Vol− at power-on (LK factory mode).
- LK refuses to boot below its battery cutoff, and `download:` refuses below 3.5 V. Charge before flashing sessions.
- LK reads ≤ 128 GPT entries, names ≤ 36 characters, and never writes the GPT. The preloader's GPT handling is unknown.

## U-Boot

- Base: mt6735-mainline U-Boot, `mt6735-staging` (2023.04-rc1), pinned. Linked at 0x40080000: LK rejects the
  grandpplte TEXT_BASE 0x40008000 (not 512 KiB aligned).
- The fork's "disable console_init_r" hack kills `printf`; board code calls `console_init_r()` itself.
- The fork's MUSB glue never registered a UDC (patch 0001), and its remove path skipped `usb_del_gadget_udc()`, so
  `fastboot continue` reset the tablet (patch 0002).
- U-Boot fastboot is 0e8d:201c (stock `fastboot` works); LK fastboot is 0bb4:0c01 (stock tool stalls: `tools/fbusb`).
- U-Boot carries the **stock** DTB as its appended FDT, so LK patches an Android-shaped tree; `tbandroid` boots
  Android without `bootm` (which would rewrite the memory node and bootargs the 3.18 kernel takes from LK).
- Display handover from LK: clear OVL0 L0 alpha-enable, hide the L3 orange-state layer by setting its constant alpha
  to 0 (`L3_CON` 0x14007090). Disabling the layer (`SRC_CON` bit 3) stalls OVL until reset.
- `fdt_high`/`initrd_high` = 0x4c000000 and a 2 MiB-offset kernel load, else "Kernel image misaligned" and
  "failed to reserve memory for node memory@78000000". `SYS_MEM_TOP_HIDE` 16 MiB keeps LK's framebuffers away.
- U-Boot's Android loader ignores an appended DTB: slot images carry it in `second` and are deliberately not
  LK-bootable. U-Boot prepends `bootargs` to the image cmdline.
- **U-Boot writes only `tbstate`.** No fastboot flash, no fs writes, no UMS (`ums 0 mmc 0` would export the whole
  eMMC read-write).
- From the source: `pmic write` is -ENOSYS on MT6328 (use `pmic_clrsetbits`); fs commands take no partition names
  (`part number` first); `ext4write` recreates files and refuses `metadata_csum`; `WDT_MTK` caps at 15.98 s; the
  fastboot buffer must be at 0x50000000.

## Flashing and recovery

- The stock `fastboot` tool stalls in `download:` against LK, every port, every OS; after a stall LK is wedged until
  Power is held ~15 s. Use `tools/fbusb` (pyusb, 1 MiB writes). No adb server while using fastboot.
- Escape ladder: power-cycle → Vol+ menu → LK fastboot + `fbusb` → BROM + mtkclient (power off, Vol+ and Vol−,
  plug USB; `sudo` from a real terminal; chown `hwparam.json` back). Write the escape down before changing layout.
- `recovery` holds the Android rollback: never flash a test image there.
- Never write `lk`, `preloader`, `seccfg`, `userdata`, `metadata`, `nvram`, `nvdata`, `protect1/2`, `para`. Backups
  contain IMEI/NVRAM: never publish them.
- From Android, toybox `dd` has no `conv=`: `dd bs=1048576`, `sync`, `cmp`.
- Diagnosing silent boot loops: film the tablet at 1–2 fps; `last_kmsg` with `hw_status: 2|5` + `wdt_by_pass_pwk`
  is a watchdog reset.
- One hypothesis per flash, every diagnostic batched into that image, and test the restore path before you need it.
- An Android factory reset formats only `userdata` and `cache`; the `tb*` partitions survive. After shrinking
  `userdata`, Android refuses it until wiped once through stock recovery.
- Magisk "direct install" patches the partition Android booted from, now `recovery` (untested).

## Kernel and hardware

- MT6737M = MT6735M re-spin: `mt6735m.dtsi` unchanged; closest mainline board is the Doogee X5 Pro.
- **D2 die:** every display block after OVL0 is +0x1000 vs the mainline dtsi (RDMA0 0x14009000, DSI0 0x14012000,
  MUTEX 0x14015000, MIPI_TX 0x14018000). Wrong addresses read back 0x1234.
- SMP: stock ATF's PSCI `CPU_ON` doesn't power the core; the kernel powers the MTCMOS through the SPM
  (`mediatek,mt6735-smp`, key 0x0b160001 before each SPM write). Fallback `maxcpus=1`.
- **RAM 0x5e700000–0x5fffffff reads 0 and drops writes** (an EMI MPU region from the boot firmware). It must be
  `no-map`, or big copies silently corrupt the page cache. `device/analysis/memtest.c` finds such ranges.
- ARMPLL: post-divider /1 → /2 hangs the SoC (no CPU clock mux in mainline). All OPPs run at /1.
- Reading `/sys/kernel/debug/clk/clk_summary` locks up the tablet. `reboot -f` can hang: use sysrq (`tb-reboot` does).
- `console=tty0` from LK means fbcon redraws fb0; unbind it or use `KD_GRAPHICS` when drawing directly.
- No cmdline room for `panic=10`: `CONFIG_PANIC_TIMEOUT=10`.
- `FW_LOADER_USER_HELPER` delayed touch to 62 s (optional Goodix config file); mdev's `persistent-storage` on 51 block
  devices cost 11 s of boot.
- The cracked glass makes phantom touches; anything acting on touch without a person present needs deliberate
  gestures (the boot menu takes double-tap only). Details: [status](../hardware/status.md).
- Android's 3.18 kernel depends on LK's DT handoff: no kexec into Android, switching always reboots.

## Android and Magisk

- Magisk 31.1 counts boots that don't reach `sys.boot_completed`; at 2 it disables all modules. adb answers long
  before boot completes, so `adb wait-for-device; adb reboot` drives the counter up, and without `tb7304x_strip`
  system_server crashes forever. Leave Android via `pd reboot` / `tools/linux-test.sh` only. Manual fix:
  `su -c "magisk --sqlite \"UPDATE settings SET value=0 WHERE key='bootloop'\""`, `rm /data/adb/modules/*/disable`.
- The mtkclient seccfg unlock did not wipe data on our unit.

## Build and tooling

- Debian's mkbootimg writes `second_addr` 0; patch it back to 0x40f00000 for a byte-identical stock repack.
- Zig-linked executables for musl must be PIE (non-PIE: broken copy relocations, getopt loops, getenv crashes) and
  have no build-id (Mesa's shader cache crashes without one).
- Alpine's busybox has no `devmem`: the static Debian busybox ships as `bbdeb`.
- Run the pyusb host helpers with `python3 -I`.
- Keep working files in `device/out/work/` (git-ignored), not in temporary directories that get wiped.
- Name builds by `git describe` (BUILDINFO), not by kernel `#N`: the counter is per build machine.

## Host and workflow

- Dedicated NetworkManager profile for the tablet's `enx*` with `never-default`; never `nmcli d connect`.
- `mlsh.py` (telnet) appends `; echo marker`: start background jobs as `(setsid sh -c '…' </dev/null >/dev/null 2>&1 &)`.
- Stage 1 auto-reboots after 300 s unless `/tmp/stay` exists (`mlsh.py wait`); stage 2's auto-reboot is off.
- Wait for `healthy` between test reboots (3 attempts → rescue → Android).
- Restart deckd after a merge or branch switch that replaces `deckd/`: a process whose working directory was
  deleted fails every spawn with ENOENT (every deck action "failed: No such file or directory").
- With no microphone chosen, PipeWire resolves `@DEFAULT_AUDIO_SOURCE@` to the default **sink**: muting the
  "default source" muted the speakers. deckd resolves a real input by name (`pickSource`).
- KDE: PowerDevil lists a ScreenSaver/idle inhibit only after it has been held a few seconds (the battery widget
  shows caffeine late, not never). KWin applies Night Light changes only through `kwriteconfig6 --notify`
  (not D-Bus `reconfigure`), and KConfig notifies only when the value changes. Plasma's widget DND is
  `plasmanotifyrc [DoNotDisturb] Until`; the `Notifications.Inhibited` property covers both it and app inhibits.
- The touch learner scores every short, still tap in its 40 px cell: ~10 taps on one spot within a minute mask
  it (injected test taps that never move hit this first; so could fast repeated taps on one button). The
  mask and the learner are off since the final assembly (no phantom contacts idle); only the stale filter stays.

## UI (PocketJS)

- The renderer repaints everything when the draw-op sequence changes shape: springing arcs, scaling rounded bars,
  fractional positions, text going to `""`. Use whole-pixel motion, `jump`, fixed-size text cells.
- A style key that disappears is not reset: set it in every state. `originX/Y` are offsets from the centre.
  `onFrame` hooks registered before `mount()` are dropped.
- Class strings must be full literals; glyphs are baked from string literals (`apps/desk/charset.ts`); font sizes
  12/14/16/18/20/24/36 only; the core doesn't wrap text.
- On Linux the frame is memory-bandwidth bound: rotate + raster on 2 threads is the sweet spot; the 1196 MHz
  overclock barely helps.
- Pak textures must be power-of-two; Bun socket writes of ~10 MB bundles are partial (drain-aware queue).
