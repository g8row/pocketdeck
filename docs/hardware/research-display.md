# TB-7304X (MT6737M) mainline display: research findings

Date: 2026-11-16. Read-only research. Nothing on the tablet, USB, fastboot or network was touched, and no repo files were edited.

Sources:
- `backup/partitions/lk.bin` (ARM32 Thumb, linked 0x41E00000, file offset = va - 0x41E00000 + 0x200).
- `backup/partitions/boot.bin`: the kernel was gunzipped to `scratchpad/stock/Image`. It is an arm64 3.18 kernel, `Image` offset 0 = VA 0xffffffc000080000. The build path in its strings is `.../ZA1962_601__A/kernel-3.18`.
- `mainline/stock/stock.dts`.
- The mt6735-mainline tree at tag `v7.0.10-mt6735` (046883c), sparse-cloned to `scratchpad/src/linux`.
- The decompiled stock DTB of an MT6735 (D1) phone (Wiko U FEEL), from pmaports commit 136ef57, used for comparison.

Helper scripts and raw dumps:
- `scratchpad/tools/a64.py` is an arm64 disassembler that resolves adrp/add pairs.
- `scratchpad/tools/lcmemu.py` is a small interpreter that turns MTK `lcm_init` code into DSI command lists.
- `scratchpad/tools/xref.py` finds adrp/add string references.
- Raw outputs: `scratchpad/stock/{dj,gx,hx8394d,nt35521z}_init.txt`.

---

## 1. Does MT6737M really differ from the mainline mt6735.dtsi? Yes. It is a "D2" MMSYS layout.

The mainline `mt6735.dtsi` matches **MT6735 "Denali-1"** silicon:
- The Wiko U FEEL (MT6735) stock DTB has `dispsys` with RDMA0 at 0x14008000, COLOR 0x1400b000, DITHER 0x1400f000, DSI 0x14011000, MUTEX 0x14014000, larb0 0x14015000, smi_common 0x14016000 and MIPI_TX 0x14017000. Its GCE events are `disp_ovl0_sof=6`, `disp_rdma0_sof=7`. This is exactly the mainline map.
- The samsung-grandpplte (MT6737T) mainline DTS drives DSI with that same map.

Our tablet is a **D2** build:
- LK prints `[PWRAP] mt_pwrap_init---- use D2`.
- The stock DTB has `model = "MT6735M"`.
- Here MMSYS has an **OVL1 slot at 0x14008000**. The slot is listed as absent (`0 0`) in the stock `DISPSYS` reg array, and its reads give bus filler such as the 0x1234 you saw. Every block after OVL0 sits **+0x1000** higher, and its GIC SPI is **+1**.
- The same one-step shift appears in the GCE/mutex event numbers: `disp_rdma0_sof=8`, `disp_dither_sof=0xf`, `disp_pwm0_sof=0x11`.

So the dtsi is not "wrong". It describes the other die. We need D2 overrides. `mt6735m.dtsi` today only overrides pinctrl and pwrap.

### Corrections to the "known facts" in the brief
- MUTEX is **0x14015000**, not 0x14013000. 0x14013000 is DPI0.
- larb0 is **0x14016000** and smi_common is **0x14017000**.
- Consequence for `mainline/initramfs/init`: the display watcher's `larb0=$(r 0x14015004)` really reads **MUTEX INTSTA**, and `smi=$(r 0x14016004)` really reads **larb0+4**.
- Today, the mainline `smi_larb0` node (0x14015000) points at the **MUTEX block**. `mtk-smi` larb `config_port` would write MMU_EN etc. into mutex registers. That is probably part of why patch 0002 (skip larb config without iommu) was needed.

### Full block map for this chip (stock DTB `DISPSYS` array, confirmed by the separate stock nodes)

