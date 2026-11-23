# MediaTek CONSYS WiFi/BT (WMT/STP/BTIF + wlan_gen2) for the TB-7304X

Out-of-mainline vendor driver, copied into the kernel tree at `drivers/misc/mediatek/` by
`patches/0011-wcn-mediatek.sh`. See `docs/mainline/research-wifi.md`.

Origin (import commit, unmodified):
- `btif/`, `connectivity/`, `include/`, `Kconfig`, `Makefile`: frank-w BPI-Router-Linux branch `5.15-main`,
  commit `27f32fbbe2b88cb0ed2724e13631240067278fe6`, `drivers/misc/mediatek/` (MT7623 / BPI-R2 port of MediaTek's BSP).

Later commits add the MT6735 platform layer from the Lenovo P1m 3.18 BSP
(`dhirajms/kernel_lenovo_P1m_3.18.y`, branch `p1mup`) and port the whole tree to Linux 7.0.
