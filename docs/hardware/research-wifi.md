# TB-7304X mainline: WiFi / BT (MT6625L via CONSYS) — feasibility notes

Status 2026-11-19: **works at boot** from `tbkern_a`: 2.4 GHz scan, WPA2 association, DHCP, internet. The board is
2.4 GHz only (NVRAM). Association needs a saved AP in range; check `wpa_cli -i mt6625_0 status`. See "Bring-up".

## Hardware
- The WiFi/BT/GPS/FM MAC and baseband live in the SoC's **CONSYS** (connectivity subsystem); the **MT6625L** next to
  it is the RF/analog companion. Android talks to CONSYS through **WMT** (wireless management task) over **BTIF**
  with the **STP** protocol, and loads firmware patches (ROM patch + RAM code) into EMI-reserved memory.
- mt6735 mainline power bindings already have `MT6735_POWER_DOMAIN_CONN`; there is no CONSYS node, driver or
  reserved-memory layout in mainline.

## Stock DT (mainline/stock/stock.dts)
| Node | Values |
|---|---|
| `consys@18070000` | `mediatek,mt6735m-consys`, `mediatek,mt6735-consys`; reg 0x18070000/0x200 (CONSYS), 0x10212000/0x100, 0x10000000/0x2000 (topckgen), 0x10006000/0x1000 (SPM); IRQs SPI 227 (0xe3) and 225 (0xe1); supplies vcn18, vcn28, vcn33_bt, vcn33_wifi (MT6328 LDOs); pinctrl states for the GPS LNA |
| `btif@1100c000` | `mediatek,btif`, IRQ SPI 90 (0x5a) |
| `wifi@180f0000` | `mediatek,wifi`, reg 0x180f0000/0x5c, IRQ SPI 226 (0xe2) |
| `consys-reserve-memory` | `mediatek,consys-reserve-memory`, no-map, 1 MB, 2 MB aligned (dynamic: LK/kernel picks the address) |

## Prior art
- No mainline driver for any MT65xx/MT67xx CONSYS WiFi. postmarketOS' MT6735 kernel has no WiFi either.
- **Banana Pi R2 (MT7623 + MT6625L, same CONSYS + combo-RF design):** frank-w's BPI-Router-Linux kernel carried
  MediaTek's WMT/BTIF/STP + `wlan_gen2` driver, ported forward from the vendor BSP, in
  `drivers/misc/mediatek/{btif,connectivity}` on the **5.4-main, 5.10-main and 5.15-main** branches; dropped from
  6.1-main on (checked via the GitHub API). Userspace: `wmt_loader`, `stp_uart_launcher -p /etc/firmware`, then
  `wlan_gen2`. Reported working on 5.8–5.10 (2.4 GHz). Known issue: hangs if another `wlan0` exists.
  Upstream consensus: too large for mainline, depends on the WMT tools.
- Downstream MT6735 BSP (`dhirajms/kernel_lenovo_P1m_3.18.y`, `maozi-114/android_kernel_mt6735-37_3.18.79`) has
  the MT6735-specific CONSYS platform layer (`connectivity/common/combo/linux/pub/.../mt6735`?) — to be located.