| Block | D2 (this tablet) reg / SPI | mainline dtsi (D1) | Action |
|---|---|---|---|
| MMSYS config | 0x14000000 / 206 | same | ok |
| OVL0 | 0x14007000 / 193 | same | ok (fix iommus, see below) |
| OVL1 (absent) | 0x14008000 / 194 | n/a | do not describe |
| RDMA0 | **0x14009000 / 195** | 0x14008000 / 194 | fix |
| RDMA1 | 0x1400a000 / 196 (stock marks absent) | n/a | skip |
| WDMA0 | 0x1400b000 / 197 | n/a | optional |
| COLOR | **0x1400c000 / 198** | 0x1400b000 / 197 | fix |
| CCORR | 0x1400d000 / 199 | n/a | not needed for the RDMA-only path |
| AAL | 0x1400e000 / 200 | n/a | " |
| GAMMA | 0x1400f000 / 201 | n/a | " |
| DITHER | **0x14010000 / 202** | 0x1400f000 / 201 | fix |
| UFOE (absent) | 0x14011000 / 203 | (that is DSI on D1) | — |
| DSI0 | **0x14012000 / 204** | 0x14011000 / 203 | fix |
| DPI0 | 0x14013000 / 205 | n/a | — |
| (MM) DISP_PWM | 0x14014000 | n/a | unused (backlight uses 0x1100e000) |
| MUTEX | **0x14015000 / 186** | 0x14014000 / 186 | fix reg only |
| SMI larb0 | **0x14016000 / 176** | 0x14015000 | fix |
| SMI common | **0x14017000** | 0x14016000 | fix |
| MIPI_TX | **0x14018000** | 0x14017000 | fix |
| DISP_PWM0 (backlight) | 0x1100e000 / 117 | same | ok |
| M4U | 0x10205000 / 146 | same | ok |

### MMSYS routing (mtk-mmsys `mt6735-mmsys.h`): unchanged on D2
LK is built for D2 and its dump/mux strings use the same offsets and bit meanings as mainline:
- 0x30 OVL0_MOUT_EN: bit0 = color, bit1 = wdma0
- 0x38 DITHER_MOUT_EN: bit0 = rdma0
- 0x58 COLOR0_SIN: sin1 = ovl0
- 0x64 DSI0_SIN: sin1 = rdma0
- 0x6c RDMA0_SOUT: sout2 = dsi0
- 0x140 MM_SW0_RST_B

The mainline routing table can be reused (confidence: medium-high).

Important: OVL0's MOUT can go **only to COLOR or WDMA0**. An "OVL0 -> RDMA0 -> DSI0" pipeline does not exist in hardware. Two options:
- (a) **RDMA0 -> DSI0** only (RDMA0 is the plane, `rdma0_sout2_mm_dsi0_sin1`). This is the simplest path.
- (b) OVL0 -> COLOR -> CCORR -> AAL -> GAMMA -> DITHER -> RDMA0 -> DSI0. This is the mainline mt6735 `main_path`, and the three middle blocks are fixed links. They need clocks on and bypass mode, which mainline does not handle; it relies on LK state plus `clk_ignore_unused`.

### Mutex module bits: must change for D2 (new driver data)
Mainline `mt6735_mutex_mod` is OVL 6, RDMA0 7, RDMA1 8, WDMA 9, CCORR 10, COLOR 11, AAL 12, GAMMA 13, DITHER 14, PWM 16. That equals the D1 sof numbering.

Inferred for D2 from the stock GCE event list: **OVL0 6, (OVL1 7), RDMA0 8, RDMA1 9, WDMA0 10, CCORR 11, COLOR 12, AAL 13, GAMMA 14, DITHER 15, PWM0 17**.
- SOF values are unchanged: DSI0 = 1.
- Register layout is unchanged: MUTEX0_MOD 0x2c, SOF 0x30 (LK dump strings `(0x02c)M0_MOD`, `(0x030)M0_SOF`).
- Confidence: medium. Verify with a single read under LK, see step 0.

### Clock gates / resets (unverified for D2)
- Mainline `clk-mt6735-mmsys.c`:
  - CG_CON0: OVL0 bit 10, RDMA0 11, RDMA1 12, WDMA0 13, COLOR 14, CCORR 15, AAL 16, GAMMA 17, DITHER 18, SMI_COMMON 0, LARB0 1.
  - CG_CON1: DSI_ENGINE 2, DSI_DIGITAL 3.
  - Reset `MT6735_MM_RST0_DSI` = SW0 bit 22.
- I could not find the D2 gate table in the stock kernel (it uses the old `mt_clkmgr`, not CCF names). If an OVL1 bit was inserted on D2, these bits would shift. **Must be checked on the device** (step 0).

