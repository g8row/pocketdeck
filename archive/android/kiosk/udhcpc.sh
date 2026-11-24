#!/system/bin/sh
# busybox udhcpc hook for kiosk-mode Wi-Fi: apply the lease to wlan0.
case "$1" in
  deconfig) ip addr flush dev "$interface" ;;
  bound|renew)
    ip addr flush dev "$interface"
    ip addr add "$ip/${mask:-24}" dev "$interface"
    for r in $router; do
      ip route replace default via "$r" dev "$interface" table main
      # netd's policy rules outlive the framework; make sure main is consulted.
      ip rule del pref 100 2>/dev/null
      ip rule add pref 100 from all lookup main
      break
    done
    [ -n "$dns" ] && setprop net.dns1 "${dns%% *}"
    ;;
esac