## Bring-up (2026-11-17)
Driver: `mainline/wcn` (frank-w 5.15 tree + `conn_soc/mt6735`, ported to 7.0; history in git), copied into the
kernel by `patches/0011-wcn-mediatek.sh`, built in (`CONFIG_MTK_COMBO*`, `MTK_BTIF`, `NL80211_TESTMODE`).
Userspace: `mainline/wcn-tools` (BPI-R2's `wmt_loader` + `stp_uart_launcher`, static).

Installed (2026-11-17): the kernel in `tbkern_a`, `iw`/`wpa_supplicant`/`wifi-up`/the OpenRC `wifi` service in the
root image. At boot `wifi` runs `wifi-up join` in the background when `/data/wifi/wpa_supplicant.conf` exists
(`wifi-up save <ssid> <password>` writes it, hashed PSK only), otherwise just powers the radio. The firmware and NVRAM
are not in the image (proprietary, per device): `wifi-deploy.sh` once; `tb-install.sh rootfs` carries them over.

Short form: `mainline/scripts/wifi-deploy.sh` on the host (firmware, NVRAM, tools, `wifi-up`, hash-checked), then
`wifi-up <ssid> <password>` on the tablet (`wifi-up off` to stop). `iw` and `wpa_supplicant` from apk.

By hand, on the tablet (files in place: `/etc/firmware/{WMT_SOC.cfg,ROMv2_lm_patch_1_*_hdr.bin,WIFI_RAM_CODE_6735}`,
`WIFI_RAM_CODE -> WIFI_RAM_CODE_6735`, `/etc/firmware/nvram/{WIFI,WIFI_CUSTOM}`):
```
wmt_loader                                   # chip id 0x335, registers /dev/stpwmt and /dev/wmtWifi
setsid stp_uart_launcher -p /etc/firmware </dev/null >/tmp/launcher.log 2>&1 &   # powers CONSYS, ROM patches
echo 1 > /dev/wmtWifi                        # WIFI_RAM_CODE download, netdev mt6625_0 (MAC from nvram/WIFI)
ip link set mt6625_0 up; iw dev mt6625_0 scan
wpa_passphrase <ssid> <psk> > /tmp/wpa.conf  # Alpine's wpa_supplicant has no -f: redirect its output
setsid wpa_supplicant -t -i mt6625_0 -c /tmp/wpa.conf -D nl80211 </dev/null >/tmp/wpa.log 2>&1 &
udhcpc -i mt6625_0 -n -q
```
Result 2026-11-17: associated on 2.4 GHz ch 9 at -64 dBm (65 Mbit/s TX rate), WPA2 CCMP, DHCP lease, 0% loss to the
gateway (~3 ms) and to 1.1.1.1 (~27 ms), a 3.9 MB download in about a second with no DMA errors.
5 GHz (same day): the only 5 GHz AP in range was ch 108 (5540 MHz, DFS) at -93/-94 dBm. Pinned to it, 8 attempts
in a minute: 5 auth timeouts (status 16), 3 associations, one complete WPA2 4-way handshake (CCMP), then lost after
9 s (reason 100, beacon loss) and handshake timeouts (reason 15). So the 5 GHz path works (EAPOL both ways); the
link failed on signal. **Wrong conclusion, corrected:** the Mac next to the tablet sees that AP at -45 dBm (ch 108,
80 MHz, 960 Mbit/s), 48 dB more. The tablet's NVRAM says 5G Enable(0) Support(0) (efuse allows 5 GHz): Lenovo built
the TB-7304X as 2.4 GHz only, and stock Android follows the NVRAM. frank-w's tree forced 5 GHz on (BPI-R2
workaround); the BSP logic is restored in wlan_lib.c and logs `wlan: NVRAM 5G ... -> 5 GHz off`. Scans are 2.4 GHz
only now. `iw phy` still lists 5 GHz channels (the driver registers its band list unconditionally).

Problems found on the way (all fixed in the tree):
- **CONSYS EMI must be 2 MB aligned.** At 0x7ef00000 (1 MB aligned) the firmware wrote its trace 1 MB lower, into
  the kernel page tables (ASCII in PTEs, oops storm, panic). Now `consys-memory@7ee00000`, 2 MB; the driver
  refuses unaligned bases and replaces the remap field instead of ORing it. The dtsi's 0x7f800000 is under LK's
  framebuffer on this tablet, so it is deleted.
- **8250_of binds `mediatek,mtk-btif`** as a plain UART; the node uses the stock `mediatek,btif`. BTIF_init then
  oopsed on a NULL device (now fails with -ENODEV if probe did not run).
- **vmalloc buffers handed to dma_map_single()** (RX/TX coalescing buffers, firmware download): rejected since 5.x,
  oops on unmap. `ahb.c` bounces them through two 128 KiB coherent buffers.
- `netdev->dev_addr` written directly (const since 5.17): `eth_hw_addr_set()`.
- `build-in-docker.sh` ignored compile errors and packaged the previous Image (fixed: it stops now).
- A crash leaves zero-length files behind (ext4 delalloc): `sync` after copying firmware/tools.

Not done: RF clock buffer (CONSYS_CLOCK_BUF_CTRL; the clock is evidently running), EMI MPU, the fbdev
screen-state hint, GPS, FM. BT is built in (`CONFIG_BT`, `MTK_COMBO_BT`) and powers on (`hci0`), but scans return
nothing yet (STATUS.md).

## Plan sketch (out-of-tree, not upstreamable)
1. Take frank-w's 5.15-main `drivers/misc/mediatek/{btif,connectivity}` and forward-port to 7.0 (cfg80211,
   timer, procfs, kthread, DMA API drift since 5.15).
2. Replace the MT7623 CONSYS platform code with MT6735's from the downstream 3.18 BSP: CONN power domain
   (mainline genpd), clocks, CONSYS reset, EMI reserved memory (add a `reserved-memory` node at the address the
   stock DT/LK uses), BTIF base/IRQ, CONSYS IRQs.