### M4U / SMI: why the IOMMU defers, and what to fix
- The stock kernel's M4U port table (strings at Image 0xd1cc18) for **larb0** on this chip:

  | Port | Master |
  |---|---|
  | 0 | DISP_OVL0_PORT0 |
  | 1 | DISP_OVL0_PORT1 |
  | 2 | **DISP_RDMA0** |
  | 3 | DISP_WDMA0 |
  | 4 | MDP_RDMA |
  | 5 | MDP_WDMA |
  | 6 | MDP_WROT |
  | 7 | DISP_FAKE |

  Mainline `mediatek,mt6735-m4u.h` has RDMA0 = port 1 and WDMA0 = port 2. That is the D1 numbering and **wrong here**.
- The stock kernel knows only **three larbs**: larb0 MM, larb1 VDEC+VENC (port `VENC_BSDMA_VDEC_POST0` etc.), larb2 CAM. The stock DTB also has only smi_larb0/1/2, and smi_common lists 3 larbs.
- Mainline lists `mediatek,larbs = <larb0>, <larb1>, <larb2>, <larb3>`. larb3 (0x17001000) sits in the VEN power domain, which our DTS deletes, so larb3 never probes. `mtk_iommu_mm_dts_parse()` then returns `-EPROBE_DEFER` for a present-but-unbound larb, and that is the **"mm dts parse fail" defer**.
  - Fix: `&smi_larb3 { status = "disabled"; };`. The driver skips unavailable larbs (`of_device_is_available`).
  - Alternatively, drop larb3 from `mediatek,larbs`.
- larb1 (VDE domain) and larb2 (ISP domain) must also really probe, or must be disabled.
- Without IOMMU, mediatek-drm can still work with CMA (`cma=64M`) as long as the larb0 MMU_EN bits are 0. LK does not use M4U.
  - But then nothing keeps the larb0/smi_common clocks on, because the OVL/RDMA -> larb device link comes from the IOMMU.
  - Either keep `clk_ignore_unused`, or (better) get M4U working with the fixes above.

### Drivers already present in the tree (no code needed)
- `mediatek,mt6735-mmsys` (drm main path + mmsys routes + `clk-mt6735-mm`)
- `mediatek,mt6735-disp-mutex`
- `mt6735-disp-ovl` -> mt8173 ovl
- `mt6735-disp-rdma` -> mt2701 rdma
- color -> mt8167, dither -> mt8183
- `mt6735-dsi` -> mt8173 dsi
- `mt6735-mipi-tx` -> mt8173 mipi-tx
- `mt6735-disp-pwm` -> mt8173
- `mt6735-m4u`, `mt6735-smi-larb` / `-smi-common`

The pipeline can also be described with an **OF graph** on the mmsys node. `mtk_drm_drv.c` builds `main_path` from the graph when `of_graph_is_present(mmsys)`, so an RDMA0 -> DSI0 path needs **no driver change**.

**Note:** mediatek-drm does not call the aperture helpers, so it will not kick out simpledrm. Boot with `lkfb.enable=0`, or add `aperture_remove_all_conflicting_devices()`, when testing.

---

## 2. Panel identification

LK and the stock kernel contain four LCM drivers. LK's `lcm_driver_list` @0x41e555e4 probes them in this order:
1. `hx8394d_dsi_vdo_boe` (DSI read-ID)
2. `nt35521z_dsi_vdo_gx` (DSI read-ID)
3. `nt51021b_dsi_vdo_dj`: `compare_id` returns true if **GPIO125 == 0**. LK prints `"%s, nt5102b GPIO125 = %d"`.
4. `nt51021b_dsi_vdo_gx`: true if **GPIO125 == 1**.

So "NT51021B" is right whenever neither read-ID panel answers. GPIO125 picks the vendor (DJ vs GX). This cannot be decided offline. Read `lcmname` from `/proc/device-tree/chosen/atag,videolfb` (the trailing string; mtk-lk-fb already prints it as an `lkfb:` line), or read GPIO125. A single driver can support both: read GPIO125 (an `id-gpios`) or use two compatibles.

### LCM_PARAMS decode
- Offsets come from the stock `ddp_dsi` dump function @0xffffffc0004e6534: the format strings name each field, and that confirms `dsi` starts at params+0x1cc.
- The DJ values also match LK's `lcm_get_params` @0x41e24c58.

