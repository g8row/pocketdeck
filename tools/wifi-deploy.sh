#!/bin/sh
# Install the WiFi firmware, this tablet's NVRAM, wmt_loader/stp_uart_launcher and wifi-up on the running mainline
# Alpine (docs/mainline/research-wifi.md). macOS or Linux host.
#   mainline/scripts/wifi-deploy.sh            then on the tablet: wifi-up [<ssid> <password>]
# Sources (gitignored, never committed):
#   FW=backup/system/vendor/firmware    from Android /system (research-wifi.md, "Inputs collected")
#   NV=backup/nvdata/APCFG/APRDEB       WIFI, WIFI_CUSTOM, BT_Addr from nvdata: MAC, TX power, BD address (this tablet)
#   mainline/out/{wmt_loader,stp_uart_launcher}   from mainline/scripts/build.sh
# iw and wpa_supplicant come from Alpine: scripts/tablet-net.sh, then `apk add iw wpa_supplicant` on the tablet.
set -eu
R=$(cd "$(dirname "$0")/../.." && pwd)
FW=${FW:-$R/backup/system/vendor/firmware}
NV=${NV:-$R/backup/nvdata/APCFG/APRDEB}
OUT=$R/mainline/out
TB=$R/mainline/scripts/tb.sh
export COPYFILE_DISABLE=1	# macOS tar: no AppleDouble ._* files
FWFILES="WMT_SOC.cfg ROMv2_lm_patch_1_0_hdr.bin ROMv2_lm_patch_1_1_hdr.bin WIFI_RAM_CODE_6735"
for f in $FWFILES; do [ -f "$FW/$f" ] || { echo "missing $FW/$f"; exit 1; }; done
for f in WIFI WIFI_CUSTOM BT_Addr; do [ -f "$NV/$f" ] || { echo "missing $NV/$f"; exit 1; }; done
for f in wmt_loader stp_uart_launcher; do [ -x "$OUT/$f" ] || { echo "missing $OUT/$f (run scripts/build.sh)"; exit 1; }; done

sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
# shellcheck disable=SC2086
(cd "$FW" && tar -cf - $FWFILES) | "$TB" 'mkdir -p /etc/firmware/nvram && tar -C /etc/firmware -xf - --no-same-owner &&
	ln -sf WIFI_RAM_CODE_6735 /etc/firmware/WIFI_RAM_CODE'
(cd "$NV" && tar -cf - WIFI WIFI_CUSTOM BT_Addr) | "$TB" 'tar -C /etc/firmware/nvram -xf - --no-same-owner && chmod 600 /etc/firmware/nvram/*'
(cd "$OUT" && tar -cf - wmt_loader stp_uart_launcher) | "$TB" 'tar -C /usr/local/sbin -xf - --no-same-owner'
(cd "$R/mainline/rootfs/overlay/usr/local/sbin" && tar -cf - wifi-up) | "$TB" 'tar -C /usr/local/sbin -xf - --no-same-owner'
# a crash before writeback leaves empty files behind (ext4 delalloc): sync, then compare hashes
"$TB" 'sync'
# shellcheck disable=SC2086
want=$( (cd "$FW" && sha $FWFILES; cd "$NV" && sha WIFI WIFI_CUSTOM BT_Addr; cd "$OUT" && sha wmt_loader stp_uart_launcher) | awk '{print $1}')
have=$("$TB" "cd /etc/firmware && sha256sum $FWFILES && cd nvram && sha256sum WIFI WIFI_CUSTOM BT_Addr &&
	cd /usr/local/sbin && sha256sum wmt_loader stp_uart_launcher" | awk '{print $1}')
[ "$want" = "$have" ] || { echo "hash mismatch on the tablet"; exit 1; }
"$TB" 'command -v iw wpa_supplicant >/dev/null' || echo "note: iw/wpa_supplicant missing (scripts/tablet-net.sh, then apk add iw wpa_supplicant)"
echo "WiFi files installed and verified. On the tablet: wifi-up [<ssid> <password>]"
