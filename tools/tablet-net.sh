#!/usr/bin/env bash
# Give the tablet's Alpine (stage 2) internet for apk/wget through the host, with no host network changes:
#  - starts http-proxy.py on 127.0.0.1:3128 (if not already running)
#  - sets the tablet's clock from the host (fallback; the RTC and ntpd normally handle it)
#  - holds `ssh -R 3128:127.0.0.1:3128` open; on the tablet /etc/profile.d/tb-proxy.sh points http(s)_proxy at it
#   mainline/scripts/tablet-net.sh          # runs until Ctrl-C
#   then on the tablet: apk update && apk add <pkg>
set -eu
cd "$(dirname "$0")"
TAB=root@172.16.42.1
SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=15"
if ! (exec 3<>/dev/tcp/127.0.0.1/3128) 2>/dev/null; then
	python3 -I http-proxy.py 3128 &
	PROXY=$!
	trap 'kill $PROXY 2>/dev/null' EXIT INT TERM
	sleep 1
fi
$SSH $TAB "date -s @$(date +%s) >/dev/null
	printf 'export http_proxy=http://127.0.0.1:3128 https_proxy=http://127.0.0.1:3128\n' > /etc/profile.d/tb-proxy.sh
	date"
echo "tunnel up; on the tablet: . /etc/profile.d/tb-proxy.sh; apk update   (Ctrl-C here to stop)"
$SSH -N -R 3128:127.0.0.1:3128 $TAB
