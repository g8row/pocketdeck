#!/bin/sh
# Run a command on the tablet's mainline Alpine over the USB network (key auth, no host-key bookkeeping).
#   tools/tb.sh 'uname -a'      stdin is passed through: tb.sh 'cat > /tmp/x' < file
#   tools/tb.sh                 interactive shell
# Commands get /usr/local/sbin in PATH (tb-reboot, tbstate, wifi-up, ...): dropbear runs them with a bare PATH.
set -- ${1+"PATH=/usr/local/sbin:/usr/local/bin:\$PATH; $*"}
exec ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes \
	-o ConnectTimeout=5 "${TAB:-root@172.16.42.1}" "$@"