| Parameter | nt51021b **DJ** | nt51021b **GX** | evidence |
|---|---|---|---|
| type | DSI | DSI | params+0 = 2 |
| resolution | 600 x 1024 | 600 x 1024 | +0x18 / +0x1c |
| dsi.mode | BURST_VDO_MODE (3) | BURST_VDO_MODE | dsi+0x00 |
| LANE_NUM | **4** | 4 | dsi+0x14 |
| format | RGB888, PS 24bit packed | same | dsi+0x24=2, +0x2c=2 |
| VSA / VBP / VFP | 2 / 90 / 90 | 2 / 25 / 35 | dsi+0x3c/0x40/0x44 |
| HSA / HBP / HFP | 32 / 74 / 74 | 13 / 85 / 85 | dsi+0x50/0x54/0x58 |
| PLL_CLOCK | 174 MHz (348 Mb/s/lane) | 168 MHz (336 Mb/s/lane) | dsi+0xc4 |
| ssc_disable | 1 | 1 | dsi+0xd4 |
| cont_clock | 1 (continuous HS clock) | 1 | dsi+0xe0 |
| ESD check | off | off | — |

DRM modes:
- **DJ**: hdisplay 600, hsync_start 674, hsync_end 706, htotal 780. vdisplay 1024, vsync_start 1114, vsync_end 1116, vtotal 1206.
  - clock = 56441 kHz at 60 Hz, or **58000 kHz** to match the stock link (348x4/24), which gives 61.7 Hz.
- **GX**: h 600/685/698/783, v 1024/1059/1061/1086.
  - clock = 51022 kHz at 60 Hz. The stock link rate corresponds to 56000 kHz.
- DSI flags: `MIPI_DSI_MODE_VIDEO | MIPI_DSI_MODE_VIDEO_BURST | MIPI_DSI_MODE_LPM`. Leave out `CLOCK_NON_CONTINUOUS`.
- `MIPI_DSI_FMT_RGB888`, 4 lanes.
- Physical size is not set in the LCM. For a 7.0" 600x1024 panel, estimate about 90 x 154 mm.

### Power, reset, regulators
- **No PMIC regulator calls** in either NT51021B driver. The panel logic rail is switched by **GPIO83** (`gpio_lcd_pwr`). Model it as a `regulator-fixed` with a GPIO enable. VIO18 (MIPI IO) is the always-on PMIC rail.
  - The README says USB `drvvbus` is GPIO83. The stock pinctrl `drvvbus_init` is actually **GPIO63**, so GPIO83 is the LCD only.
- Reset: **GPIO146** (`gpio_lcd_rst`, pinmux LCM_RST/GPIO). Low = reset.
- LK `lcm_init_power` @0x41e24cec:
  1. GPIO146 mode 0, output 0
  2. wait 20 ms
  3. GPIO83 mode 0, output 1
  4. wait 20 ms
- Kernel `init_power` only prints (LK already powered the panel). `resume_power`: GPIO83 = 1, 20 ms. `suspend_power`: GPIO83 = 0, 20 ms.
- `lcm_init` reset (both variants), as raw RST levels: **0** for 20 ms, **1** for 60 ms, **0** for 30 ms, **1** for 200 ms. Then the command list.
- Stock `resume` calls `lcm_init` again: a full re-init after reset.

### Init sequence, nt51021b DJ
Source: kernel `lcm_init` @0xffffffc0004a00b4. Straight-line code with no branches, decoded completely.

The stock kernel sends most entries as 0x39 DCS long writes of 2 bytes; `8C 8E`, `85 04`, `86 08`, `83 AA`, `84 11`, `98 92` and `9C 10` go as 0x15 short writes. Both packet forms are accepted.