3. Firmware from the tablet's Android `/system/etc/firmware` (WMT_SOC.cfg, ROM patch, WIFI RAM code) into the rootfs.
4. Userspace: wmt_loader / stp launcher equivalents (from frank-w's tree or the BSP), then `wlan_gen2` →
   `wlan0`, wpa_supplicant.

Effort: weeks; risk: high (CONSYS power-on and EMI layout are the unknowns). Value for the desk use case is moderate
— USB already provides power + network to the host. Order: read the stock DT's consys/btif/reserved-memory nodes and
the BSP platform layer first, then decide.

## Inputs collected (2026-11-17)
- **Android /system** copied to this Mac: `backup/system.tar` (3.3 GB, `tar -C /mnt/sys -cf - .` over tb.sh from
  `mmcblk0p20` mounted ro) and unpacked in `backup/system/`. Both gitignored.
- **Firmware** in `backup/system/vendor/firmware/` (`/system/etc/firmware` does not exist on this build):
  `WMT_SOC.cfg` (80 B: `coex_wmt_ant_mode=1`, `wmt_gps_lna_pin=0`, `wmt_gps_lna_enable=0`, `co_clock_flag=3`),
  `ROMv2_lm_patch_1_0_hdr.bin`, `ROMv2_lm_patch_1_1_hdr.bin`, `WIFI_RAM_CODE_6735`, `mt6627_fm_v1_{patch,coeff}.bin`.
- **NVRAM**: `nvdata` (`mmcblk0p18`) `APCFG/APRDEB/WIFI` (514 B, starts `04 01`, holds the MAC and TX power
  tables) and `WIFI_CUSTOM` (6 B), copied to `backup/nvdata/` (gitignored, unique to this device).
- **Stock userspace** (`backup/system/vendor/bin`, bionic aarch64, will not run on Alpine): `wmt_loader`
  (`/dev/wmtdetect`, chip id), `wmt_launcher` (`/dev/stpwmt`, `-p /vendor/firmware`, `WMT_SOC.cfg`),
  `wmt_concurrency`, `wmt_loopback`, `stp_dump3`, `autokd`. The stock kernel builds the driver in (no `.ko`).
  Plan: build the open-source loader/launcher equivalents (frank-w's BPI-R2 tools) against musl.
- **Sources** on taos under `/build/alex/wifi/` (sparse clones):
  - `frankw/` = frank-w BPI-Router-Linux `5.15-main`, `drivers/misc/mediatek/{btif,connectivity,include}`.
    Platform layer: `connectivity/common/conn_soc/mt7623/` (1772 lines); WLAN HIF `wlan/gen2/os/linux/hif/ahb/mt8127`.
  - `bsp2/` = `dhirajms/kernel_lenovo_P1m_3.18.y` (`p1mup`), MT6735 3.18 BSP: **`conn_soc/mt6735/`**
    (`mtk_wcn_consys_hw.c` 1233, `wmt_plat_alps.c` 1053, header 290 lines) and `wlan/gen2/.../hif/ahb/mt6735`.
    Same directory layout as frank-w's tree, so the MT6735 layer drops in next to `mt7623`. It takes clocks
    `conn`/`bus`, regulators `vcn18`/`vcn28`/`vcn33_bt`/`vcn33_wifi`, regs via `of_iomap` (CONSYS, AP RGU,
    topckgen, SPM, matching the stock DT order), EMI via `RESERVEDMEM_OF_DECLARE("mediatek,consys-reserve-memory")`
    and the topckgen EMI remap register; EMI MPU protection is optional (`CONSYS_EMI_MPU_SETTING`).
  - `bsp/` (maozi-114 3.18.79) has only the build-in adapter stubs; the driver lives out of tree there. Not useful.

## Next steps
> These three steps were completed on 2026-11-17; the result is in `mainline/wcn` and `patches/0011`. The list is
> kept as the original plan.

1. Diff `bsp2` vs `frankw` `conn_soc/` (35 differing files) and `btif/` to separate MT6735 platform code from
   the 3.18 to 5.15 API port.
2. Import frank-w's tree into `mainline/src/` as an out-of-tree module or patch set, add `conn_soc/mt6735` and
   `hif/ahb/mt6735`, port to 7.0.
3. DT: `consys`, `btif`, `wifi` nodes and a `reserved-memory` node; check the mainline mt6735 clock IDs for
   `conn`/`bus` and the CONN power domain.

## Sources
- OpenWrt forum, UFI6735 (MT6735 has no usable mainline support): https://forum.openwrt.org/t/ufi6735-mediatek-mt6735-4g-lte-wifi-usb-stick-router/141528
- TeamYogaBlade2 MT6628 issue (gen2 vendor paths): https://github.com/TeamYogaBlade2/linux/issues/35
- Banana Pi forum, BPI-R2 internal WiFi/BT (MT6625L): https://forum.banana-pi.org/t/bpi-r2-internal-wifi-bt-mt6625l-kernel/4307/337
- frank-w wiki, BPI-R2 WLAN setup: https://fw-web.de/dokuwiki/doku.php?id=en:bpi-r2:wlan
- frank-w kernel: https://github.com/frank-w/BPI-Router-Linux (branches 5.4-main … 5.15-main)
- postmarketOS MT6735 wiki: https://wiki.postmarketos.org/wiki/MediaTek_MT6737M
