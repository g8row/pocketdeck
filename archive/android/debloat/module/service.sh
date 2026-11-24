#!/system/bin/sh
# Runs late in boot. Removes any user-installed leftovers of stripped apps and trims UI cost.
MODDIR=${0%/*}
until [ "$(getprop sys.boot_completed)" = 1 ]; do sleep 2; done
# Leftover /data updates of stripped apps are deleted once by hand (pm uninstall of
# GmsCore crashes system_server on Android 7 because of its shared UID).
# Setup wizards are removed: mark the device as provisioned so nothing blocks Home/notifications.
settings put global device_provisioned 1
settings put secure user_setup_complete 1
# No animations: snappier UI, less GPU work.
settings put global window_animation_scale 0
settings put global transition_animation_scale 0
settings put global animator_duration_scale 0
# Desk-display defaults: stay awake on USB/AC power, hide system bars for the PocketJS shell.
settings put global stay_on_while_plugged_in 3
settings put global policy_control immersive.full=dev.pocketjs.shell
# Performance profile for a mains-powered desk display: keep all 4 cores online
# (MTK hotplug otherwise parks 2) and a floor of 858 MHz. Measured: worst frame
# 18-49 ms -> ~6 ms, mean 5 -> 2.4 ms.
echo 4 > /proc/hps/num_base_perf_serv
echo 858000 > /sys/devices/system/cpu/cpu0/cpufreq/scaling_min_freq
# Native services a desk display never needs (loggers, engineering mode, video/WiFi
# calling, GPS/AGPS, device-management agents, camera). Modem daemons stay up.
for s in emdlogger1 mobile_log_d emsvr_user vtservice epdg_wod netdiag agpsd mnld wifi2agps slpd DMAgent PPLAgent batterywarning cameraserver; do
  stop "$s"
done
# LTE off, Wi-Fi untouched: airplane mode that only switches the cellular radio.
settings put global airplane_mode_radios cell
settings put global mobile_data 0
if [ "$(settings get global airplane_mode_on)" != 1 ]; then
  settings put global airplane_mode_on 1
  am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true >/dev/null 2>&1
fi
svc wifi enable
