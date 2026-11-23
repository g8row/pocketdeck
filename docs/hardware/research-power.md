# TB-7304X mainline: charger, battery, RTC, thermal, sensors (research notes)

> **Current status (2026-11-19):** the charger, RTC, AUXADC, thermal zones and accelerometer described here are
> implemented; see [STATUS.md](STATUS.md). The text below is the original research/plan, with the charger
> implementation note in §1.

Sources used:
- `mainline/stock/stock.dts` (stock 3.18 DTB, decompiled).
- Stock kernel, unpacked from `backup/partitions/boot.bin` (gzip Image, 17.8 MB). Strings are in
  `scratchpad/stockk/strings.txt`. Its build paths show this file list:
  `drivers/misc/mediatek/power/mt6735/charging_hw_sm5414.c`, `battery_meter_hal.c`, `pmic_chr_type_det.c`,
  `rtc/mtk_rtc_hal_common.c`, `accelerometer/accel.c`, `cap_sensor/sx9310/sx9310.c`, `thermal/mt6735/src/mtk_tc_D2.c` ...
- `backup/partitions/lk.bin` strings.
- Kernel tree. `/m/src/linux` no longer exists on taos: the `tb7304-kbuild` volume only holds the O= build dir, and
  its `source` symlink points to the missing `/m/src/linux`. I made a sparse clone of
  `gitlab.com/mt6735-mainline/linux` branch `mt6735-stable-7.0.y` (HEAD 046883c) in `scratchpad/linux`.
  I read the build's `.config` from the volume.
- Downstream MTK 3.18 MT6735 reference code: github `dhirajms/kernel_lenovo_P1m_3.18.y`, and the SM5414 driver from
  `99degree/android_kernel_m3note` (mt6755 copy of the same MTK SM5414 driver). Saved in `scratchpad/ref/`.

---------------------------------------------------------------------------------------------------------------

## 0. Inventory: every I2C device in the stock DTB

| bus (mainline label) | addr | stock compatible | actual part (from stock kernel strings) | IRQ / GPIOs (stock) | mainline driver |
|---|---|---|---|---|---|
| i2c0 `11007000` | 0x10 | mediatek,camera_main | rear camera (sp2509 or gc2375 module) | - | none (needs ISP); ignore |
| i2c0 | 0x3c | mediatek,camera_sub | front camera (gc2375 / sp2509) | - | ignore |
| i2c1 `11008000` | 0x5d | mediatek,cap_touch | Goodix GT9xx | EINT10 falling, rst GPIO62 | **already in our DTS** |
| i2c1 | 0x38 | mediatek,CAP_TOUCH1 | alternate touch (FocalTech-style addr), not populated | - | - |
| i2c2 `11009000` | 0x4c | mediatek,gsensor | **mCube MC3433** accelerometer (`cust_accel@0 compatible="mediatek,mc3433"`, direction 5) | `gse_1` EINT 66 (0x42), type 8 = level-low (not used by driver) | none (see §5) |
| i2c2 | 0x18 | mediatek,gsensor_1 | alternate **Bosch BMA2xx** (`cust_accel@1 "mediatek,bma2xx_new"`, direction 7), second-source | - | `bmc150-accel` (bma222e/250e/253/254/255/280) |
| i2c2 | 0x28 | mediatek,cap_sensor | **Semtech SX9310** SAR proximity | `cap_sensor` EINT 4, falling | `iio/proximity/sx9310` (not needed) |
| i2c2 | 0x20 | mediatek,cap_sensor_2 | **ABOV A96T316** SAR sensor | - | none (not needed) |
| i2c3 `1100f000` | 0x49 | sm,sm5414 | **Silicon Mitus SM5414** switching charger | EINT 68 (0x44) falling; `gpio_pwr_chgen` GPIO124, `gpio_chrg_nint` GPIO68, `gpio_chrg_shdn` GPIO63 | **none** |

No ALS/proximity, magnetometer, gyro or barometer: their stock nodes have no i2c child.

PMIC MT6328 sits on pwrap (EINT 206). The stock DTB also has the SoC AUXADC at 0x11001000 (`adc_channel`:
temperature0 = ch0, temperature1 = ch1, i.e. board NTCs) and THERM_CTRL at 0x1100b000 (irq 78).

Relevant options in the current `.config`:
- Enabled: `MFD_MT6397=y`, `RTC_DRV_MT6397=y`, `MTK_THERMAL=y`, `THERMAL_OF=y`, `I2C_MT65XX=y`, `I2C_CHARDEV=y`,
  `POWER_SUPPLY=y`, `IIO=y`.