```
8F A5
8C 8E
C5 2E
C7 2E
FA 16
FD 1D
90 FF
83 AA ; 84 11          -- gamma page 1
C0 12  C1 1E  C2 2B  C3 35  C4 41  C5 49  C6 52  C7 5A  C8 61  C9 CE  CA D2  CB EB  CC F6  CD F9  CE F6  CF F8
D0 F9  D1 07  D2 19  D3 38  D4 3F  D5 A8  D6 B1  D7 B9  D8 C0  D9 CB  DA D7  DB E3  DC F4  DD FE  DE 00  DF 2F
E0 12  E1 1E  E2 2B  E3 35  E4 41  E5 49  E6 52  E7 5A  E8 61  E9 CE  EA D2  EB EB  EC F6  ED F9  EE F6  EF F8
F0 F9  F1 07  F2 19  F3 38  F4 3F  F5 A8  F6 B1  F7 B9  F8 C0  F9 CB  FA D7  FB E3  FC F4  FD FE  FE 00  FF 2F
83 BB ; 84 22          -- the same 64 C0..FF values repeated
83 CC ; 84 33          -- the same 64 C0..FF values repeated
85 04
86 08
83 AA
84 11
98 92
9C 10
83 00
84 00
8F 00
delay 20 ms
```

There is **no 0x11 / 0x29**: the NT51021B starts from the video stream.

Suspend:
1. `83 00`, `84 00` (DCS short)
2. wait 10 ms
3. `10` (sleep in)
4. wait 120 ms
5. RST = 0
6. wait 20 ms

### Init sequence, nt51021b GX
Source: kernel `lcm_init` @0xffffffc0004a25a8. All entries are short writes. Reset is the same as DJ.

```
83 00
84 00
84 00
85 04
86 08
8C 8E
C5 2B
C7 2B
85 04
86 08
83 AA
84 11
9C 10
A9 4B
83 00
84 00
FD 5B
FA 14
11          -- then wait 120 ms
29          -- then wait 20 ms
```

Suspend:
1. `28`
2. wait 50 ms
3. `10`
4. wait 120 ms
5. RST = 1 (as decoded)
6. wait 20 ms

### Other two LCMs (in case the read-ID panels are fitted)
Both are 600x1024, BURST, 4 lanes.
- hx8394d_boe: VSA 2, VBP 8, VFP 6, HSA 32, HBP 93, HFP 140, PLL 168.
- nt35521z_gx: VSA 2, VBP 90, VFP 90, HSA 2, HBP 32, HFP 60, PLL 160.

Their init code uses loops/tables, so they were only partly decoded. See `scratchpad/stock/{hx8394d,nt35521z}_init.txt`. The kernel struct VAs are listed in section 6.

### Backlight
- Stock `led@6 compatible = "mediatek,lcd-backlight"`, `led_mode = <5>` = `MT65XX_LED_MODE_CUST_BLS_PWM`. This is the **DISP_PWM0 block @0x1100e000**, which is `disp_pwm` in mainline. It is not an LCM register and not a PMIC ISINK.
- The stock kernel uses `disp_pwm_set_backlight` with a 1024-level scale.
- Pin: probably **GPIO69 func 1 (DISP_PWM)**, as on grandpplte. Unverified. GPIO55 (func 7) and GPIO129 (func 2) are the other options.
- No backlight-enable GPIO was found in the LCM code.
- Use `pwm-backlight` with `pwms = <&disp_pwm 0 PERIOD>`. Get the period from the DISP_PWM CON0/CON1 registers that LK leaves (step 0).

### No mainline panel driver exists
- There is no NT51021(B) driver in `drivers/gpu/drm/panel` (7.0) and no upstream patch was found.
- Write `panel-novatek-nt51021b.c` (about 250 lines) using the `mipi_dsi_*_multi` helpers, following e.g. `panel-novatek-nt35521.c` or `panel-samsung-s6d78a0` (the grandpplte panel on this same SoC tree).

---

## 3. Proposed DT (board DTS, or better a new `mt6735m-disp.dtsi`)

Overriding `reg` keeps the D1 unit addresses in the node names, which `dtc W=1` warns about. Cleaner: `/delete-node/` and re-add, or fix it in a D2 dtsi.

