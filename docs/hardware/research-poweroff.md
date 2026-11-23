# TB-7304X mainline: power off and the long-press reset

Status 2026-11-16: kernel #24 (`patches/0010`, power off + deadman in `patches/mtk-rtc-boot-mode.c`, DT) is in
`recovery` (sha256 4fe62937…, k22 backup in `backup/recovery-images/`). Tested on the tablet, see "Results".

## What happened
On 2026-11-16 `poweroff` on kernel #22 left the tablet stuck. The USB gadget was still enumerated, but there was no
ARP, IPv6, ssh, telnet or ACM shell, the charge LED was on, and no button hold did anything. The only ways out
were draining the battery with USB unplugged, or disconnecting it.

Two bugs caused it:
1. **No power-off handler.** The only one registered is PSCI `SYSTEM_OFF` (legacy `pm_power_off`, priority 0).
   The stock ATF doesn't power anything off for it, so `kernel_power_off()` ended with the CPUs stopped and
   interrupts off.
2. **The long-press reset was turned off by our own kernel.** `mtk-pmic-keys` (mt6735-mainline fork; upstream has
   no MT6328 keys support) gives MT6328 the MT6323/MT6397 `TOP_RST_MISC` layout. With `long-press-mode = <1>` its
   probe updates mask `GENMASK(9,8) | BIT(6) | BIT(5)` to `BIT(6)`, so it **clears** the real `PWRKEY_RST_EN`
   (bit 9) that the preloader set. The stock kernel enables it (`kpd: Enable normal mode LPRST` in its log
   strings).

## MT6328 registers (vendor `upmu_hw.h`, `mt_rtc_hw.h`, MT6735 3.18)
| Register | Field |
|---|---|
| `TOP_RST_MISC` 0x02a0 | bit 0 `WDTRSTB_EN`, 1 `WDTRSTB_MODE`, 2 status, 3 status clear, 4 `WDTRSTB_FB_EN`, **8 `HOMEKEY_RST_EN`, 9 `PWRKEY_RST_EN`**, 10 `PWRRST_TMR_DIS`, **13:12 `PWRKEY_RST_TD`** (same layout as MT6331 in mainline) |
| `CHR_CON0` 0x0f48 | bit 5 `RGS_CHRDET` (charger present) |
| RTC base 0x4000: `RTC_BBPU` +0x00 | bit 0 PWREN (alarm power-on), 2 BBPU (1 = power on), 3 AUTO, 6 CBUSY, key `0x43 << 8` |
| `RTC_PDN1` +0x2c | 4-5 recovery, 13 fast boot, **14 KPOC**, 15 debug |
| `RTC_WRTGR` +0x3c | write 1 to latch, then wait for CBUSY to clear |

## How stock powers off (`mtk_rtc_common.c` `mt_power_off`, `rtc/mt6328/mtk_rtc_hal.c`, `wd_api.c`)
1. `hal_rtc_bbpu_pwdn()`: `RTC_BBPU = KEY | AUTO` and trigger. PWRBB drops and the PMIC turns off. Without a
   charger it also drives SRCLKEN low first.
2. With a charger connected the PMIC stays up (the charger is a power-on source). It loops with `mdelay(100)` and
   calls `arch_reset(0, "charger")`. This writes no RTC flag and does `wdt_arch_reset(0)`: TOPRGU `WDT_MODE` with
   AUTO_RESTART (bit 4, "bypass power key") **cleared**, then `SWRST`. LK
   (`kernel_power_off_charging_detection`, strings in `stock/lk.strings`) then enters power-off charging (KPOC)
   with the charger present. Without a charger it powers off.

## What we do now
- `patches/0010-input-mtk-pmic-keys-mt6328-rst-bits.sh`: MT6328 uses the MT6331 bit masks. The DT keeps
  `mediatek,long-press-mode = <1>` (power key only). `power-off-time-sec` is written raw into `PWRKEY_RST_TD`, so
  it is not seconds. 0 is set for now: **time each value on the tablet** and pick one (stock
  `CONFIG_KPD_PMIC_LPRST_TD` is unknown because the stock kernel has no IKCONFIG).
- `mtk-rtc-boot-mode.c` registers a `SYS_OFF_MODE_POWER_OFF` handler at `SYS_OFF_PRIO_HIGH`, which runs ahead of
  PSCI. It writes BBPU like step 1 and waits 1 s. If still powered (charger, or the write failed), it does the
  stock `wdt_arch_reset(0)` on TOPRGU (`mediatek,toprgu = <&toprgu>`). In every case the worst outcome is a
  reset, never a hang.
- `poweroff` from userspace (busybox/OpenRC) needs no other change.

## To verify on the tablet
1. Before testing power-off, check the escape hatch: read `TOP_RST_MISC` (0x2a0) through the pwrap regmap. Bit 9
   should be set and 13:12 = TD. Then hold power and time the reset.
2. `poweroff` without USB: the tablet should go dark and stay off. Power key should boot normally (LK → Android
   unless `next_boot` was set).
3. `poweroff` with USB: dmesg on the ACM console shows `charger present`. Expect LK power-off charging. Note what
   LK does: charging animation in stock Android's KPOC (the boot partition, Magisk), or a normal boot.
4. If KPOC ends up in Android, decide whether that's fine. The alternative is to stay in Linux on a charger
   ("off" = blank screen, CPUs offline, power key reboots).

## Results on kernel #24 (2026-11-16)
| Check | Result |
|---|---|
| `TOP_RST_MISC` under stock Android (3.18) | 0x209: `PWRKEY_RST_EN` = 1, TD = 0, `WDTRSTB_EN` = 1 |
| `TOP_RST_MISC` under mainline #24 | 0x205: `PWRKEY_RST_EN` still 1, TD 0 (#22 cleared bit 9) |
| `CHR_CON0` / `RTC_BBPU` / `RTC_PDN1` | 0x63 (CHRDET) / 0x0d / 0 on both kernels |
| `poweroff` on USB | Gadget gone within ~7 s, preloader, then LK power-off charging: USB `0e8d:20ff` "Android", no adb. Stable. |
| `poweroff` without USB | not tested yet |
| Power key from KPOC, long-press reset time | not tested yet |

Reading PMIC registers:
- Mainline: `/sys/kernel/debug/regmap/10001000.pwrap/registers` is 11 bytes per register, stride 2, so use
  `dd bs=11 skip=$((addr/2)) count=1`.
- Stock 3.18: `/sys/devices/platform/mt-pmic/pmic_access`. Input of **5 bytes or less including the newline**
  is a read (`echo 2a0`). Longer input is a write. `echo 0x2a0` with no value **oopses and panics the stock
  kernel** (NULL `kstrtou32` in `store_pmic_access`; it happened once, nothing was written).

## Related
- `tb-reboot` notes that `reboot -f` can hang. PSCI `SYSTEM_RESET` is registered at restart priority 129, ahead of
  `mtk_wdt` (128), so restarts go to the stock ATF first. This is likely the same ATF problem; a TOPRGU restart
  handler at higher priority would fix it.

## Sources
- Vendor MT6735/MT6328 3.18 kernel (Samsung Grand Prime+ `grandpplte`):
  https://github.com/SubZero7748/android_kernel_samsung_grandpplteser
  (`drivers/misc/mediatek/rtc/`, `.../include/mt-plat/mt6735/include/mach/upmu_hw.h`, `mt_rtc_hw.h`,
  `drivers/input/keyboard/mediatek/mt6735/hal_kpd.c`, `drivers/watchdog/mediatek/`)
- Mainline `drivers/power/reset/mt6323-poweroff.c` (same BBPU sequence)