- Off: `MEDIATEK_MT6577_AUXADC`, `NVMEM_MTK_EFUSE`, `SENSORS_NTC_THERMISTOR`, `HWMON`, every charger driver.

---------------------------------------------------------------------------------------------------------------

## 1. Charger: SM5414 on I2C3 @0x49

**Implemented 2026-11-17** (`mainline/patches/sm5414_charger.c`, STATUS.md). Measured on the device, differing from
the plan below:
- LK leaves VBUSLIMIT at 450 mA. That is about what the running tablet draws, so the battery got ~0 mA (fuel gauge)
  while STATUS said TOPOFF. The driver sets 1 A; the battery then takes the full 440-500 mA.
- STATUS.TOPOFF is set for the whole CV phase (seen at 440 mA), not only at the end: "full" also needs the current
  below the top-off threshold.
- Clearing CTRL.CHGEN stops charging and leaves the system on VBUS (battery ~0 mA), so the driver uses the bit and
  does not touch the nCHGEN pin. The pins are left as LK set them; the driver polls instead of using nINT.
- Battery current: the PMIC fuel gauge (FGADC_CON0/CON7, current mode, R_FG 10 mOhm), not ISENSE-BATSNS:
  ISENSE stays on the charger's system rail (it did not move when charging stopped while BATSNS relaxed 47 mV).