```dts
#include <dt-bindings/memory/mtk-memory-port.h>

/ {
	lcd_vdd: regulator-lcd-vdd {
		compatible = "regulator-fixed";
		regulator-name = "lcd_vdd";
		gpio = <&pio 83 GPIO_ACTIVE_HIGH>;
		enable-active-high;
		startup-delay-us = <20000>;
		regulator-boot-on;          /* LK leaves it on */
	};

	backlight: backlight {
		compatible = "pwm-backlight";
		pwms = <&disp_pwm 0 1000000>;   /* TODO: period from DISP_PWM_CON regs under LK */
		pinctrl-names = "default";
		pinctrl-0 = <&backlight_pins>;
		brightness-levels = <0 1023>;
		num-interpolated-steps = <1023>;
		default-brightness-level = <600>;
	};
};

/* ---- D2 (MT6735M/MT6737M) MMSYS: OVL1 slot at 0x14008000, later blocks +0x1000 / SPI +1 ---- */
&ovl {
	iommus = <&m4u MTK_M4U_ID(0, 0)>, <&m4u MTK_M4U_ID(0, 1)>;   /* D2: OVL0_PORT0/1 */
};
&disp_rdma0 {
	reg = <0 0x14009000 0 0x1000>;
	interrupts = <GIC_SPI 195 IRQ_TYPE_LEVEL_LOW>;
	iommus = <&m4u MTK_M4U_ID(0, 2)>;                             /* D2: DISP_RDMA0 = port 2 */
};
&color {
	reg = <0 0x1400c000 0 0x1000>;
	interrupts = <GIC_SPI 198 IRQ_TYPE_LEVEL_LOW>;
};
&dither {
	reg = <0 0x14010000 0 0x1000>;
	interrupts = <GIC_SPI 202 IRQ_TYPE_LEVEL_LOW>;
};
&dsi {
	reg = <0 0x14012000 0 0x1000>;
	interrupts = <GIC_SPI 204 IRQ_TYPE_LEVEL_LOW>;
};
&disp_mutex {
	compatible = "mediatek,mt6735m-disp-mutex";   /* NEW: D2 mod bits, see section 4 */
	reg = <0 0x14015000 0 0x1000>;
	/* SPI 186 unchanged */
};
&smi_larb0  { reg = <0 0x14016000 0 0x1000>; };   /* SPI 176 if ever needed */
&smi_common { reg = <0 0x14017000 0 0x1000>; };
&mipi_tx    { reg = <0 0x14018000 0 0x1000>; status = "okay"; };

/* D2 has 3 larbs (VENC shares larb1). larb3 never probes -> "mm dts parse fail" defer. */
&smi_larb3 { status = "disabled"; };
&m4u { mediatek,larbs = <&smi_larb0>, <&smi_larb1>, <&smi_larb2>; };

/* Minimal pipeline first: RDMA0 -> DSI0 via OF graph (no OVL/COLOR/CCORR/AAL/GAMMA/DITHER) */
&mmsys {
	port {
		mmsys_ep_main: endpoint@0 {
			reg = <0>;                  /* CRTC_MAIN */
			remote-endpoint = <&rdma0_in>;
		};
	};
};
&disp_rdma0 {
	status = "okay";
	ports {
		#address-cells = <1>;
		#size-cells = <0>;
		port@0 { reg = <0>; rdma0_in:  endpoint { remote-endpoint = <&mmsys_ep_main>; }; };
		port@1 { reg = <1>; rdma0_out: endpoint { remote-endpoint = <&dsi0_in>; }; };
	};
};
&dsi {
	status = "okay";
	/* the dtsi has a single `port` with dsi0_out; it must become ports { port@0 (in) port@1 (out) } */
	ports {
		#address-cells = <1>;
		#size-cells = <0>;
		port@0 { reg = <0>; dsi0_in: endpoint { remote-endpoint = <&rdma0_out>; }; };
		port@1 { reg = <1>; dsi0_out_ep: endpoint { remote-endpoint = <&panel_in>; }; };
	};

	panel: panel@0 {
		compatible = "lenovo,tb7304x-nt51021b-dj";   /* or -gx; or a generic novatek,nt51021b + id-gpios */
		reg = <0>;
		power-supply = <&lcd_vdd>;
		reset-gpios = <&pio 146 GPIO_ACTIVE_LOW>;
		/* id-gpios = <&pio 125 GPIO_ACTIVE_HIGH>;   0 = DJ, 1 = GX */
		backlight = <&backlight>;
		pinctrl-names = "default";
		pinctrl-0 = <&panel_pins>;
		port { panel_in: endpoint { remote-endpoint = <&dsi0_out_ep>; }; };
	};
};
&disp_pwm { status = "okay"; };

&pio {
	panel_pins: panel-pins {
		pins-rst { pinmux = <PINMUX_GPIO146__FUNC_GPIO146>; };
		pins-pwr { pinmux = <PINMUX_GPIO83__FUNC_GPIO83>; };
		pins-id  { pinmux = <PINMUX_GPIO125__FUNC_GPIO125>; input-enable; };
	};
	backlight_pins: backlight-pins {
		pins-pwm { pinmux = <PINMUX_GPIO69__FUNC_DISP_PWM>; };   /* VERIFY */
	};
};
```

