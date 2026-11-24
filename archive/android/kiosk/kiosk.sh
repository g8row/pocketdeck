#!/system/bin/sh
# PocketJS kiosk mode: stop the Android framework and run PocketJS directly on
# the framebuffer. Kernel, drivers, adbd, Wi-Fi association and the modem stay up.
#
#   su -c sh /data/local/tmp/kiosk/kiosk.sh start   # framework off, kiosk on
#   su -c sh /data/local/tmp/kiosk/kiosk.sh stop    # kiosk off, framework back
#   su -c sh /data/local/tmp/kiosk/kiosk.sh restart # new kiosk binary/bundle, Android stays off
#
# Pressing the power button inside kiosk mode also returns to Android.
DIR=/data/local/tmp/kiosk
BIN=$DIR/pocketjs-kiosk
LOG=$DIR/kiosk.log

perf() {
  # Same desk-display profile as the Magisk module (MTK perfservice resets it
  # whenever the framework restarts): 4 cores online, 858 MHz floor.
  echo 4 > /proc/hps/num_base_perf_serv
  echo 858000 > /sys/devices/system/cpu/cpu0/cpufreq/scaling_min_freq
}

WPA="wpa_cli -p /data/misc/wifi/sockets -i wlan0"
BB=/data/adb/magisk/busybox

wifi_up() {
  # The framework normally drives Wi-Fi; without it we do it natively:
  # chip power → supplicant (saved networks) → DHCP (busybox udhcpc).
  stop p2p_supplicant 2>/dev/null; stop wpa_supplicant 2>/dev/null
  pkill wpa_supplicant 2>/dev/null
  rm -f /data/misc/wifi/sockets/*
  echo 1 > /dev/wmtWifi; sleep 2
  ip link set wlan0 up
  # Narrow, live-only SELinux rule so the supplicant may answer root's wpa_cli
  # (gone on reboot; SELinux stays enforcing).
  /data/adb/magisk/magiskpolicy --live "allow wpa magisk unix_dgram_socket sendto"
  start wpa_supplicant; sleep 2
  $WPA enable_network all >/dev/null
  $WPA reassociate >/dev/null
  i=0
  while [ $i -lt 20 ]; do
    $WPA status | grep -q wpa_state=COMPLETED && break
    sleep 1; i=$((i + 1))
  done
  $BB udhcpc -i wlan0 -s "$DIR/udhcpc.sh" -b -t 10 -p "$DIR/udhcpc.pid" >>"$LOG.wifi" 2>&1
  echo "wifi: $($WPA status | grep wpa_state) $(ip -4 addr show wlan0 | grep -o 'inet [0-9.]*')" >>"$LOG.wifi"
}

wifi_down() {
  [ -f "$DIR/udhcpc.pid" ] && kill "$(cat "$DIR/udhcpc.pid")" 2>/dev/null
  rm -f "$DIR/udhcpc.pid"
  stop wpa_supplicant 2>/dev/null; pkill wpa_supplicant 2>/dev/null
  rm -f /data/misc/wifi/sockets/*
  ip rule del pref 100 2>/dev/null
  ip addr flush dev wlan0 2>/dev/null
}

android_up() {
  wifi_down
  start surfaceflinger
  start zygote
  start zygote_secondary 2>/dev/null
  # Hand Wi-Fi back to the framework (it starts with Wi-Fi off otherwise).
  ( while [ "$(getprop sys.boot_completed)" != 1 ] || ! pidof system_server >/dev/null; do sleep 2; done
    sleep 5; svc wifi enable ) &
}

run_kiosk() {
  perf
  (
    "$BIN" "$DIR/bundle" >"$LOG" 2>&1
    echo "kiosk exited ($?)" >>"$LOG"
    if [ -f "$DIR/.restarting" ]; then
      rm -f "$DIR/.restarting"
    else
      echo "restarting Android" >>"$LOG"
      android_up
    fi
  ) &
}

case "$1" in
  restart)
    touch "$DIR/.restarting"
    pkill -f pocketjs-kiosk 2>/dev/null
    sleep 1
    run_kiosk
    echo "kiosk restarted"
    ;;
  start)
    pkill -f pocketjs-kiosk 2>/dev/null
    stop zygote_secondary 2>/dev/null
    stop zygote
    stop surfaceflinger
    stop bootanim 2>/dev/null
    sleep 1
    : >"$LOG.wifi"
    wifi_up &
    run_kiosk
    echo "kiosk started (log: $LOG)"
    ;;
  stop)
    pkill -f pocketjs-kiosk 2>/dev/null   # the subshell above restarts Android
    sleep 1
    [ "$(getprop init.svc.zygote)" = running ] || android_up
    echo "kiosk stopped"
    ;;
  *) echo "usage: kiosk.sh start|stop"; exit 1 ;;
esac