- Safety timer left off (LK's setting): CV 4.10 V plus the temperature gate cover the long-term risks.

### Verification
- Stock DTB node `i2c@1100f000/sm5414@49 { compatible = "sm,sm5414"; ... }`. It is the only device on i2c3.
- The stock kernel was built with `charging_hw_sm5414.c` and contains `[CHG_SM5414]` messages,
  `sm5414_hw_component_detect`, `sm5414_otg_worker` and the sysfs node `sm5414_access`.
- No bq24196 / bq25890 / fan5405 / ncp1854 / rt9466 driver code is present. The only "FAN5405" string is a leftover
  in MTK's battery_common printk.
- LK also has an SM5414 driver: `[sm5414] ChargerHwInit_sm5414`, `sm5414_set_ac_current(), CC value(%dmA)`,
  `charger enable/disable`, and BC1.2 type steps (`STANDARD CHARGER`, `Charging Host`, `Apple 2.1A`...).
  **LK programs the charger and enables charging on every boot, before Linux starts.**

### Mainline status
There is no SM5414 driver in 7.0 and no register-compatible part. Silicon Mitus's mainline drivers are only MUICs
(sm5502/sm5504). The SM5414 register map is its own; it is not bq2415x- or bq24190-like. The `siliconmitus,`
vendor prefix already exists, so use `siliconmitus,sm5414`.

### Register map
From the MTK `sm5414.h`, in `scratchpad/ref/sm5414.h`. 8-bit registers.

| reg | name | fields |
|---|---|---|
| 0x00-0x02 | INT1..3 (read-clear) | INT1: VBUSOVP7 UVLO6 VBUSINOK5 AICL4 VBUSLIMIT3 BATOVP2 THEMSHDN1 THEMREG0; INT2: FASTTMROFF7 NOBAT6 WEAKBAT5 OTGFAIL4 PRETMROFF3 CHGRSTF2 DONE1 TOPOFF0; INT3: VSYSOK3 VSYSNG2 VSYSOLP1 DISLIMIT0 |
| 0x03-0x05 | INTMASK1..3 | same bits |
| 0x06 | STATUS | VBUSOVP7 VBUSUVLO6 TOPOFF5 VSYSOLP4 DISLIMIT3 THEMSHDN2 BATDET1 SUSPEND0 |
| 0x07 | CTRL | ENCOMPARATOR6 RESET3 SUSPEN2 CHGEN1 ENBOOST0 |
| 0x08 | VBUSCTRL | VBUSLIMIT[5:0]: 100 mA + 50 mA*n (max 2050 mA) = input current limit |
| 0x09 | CHGCTRL1 | AICLTH[6:4] (4.3 V + 0.1 V*n), AUTOSTOP3, AICLEN2, PRECHG[1:0] (150/250/350/450 mA) |
| 0x0A | CHGCTRL2 | FASTCHG[5:0]: 100 mA + 50 mA*n (max 2500 mA) = charge current |
| 0x0B | CHGCTRL3 | BATREG[7:4]: 4.100 V + 25 mV*n (4.100 to 4.475 V) = CV; WEAKBAT[3:0] 3.00 V + 50 mV*n |
| 0x0C | CHGCTRL4 | TOPOFF[6:3]: 100 mA + 50 mA*n (termination current), DISLIMIT[2:0] |
| 0x0D | CHGCTRL5 | VOTG[5:4], FASTTIMER[3:2] (3.5 h / 4.5 h / 5.5 h / disabled), TOPOFFTIMER[1:0] (10/20/30/45 min) |
| 0x0E | (ID / presence) | the driver treats a non-zero value as "chip present" |

Pins:
- nCHGEN = GPIO124: low = charging enabled. The stock driver uses this pin, not the CHGEN bit.
- nSHDN = GPIO63: must be high for I2C to work without VBUS.
- nINT = GPIO68 / EINT68: falling edge.

### What the stock driver does

Two sources:
- The MTK `charging_hw_sm5414.c`, which the stock kernel was built from.
- The stock DT `bat_comm` values. These are in units of 10 µA.

`charging_hw_init`:
- nSHDN high.
- TOPOFF 150 mA.
- BATREG 4.20 V, or 4.40 V with `HIGH_BATTERY_VOLTAGE_SUPPORT`.
- AUTOSTOP disabled, so the IC never stops by itself; software decides "full".
- AICL threshold 4.4 V.

`charging_set_cv_voltage`: BATREG is picked from 4.100 to 4.475 V. The DT has `high_battery_voltage_support = 1` and
the battery profile's 100 % OCV is 4.333 V, so the stock CV is almost certainly **4.35 V**: a 4.35 V-class cell.

Input and charge current, set from the battery_common BC1.2 type:
- SDP (USB host) 500 mA (`usb_charger_current = 50000`).
- DCP (AC) 1050 mA (`ac_charger_current = 105000`).
- Non-standard 1000 mA.
- CDP 650 mA.
- Apple 0.5 / 1.0 / 2.1 A: 500 / 650 / 800 mA.
- Input limit (VBUSLIMIT) = charge current (FASTCHG) in the generic MTK flow.

Software policy (MTK battery_common, with JEITA compiled in: the stock strings include "support JEITA"):
- Charge only between 0 and 50 °C (`min_charge_temperature = 0`, `max_charge_temperature = 50`), with
  hysteresis 6 / 47 °C.
- Pre-charge up to 3.4 V (`v_pre2cc_thres = 3400`), then CC to topoff at 4.05 V (`v_cc2topoff_thres = 4050`).
- Full at < 100 mA (`charging_full_current = 100`). Recharge below 4.22 V (`recharging_voltage = 4220`).
- VBUS OVP 6.5 V (`v_charger_max = 6500`) using PMIC VCDT. The DT also has `v_charger_enable = 0`.
- Enable and disable use the nCHGEN GPIO.

`charging_reset_watch_dog_timer` is an **empty function**. The SM5414 has **no I2C/host watchdog** (no WDT field in
the map above), so nothing needs to be kicked.

### What happens if Linux never touches the charger
- LK has already initialised the SM5414 (CV, current, charging enabled through nCHGEN) before jumping to Linux.
  Mainline pinctrl does not reset GPIO124/63, so **charging continues with LK's settings**. Nothing times out on the
  host side: there is no watchdog.
- The IC charges on its own with hardware-only protections:
  - VBUS OVP/UVLO.
  - Battery OVP.
  - Die thermal regulation and shutdown (THEMREG/THEMSHDN).
  - Pre-charge and fast-charge safety timers, if FASTTIMER is not "disabled". The power-on default is not known.
- **The SM5414 has no battery NTC input.** All battery temperature protection (0-50 °C / JEITA) was done in stock
  software, using the PMIC BATON channel. With no Linux driver, **there is no battery over-temperature cut-off**.
- With AUTOSTOP off (stock), the IC floats the cell at BATREG indefinitely. For a tablet on USB 24/7, that likely
  means 4.35 V at 100 % SoC, all the time, inside a warm enclosure. This is the main long-term risk: capacity fade,
  and in the worst case swelling. It is not a short-term hazard.
- If the fast-charge timer expires (INT2 FASTTMROFF), charging stops until nCHGEN is toggled or VBUS is replugged.
  The battery then slowly discharges while the system runs from VBUS through the IC's power path. That is harmless.
- So: the battery charges today under mainline (until the timer expires), but with no temperature monitoring and
  at the stock 4.35 V.
- **Unverified:** the actual register values LK leaves. Read them (see the order below, step 1) before trusting any
  of this. On stock Android, `cat /sys/.../sm5414_access` dumps the registers.

### Recommended policy for a permanently powered desk device
- **CV = 4.10 V** (BATREG = 0, the lowest the IC allows). By the stock 25 °C OCV table, 4.10 V is about 80 % SoC.
  This is the biggest longevity gain.
- Charge current 500 mA (FASTCHG = 8), input limit 1000 mA (VBUSLIMIT = 18), AICL on at 4.4 V.
  - USB host ports that only allow 500 mA are covered by AICL sagging; you can also use 500 mA input when the PMIC
    or USB role says SDP.
  - Tablet draw is about 1-2 W, so 5 V / 1 A is plenty.
- TOPOFF 150 mA. AUTOSTOP on with TOPOFFTIMER 10 min, or keep AUTOSTOP off and let the driver manage it.
- FASTTIMER 5.5 h, as the hardware backstop.
- Software temperature gate on the battery NTC: inhibit at ≥ 45 °C, resume at ≤ 40 °C, inhibit below 0 °C. Inhibit
  means nCHGEN high, which keeps the power path and input supply alive. Optional: stop/resume window, e.g. stop at
  4.05 V, resume at 3.95 V.

### Minimal driver outline (`drivers/power/supply/sm5414_charger.c`, about 400-500 lines)
- regmap-i2c, 8-bit registers, cache off for 0x00-0x06.
- Probe:
  - Get `shdn-gpios` (drive deasserted = high) and `chgen-gpios` (GPIO_ACTIVE_LOW; logical 1 = charging).
  - Check reg 0x0E != 0.
  - `power_supply_get_battery_info(monitored-battery)` supplies:
    - `constant-charge-voltage-max-microvolt` → BATREG.
    - `constant-charge-current-max-microamp` → FASTCHG.
    - `charge-term-current-microamp` → TOPOFF.
    - `precharge-current-microamp` → PRECHG.
    - DT `input-current-limit-microamp` → VBUSLIMIT.
  - Set AICL 4.4 V and FASTTIMER. Mask nothing; request a threaded IRQ on nINT (falling).
- IRQ handler: read INT1..3 (clears them), `power_supply_changed()`, log faults (OVP, THEMSHDN, FASTTMROFF,
  NOBAT).
- Power supply type USB:
  - Properties: ONLINE (STATUS bit VBUSUVLO = 0, or PMIC CHRDET), STATUS (charging / full = STATUS.TOPOFF /
    not charging when inhibited).
  - Writable: CONSTANT_CHARGE_CURRENT, CONSTANT_CHARGE_VOLTAGE, INPUT_CURRENT_LIMIT, CHARGE_BEHAVIOUR
    (auto / inhibit-charge), HEALTH (OVP / THEMSHDN / timer expired).
- Temperature gate:
  - Simplest: a 30 s delayed work that reads the battery temperature and toggles nCHGEN with hysteresis. Read it
    from the IIO channel `io-channels = <&pmic_adc MT6328_AUXADC_BATON>` via `power_supply_temp2resist_simple`
    inverse or a lookup on the DT NTC table, or from `thermal_zone_get_zone_by_name("battery")`.
  - Alternative: register a thermal cooling device (`#cooling-cells = <2>`, states 0 = full current,
    1 = 300 mA, 2 = off) and use a DT thermal zone trip. Note: the power-supply core's automatic cooler is not in
    this tree, so the driver would have to register the cooling device itself.
- Also expose a "battery" power supply from this driver (or from a separate small driver):
  - VOLTAGE_NOW from the MT6328 AUXADC BATSNS channel.
  - TEMP from BATON.
  - CAPACITY via `power_supply_batinfo_ocv2cap()` from the DT OCV table. A voltage-based estimate is good enough,
    since the device sits on the charger.
  - CURRENT_NOW from FGADC later (optional).
- Leave OTG / ENBOOST off. Not needed.

### Proposed DT
```dts
/ {
	battery: battery {
		compatible = "simple-battery";
		device-chemistry = "lithium-ion-polymer";
		charge-full-design-microamp-hours = <3500000>;	/* q_max_pos_25 = 3515 mAh (profile 0) / 3584 (profile 1) */
		voltage-min-design-microvolt = <3400000>;	/* profile 100 % DOD = 3400 mV */
		voltage-max-design-microvolt = <4350000>;
		constant-charge-voltage-max-microvolt = <4100000>;	/* desk policy, stock = 4350000 */
		constant-charge-current-max-microamp = <500000>;
		charge-term-current-microamp = <150000>;
		precharge-current-microamp = <150000>;
		operating-range-celsius = <0 45>;
		alert-celsius = <0 45>;
		ocv-capacity-celsius = <25>;
		/* stock bat_meter battery_profile_t2 (25 C), resampled to 5 % steps */
		ocv-capacity-table-0 = <4333000 100 4271000 95 4215000 90 4162000 85 4108000 80
					4068000 75 3998000 70 3965000 65 3916000 60 3876000 55
					3847000 50 3823000 45 3806000 40 3790000 35 3776000 30
					3754000 25 3741000 20 3716000 15 3692000 10 3668000 5
					3400000 0>;
	};
};

&i2c3 {
	status = "okay";
	clock-frequency = <100000>;	/* stock def_speed 100 kHz */

	charger@49 {
		compatible = "siliconmitus,sm5414";
		reg = <0x49>;
		interrupts-extended = <&pio 68 IRQ_TYPE_EDGE_FALLING>;
		chgen-gpios = <&pio 124 GPIO_ACTIVE_LOW>;
		shdn-gpios = <&pio 63 GPIO_ACTIVE_LOW>;
		monitored-battery = <&battery>;
		input-current-limit-microamp = <1000000>;
		io-channels = <&mt6328_adc 0>, <&mt6328_adc 3>;	/* BATSNS, BATON (see §2) */
		io-channel-names = "vbat", "tbat";
	};
};
```
Pinctrl: add a group that keeps GPIO124/63 as GPIO outputs and GPIO68 as an input with pull-up, or leave them
alone. Do not use `output-low` / `output-high` in the default state if you want to preserve LK's levels across
probe.

- **Effort:** 2-3 days for driver, DT and test.
- **Risk:** moderate.
  - A wrong BATREG/FASTCHG value is the one dangerous mistake. Writes are bounded by the field widths, but still
    clamp in the driver: BATREG ≤ 4.35 V, FASTCHG ≤ 1.0 A.
  - Everything else is low risk. The chip has no watchdog, so a crashed or hung driver just leaves the last
    settings in place.

Second-source battery: `bat_id` GPIO77 (`gpio-bat-id = <&pio 77 0>`) selects `bat_meter` vs `bat_meter1`. The two
OCV tables differ by less than 15 mV, so one table is fine.

---------------------------------------------------------------------------------------------------------------

## 2. Battery voltage / temperature: MT6328 AUXADC (and FGADC)

### Mainline status
- The `mt6328` MFD (from Yassine Oudjana) only has `mt6328-regulator` and `mt6328-keys` cells
  (`drivers/mfd/mt6397-core.c: mt6328_devs[]`).
- **No AUXADC, RTC or fuel-gauge cells.**
- `drivers/iio/adc/mt6359-auxadc.c` covers mt6357/58/59 only. Its register layout is different: request bits, AP
  vs MD output registers. **Not reusable.**
- `include/linux/mfd/mt6328/registers.h` already defines `MT6328_AUXADC_ADC0..`, `RQST0_SET`, `FGADC_CON*` and
  `CHR_CON*`.

### Hardware (from downstream `pmic_auxadc.c`, `upmu_hw.h`, `upmu_sw.h`)

Channel enum: 0 BATSNS, 1 ISENSE, 2 VCDT, 3 BATON, 4 PMIC chip temp, 5 VACCDET, 6, 7 TSX, 8.., 12-15 shared.

Read sequence:
1. Set `AUXADC_CK_AON` (AUXADC_CON0 0x0E94, bit 15).
2. Write `1 << ch` to `AUXADC_RQST0_SET` (0x0E8A).
3. Poll the RDY bit (bit 15) of the channel's AP output register, then read the value.

AP output registers and scale (full range 1800 mV):

| ch | AP output reg | bits | scale |
|---|---|---|---|
| 0 BATSNS | ADC23 0x0E2E | 15-bit | ×3 divider: mV = raw*3*1800/32768 |
| 1 ISENSE | ADC25 0x0E32 | 15-bit | ×3 divider |
| 2 VCDT | ADC2 0x0E04 | 12-bit | raw*1800/4096. Charger VBUS = Vcdt*(330k+39k)/39k (`r_charger_1/2` = 330/39) |
| 3 BATON | ADC3 0x0E06 | 12-bit | raw*1800/4096 |
| 4 chip temp | ADC4 0x0E08 | 12-bit | needs efuse slope |
| 7 TSX | ADC18 0x0E24 | 15-bit | |
| 12-15 | ADC12 | shared | |

Init:
- `AUXADC_CON1` AVG_NUM_SMALL = 2, AVG_NUM_LARGE = 6.
- `AUXADC_CON2` AVG_NUM_SEL = 0x83.
- `RG_VBUF_EN` (AUXADC_CON12 bit 7) = 1.
- For BATON: `RG_BATON_EN` (CHR_CON7 bit 0) and `BATON_TDET_EN` (CHR_CON7 bit 2).

Charger present: `RGS_CHRDET` = CHR_CON0 bit 5. IRQ `MT6328_IRQ_STATUS_CHRDET` (40) is already in the irq enum.

### Battery NTC
- `rbat_pull_up_r = 16900 Ω`, `rbat_pull_up_volt = 1800 mV`, NTC to ground.
- The stock `batt_temperature_table` reads 25 °C = 10000 Ω, 50 °C = 4152 Ω, 0 °C = 27523 Ω. That is a 10 kΩ
  B≈3380 part = **Murata NCP15XH103**, which mainline `ntc_thermistor` supports (`murata,ncp15xh103`).

### Fuel gauge
- MT6328 FGADC is a coulomb counter: FG_ON = FGADC_CON0 bit 0, FG_CURRENT_OUT = FGADC_CON7, `r_fg_value = 10 mΩ`,
  `car_tune_value = 99`.
- Stock capacity model is MTK's OAM (OCV + CAR) with 4 temperature profiles. Too much to port.
- For a desk unit: voltage-based OCV lookup (relaxed while not charging) plus an "on AC" flag is enough. Current
  (FG_CURRENT_OUT, signed, 10 mΩ) can come later.

### Proposed changes
1. MFD: add a cell to `mt6328_devs[]`:
   `{ .name = "mt6328-auxadc", .of_compatible = "mediatek,mt6328-auxadc" }`.
2. New `drivers/iio/adc/mt6328-auxadc.c`, about 250 lines:
   - Regmap from the parent `mt6397_chip`, a mutex, and the read sequence above.
   - Channels 0, 1, 2, 3, 4 as `IIO_VOLTAGE` with `INFO_RAW + INFO_SCALE`. Scale ×3 for 0/1, 1800/4096 for 2-4.
   - VCDT scaled to VBUS (optional).
3. DT:
```dts
&mt6328 {
	mt6328_adc: adc {
		compatible = "mediatek,mt6328-auxadc";
		#io-channel-cells = <1>;
	};
};

/ {
	battery_ntc: thermistor-battery {
		compatible = "murata,ncp15xh103";
		io-channels = <&mt6328_adc 3>;	/* BATON */
		pullup-uv = <1800000>;
		pullup-ohm = <16900>;
		pulldown-ohm = <0>;
		#thermal-sensor-cells = <0>;
	};

	thermal-zones {
		battery-thermal {
			polling-delay = <30000>;
			polling-delay-passive = <5000>;
			thermal-sensors = <&battery_ntc>;
			trips {
				batt_hot: batt-hot { temperature = <45000>; hysteresis = <5000>; type = "passive"; };
				batt_crit: batt-crit { temperature = <60000>; hysteresis = <0>; type = "critical"; };
			};
		};
	};
};
```
Config: `CONFIG_HWMON=y`, `CONFIG_SENSORS_NTC_THERMISTOR=y`, plus the new `MEDIATEK_MT6328_AUXADC`.

- **Effort:** 1-2 days.
- **Risk:** low. Read-only ADC requests. MD/GPS use separate request and output registers (RQST1, `*_BY_MD`), so
  there is no conflict with the modem, which is not running anyway.

---------------------------------------------------------------------------------------------------------------

## 3. RTC: MT6328 RTC

> **Implemented 2026-11-17:** `rtc0` is registered, the kernel reads it at boot, and `hwclock` applies it. The
> analysis below is what the patch followed.

- Downstream `mtk_rtc_hal.h` for mt6735: `#define RTC_BASE (0x4000)`.
- `mt_rtc_hw.h` uses the same register layout as MT6323/MT6397:
  - BBPU 0x00, IRQ_STA 0x02, IRQ_EN 0x04, AL_MASK 0x08, TC_SEC 0x0a, AL_SEC 0x18.
  - PDN2 0x2e, **WRTGR 0x3c**.
- So the mainline `rtc-mt6397` driver with `mt6397_rtc_data` (wrtgr 0x3c), i.e. the `mediatek,mt6323-rtc` data,
  fits.
- The IRQ is `MT6328_IRQ_STATUS_RTC` (8), already in the irq enum.
- The mainline driver uses start year 1968, like MTK downstream (`RTC_MIN_YEAR = 1968`). Time written by stock
  Android reads back correctly, and the range runs to 2095.
- `CONFIG_RTC_DRV_MT6397=y` is already set.

Patch (about 15 lines) to `drivers/mfd/mt6397-core.c`:
```c
#define MT6328_RTC_BASE		0x4000
#define MT6328_RTC_SIZE		0x40
static const struct resource mt6328_rtc_resources[] = {
	DEFINE_RES_MEM(MT6328_RTC_BASE, MT6328_RTC_SIZE),
	DEFINE_RES_IRQ(MT6328_IRQ_STATUS_RTC),
};
/* in mt6328_devs[] */
{ .name = "mt6328-rtc", .num_resources = ARRAY_SIZE(mt6328_rtc_resources),
  .resources = mt6328_rtc_resources, .of_compatible = "mediatek,mt6328-rtc" },
```
DT (in `mt6328.dtsi` or our board file):
```dts
&mt6328 {
	rtc {
		compatible = "mediatek,mt6328-rtc", "mediatek,mt6323-rtc";
	};
};
```
The DT node is **required**. `mtk_rtc_probe()` takes `rtc->data` from `of_device_get_match_data()` and would
dereference NULL without an of_node. The `mt6323-rtc` fallback means no rtc driver change is needed. Optionally
add `"mediatek,mt6328-rtc"` to the driver's match table later, for upstreaming.

- **Effort:** under 1 hour.
- **Risk:** low.
  - The driver only touches TC/AL/IRQ_EN/PDN2 bit 4.
  - LK and preloader keep boot flags in other RTC SPARE/PDN registers; leave those alone.
  - Do not write to the RTC until a read looks right (`hwclock -r`).

---------------------------------------------------------------------------------------------------------------

## 4. Thermal

> **Implemented 2026-11-16, verified 2026-11-17:** `patches/0009` adds the SoC thermal zone and the battery NTC zone; `thermal_zone0`
> (`cpu-thermal`) reports live values and drives cpufreq at the passive trip (STATUS.md).

### SoC (THERM_CTRL 0x1100b000, irq SPI 78)
- Mainline `drivers/thermal/mediatek/auxadc_thermal.c` (CONFIG_MTK_THERMAL, already `=y`) has mt8173, mt2701,
  mt2712, mt7622, mt7986, mt8183 and mt8365. **No mt6735**, and `mt6735.dtsi` has no thermal, auxadc or efuse node.
- Downstream `mtk_tc_D2.c` (MT6735M = "D2") uses the same IP as mt8173/mt2701:
  - TEMPMONCTL, TEMPADCMUX/EN/PNP, TEMPMSR registers.
  - **AUXADC channel 11**, the same as mt8173.
  - 3 banks: bank0 CPU = TS_MCU3, bank1 SoC/GPU = TS_MCU1, bank2 LTE = TS_MCU2 (+ABB). Bank0/1 have one sensor
    each, bank2 has two.
- Calibration comes from efuse 0x10206184 / 0x1020619C / 0x102061A0, with fields:
  - ADC_GE `[31:22]` and ADC_OE `[21:12]` of 0x1A0.
  - O_VTSMCU1 `[25:17]`, O_VTSMCU2 `[16:8]` and DEGC_cali `[6:1]` of 0x19C.
  - O_VTSMCU3 `[8:0]` of 0x184.
  - O_SLOPE `[31:26]`, sign bit 7, CALI_EN bit 0 of 0x19C.
  - The fields are close to mt8173's, but the words are ordered and placed differently, so a small
    `mtk_thermal_extract_efuse_v1`-style variant is needed (or reorder the words).
- Needed:
  - `mt6735_thermal_data` (num_banks 3, sensor mux values, msr/adcpnp offsets).
  - A calibration parser.
  - Nodes for `auxadc` (`mediatek,mt6735-auxadc`, `mediatek,mt8173-auxadc`, clock `pericfg CLK_PERI_AUXADC`), for
    efuse (`mediatek,mt6735-efuse`, `mediatek,efuse` @0x10206000 + an nvmem cell 0x184..0x1A3), and for thermal
    (clocks `CLK_PERI_THERM` + AUXADC, resets `MT6735_PERI_RST0_THERM`, `mediatek,auxadc`,
    `mediatek,apmixedsys`).
  - Config: `MEDIATEK_MT6577_AUXADC=y`, `NVMEM_MTK_EFUSE=y`.
- **Effort:** 2-3 days. **Risk:** medium.
  - Wrong calibration only gives wrong numbers, unless you also enable the hardware over-temperature reset
    (THERMAL_PROTECT → RGU), so leave that off at first.
  - The PTP/SVS block (`ptp_fsm`) shares 0x1100b000. It is not used by mainline.
- Value for a desk device running `maxcpus=1`: low. The SoC will not get hot.

### Cheap alternatives
- PMIC chip temperature: MT6328 AUXADC ch4, using the efuse slope from downstream `mtk_ts_pmic.c`. Comes almost for
  free once the §2 driver exists.
- Board NTCs on the SoC AUXADC ch0/ch1 (stock `adc_channel temperature0 = 0, temperature1 = 1`, the `mtk_ts_bts`
  zones):
  - Downstream defaults are pull-up 39 kΩ to 1.8 V, 100 kΩ NTC (NCP15WF104), but these are tunable. **Board values
    unverified.**
  - Needs only `mt6577_auxadc` + `ntc_thermistor` (`murata,ncp15wf104`).
  - Effort half a day. Gives a "skin" temperature for deskd.

---------------------------------------------------------------------------------------------------------------

## 5. Accelerometer (optional)

> **Implemented 2026-11-17:** the fitted part is the **BMA255 @0x18** (chip ID 0xFA), driven by bmc150-accel; the
> MC3433 @0x4c is not fitted. See the device table in STATUS.md.

- Primary part: MC3433 @0x4c on i2c2 (stock `cust_accel@0`). Second-source: BMA2xx @0x18. Both drivers were built
  into stock, and one probes.
- Mainline:
  - `mc3230.c` only knows MC3230 (chip id 0x01, pcode 0x19) and MC3510C. **The MC3433 product code differs**, so
    it would fail the ID check. Its data registers are probably the 0x0D..0x12 extended layout.
  - Expect either a small new driver (MC34x3 family, about 200 lines) or an extension of mc3230.c.
- First step: `i2cdetect -y 2` and `i2cget -y 2 0x4c 0x3b` (PCODE), `0x18` (chip id).
  - If the board has the BMA2xx, use mainline `bmc150-accel`: `compatible = "bosch,bma2xx"`, reg 0x18.
- DT:
```dts
&i2c2 {
	status = "okay";
	clock-frequency = <400000>;
	accelerometer@4c {
		compatible = "mcube,mc3433";	/* new */
		reg = <0x4c>;
		/* stock EINT66 level-low, unused by the stock driver */
		mount-matrix = ...;	/* stock direction = 5 */
	};
};
```
- **Effort:** half a day for BMA2xx, 1-2 days for MC3433. **Risk:** low.
- The SAR sensors (SX9310 @0x28, A96T316 @0x20) and the cameras are not useful for the desk use case. Skip them.

---------------------------------------------------------------------------------------------------------------

## Recommended order

> **Done:** steps 1–4 and the accelerometer were implemented on 2026-11-17 (STATUS.md). The list is kept as the
> original plan.

1. **Read-only probe**: zero new code, about 30 min, no risk.
   - Add `&i2c3 { status = "okay"; clock-frequency = <100000>; };` and `&i2c2 { status = "okay"; };` with no
     children. `I2C_CHARDEV` is already `=y`; busybox needs the `i2c*` applets.
   - Dump the SM5414: `i2cdump -y -r 0-14 3 0x49 b`. This shows what LK left: BATREG, FASTCHG, VBUSLIMIT, FASTTIMER,
     AUTOSTOP.
   - Read the accelerometer IDs on bus 2.
   - Check GPIO124/63 levels in debugfs `pinctrl`.
   - Stopgap if needed: `i2cset -y 3 0x49 0x0b <BATREG=0 | WEAKBAT bits>` to drop CV to 4.10 V. LK re-inits on
     every boot, so this does not persist.
2. **RTC**: MFD cell + DT node. Trivial, and gives timekeeping across reboots.
3. **MT6328 AUXADC IIO driver + battery NTC (`ntc_thermistor`) + battery thermal zone**. Gives VBAT, TBAT, VBUS and
   charger-present. This is a prerequisite for safe charging.
4. **SM5414 charger driver** with the desk policy:
   - 4.10 V CV, 500 mA charge current, 1 A input limit, AICL 4.4 V, 5.5 h fast-charge timer.
   - nCHGEN temperature gate (0-45 °C).
   - A battery power supply with OCV-based capacity.

   After this step the device is safe to leave plugged in permanently.
5. Optional: PMIC chip temperature and board NTC zones (cheap). Then the accelerometer.
6. Last: SoC THERM_CTRL in auxadc_thermal (most work, least benefit at `maxcpus=1`).

## Open items to verify on hardware
- The SM5414 register values after LK, and the reg 0x0E ID value.
- Whether LK drives nCHGEN low (charging enabled) on a normal, non-KPOC boot.
- The actual battery: 3500 mAh LiPo, 4.35 V class. The OCV profile peaks at 4.333 V, but the label is unverified.
- Which accelerometer is populated.
- MT6328 AUXADC: whether the AP request path works while the stock modem firmware is not loaded. Expected yes.