Notes on the snippet:
- Check the exact graph port numbering against `mtk_drm_of_ddp_path_build_one()` and the rdma/dsi bindings in 7.0: output is port@1, input port@0, and the mmsys endpoint reg is the CRTC index.
- If you prefer the hard-coded `mt6735_mtk_ddp_main` (OVL0-COLOR-DITHER-RDMA0-DSI0) path instead, drop the graph and enable `&ovl`, `&color` and `&dither`. Expect CCORR/AAL/GAMMA clock and bypass issues.
- With M4U still not working, delete the `iommus` lines, add `cma=64M`, and keep `clk_ignore_unused`.

---

## 4. Code that is missing

1. **Panel driver** `drivers/gpu/drm/panel/panel-novatek-nt51021b.c`:
   - prepare: regulator on, 20 ms, reset dance, command table
   - unprepare: suspend table, reset low, regulator off
   - DJ and GX tables and modes, selected by compatible or `id-gpios` (GPIO125)
   - Kconfig/Makefile entries and a small binding.
2. **D2 mutex data** in `drivers/soc/mediatek/mtk-mutex.c`: `mt6735m_mutex_mod[]` with OVL0 6, RDMA0 8, RDMA1 9, WDMA0 10, CCORR 11, COLOR 12, AAL 13, GAMMA 14, DITHER 15, PWM0 17. SOF and register offsets are the same as mt6735. Add a new compatible `mediatek,mt6735m-disp-mutex`, plus the matching entry in `mtk_drm_drv.c`'s `mtk_ddp_comp_dt_ids` (or a generic fallback compatible).
3. **Possibly** D2 `clk-mt6735-mm` gate bits and `MT6735_MM_RST0_DSI`, if step 0 shows they shift.
4. **Possibly** a D2 m4u port header (or just raw `MTK_M4U_ID(0,n)` in DT as above). The mainline names `M4U_PORT_DISP_RDMA0`/`WDMA0` have D1 values.
5. Hand-over: make `mtk-lk-fb` / simpledrm step aside. Either use `lkfb.enable=0` while testing, or call `aperture_remove_all_conflicting_devices()` in `mtk_drm_bind`.
6. `mainline/initramfs/init` display watcher: fix the larb0/smi labels and addresses (larb0 is 0x14016000, MUTEX is 0x14015000).

---

## 5. Ordered bring-up plan

**Step 0: capture LK state, read-only.** Use devmem under the current simpledrm boot, with the display running from LK.
- `lcmname` in `/proc/device-tree/chosen/atag,videolfb` (DJ vs GX), and the GPIO125 level.
- MUTEX0_MOD `0x1401502c` and SOF `0x14015030`.
  - If the mod bits are the D2 values (e.g. RDMA0 = bit 8 and DITHER = bit 15 set), the D2 table is confirmed.
  - The D1 pattern would be bits 7 and 14.
- MM_CG_CON0/1 `0x14000100`/`0x14000110` and MMSYS routing registers `0x14000030/38/58/64/6c`.
  - An optional definitive CG test: write one bit to CG_SET `0x14000104` and back via CG_CLR `0x14000108` (bit 11 vs 12) and watch whether the image freezes.
- DSI0 `0x14012000` registers: MODE_CTRL +0x14, TXRX_CTRL +0x18 (lane count), VSA/VBP/VFP +0x20.., HSA/HBP/HFP +0x50... These cross-check the decoded timings and DJ/GX.
- MIPI_TX `0x14018000` PLL registers.
- DISP_PWM `0x1100e000` +0x00/+0x10/+0x14 (period), and GPIO69 mux.
- larb0 MMU_EN `0x14016fc0` (expected 0, meaning LK uses physical addressing).

**Step 1: DT address/IRQ/larb fixes only, with display nodes still disabled.**
- Expect smi_larb0/common and M4U to probe (no "mm dts parse fail").
- Keep `mtk-lk-fb`. Check that the LK image survives the SMI/M4U probe: larb `config_port` with real addresses should now hit larb0, not MUTEX.

**Step 2: D2 mutex data + panel driver + RDMA0 -> DSI0 graph.**
- Boot with `lkfb.enable=0 clk_ignore_unused pd_ignore_unused`.
- First get `modetest`, or fbcon on the mediatek-drm fbdev, to show the image.
- Use the DJ/GX mode matching step 0.

**Step 3: backlight** (`pwm-backlight` on `disp_pwm`), then **suspend/resume** (DSI off/on, panel re-init).

**Step 4: full OVL0 path.** Optionally add OVL0 -> COLOR -> (CCORR/AAL/GAMMA) -> DITHER -> RDMA0 -> DSI0 for multi-plane support. This needs CCORR/AAL/GAMMA nodes or bypass handling, and their clocks.

**Step 5: drop `clk_ignore_unused` and the 0002 smi patch** once IOMMU and larb links are correct.

### Risks
- **D2 clock-gate/reset bit layout is unverified.** A wrong DSI or RDMA gate means a dead or frozen pipe. Do step 0 first.
- **D2 mutex bits are inferred** from the GCE event list. Wrong bits mean no SOF/flush, so RDMA0 never starts (frame-done never fires).
- **DIS power domain / DSI reset** during probe blanks LK's image. After that, only our panel driver can bring it back. A bad init gives a black screen with USB still alive. Keep the USB gadget and telnet path for debugging.
- **DJ vs GX mismatch.** Sending the wrong table likely gives a garbled image or none. Settle it with lcmname/GPIO125 before step 2.
- **Burst-mode clocking:** mainline mtk_dsi derives the link rate from `mode->clock`. Stock ran 348/336 Mb/s per lane. Choosing `clock` to reproduce that is the safest option.
- **MIPI_TX PLL** (mt8173 data, TVDPLL parent in the dtsi) is unproven on D2. It works on D1/grandpplte.
- **IOMMU:** M4U port IDs differ on D2 (RDMA0 = port 2). Wrong IDs leave MMU_EN on the wrong port, causing translation faults or garbage. Without IOMMU, larb clocks may be gated (needs `clk_ignore_unused`).
- **simpledrm and mediatek-drm** both bind to the display if the hand-over is not handled.
- **GPIO83** must be modelled as the LCD supply. If anything else claims it (e.g. a wrong drvvbus assumption), the panel loses power.

---

## 6. Evidence index

Stock kernel (Image VA):
- LCM_DRIVER structs at file offsets 0xfc3828 (dj), 0xfc39d0 (gx), 0xfc3680 (nt35521z), 0xfc32c8 (hx8394d).
- dj: get_params 0x4a229c, init 0x4a00b4, suspend 0x49fff4, resume 0x4a227c, init_power 0x49ff28, suspend_power 0x49ffac, resume_power 0x49ff64, compare_id 0x49ff44 (GPIO125 == 0).
- gx: get_params 0x4a2900, init 0x4a25a8, suspend 0x4a2508, compare_id 0x4a2458 (GPIO125 == 1).
- LCM util table (dj) at 0xffffffc001233c50: +0x20 MDELAY, +0x58 dsi_set_cmdq. The LCD pwr gpio global is at 0x...233c48 and the rst global at 0x...233d28.
- DSI-params dump function: 0xffffffc0004e6534 (strings 0x...dede30 onward).
- M4U port names: Image offset 0xd1cc18.

LK:
- LCM list @0x41e555e4 (hx8394d, nt35521z, nt51021b_dj, nt51021b_gx).
- dj get_params 0x41e24c58, init_power 0x41e24cec, compare_id 0x41e23a90.
- String "use D2". MMSYS/mutex dump strings.

Stock DTB:
- `DISPSYS@0x14007000` reg/irq arrays
- `gce` sof/frame_done list
- smi_larb0/1/2, smi_common, `lcm*` nodes (pwr 83, rst 146)
- `led@6` mode 5

D1 reference: Wiko U FEEL stock DTB in https://gitlab.postmarketos.org/postmarketOS/pmaports/-/commit/136ef57fd5d6dd2156fcd8215dab5e5a46b9c4fd.patch
