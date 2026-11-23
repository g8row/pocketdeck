#!/bin/sh
# Build the TB-7304X stage-2 root filesystem: Alpine aarch64 as an ext4 image (docs/mainline/research-rootfs.md).
# Runs on any x86_64 or arm64 Docker host, no qemu: apk installs the aarch64 packages with --no-scripts and this
# script does what their install scripts would have done.
#
#   sh mainline/rootfs/build-rootfs.sh <ssh-public-key> [out-dir]     -> out-dir/rootfs.img (+ .sha256)
#
# Contents: Alpine + PKGS, the overlay, the tools from mainline/out (scripts/build.sh: tbstate, peek, poke, swipe,
# bbdeb/devmem, wmt_loader, stp_uart_launcher) and, when present, Mesa (MESA=, default gpu/out/mesa-opt.tar.gz).
# Not in the image: the WiFi firmware/NVRAM (proprietary, per device: scripts/wifi-deploy.sh), PocketJS
# (scripts/pocketjs-deploy.sh), saved WiFi networks (/data/wifi). Install: scripts/rootfs-install.sh.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
KEY=${1:?usage: build-rootfs.sh <ssh-public-key> [out-dir]}
OUT=$(mkdir -p "${2:-$HERE/out}" && cd "${2:-$HERE/out}" && pwd)
BIN=$(cd "$HERE/../out" && pwd)
MESA=${MESA:-$HERE/../gpu/out/mesa-opt.tar.gz}
ALPINE=3.24 V=3.24.4 SIZE=${SIZE:-512M}
# curl gdb: debugging; libdrm expat zstd-libs zlib: Mesa (/opt/mesa) and the PocketJS kiosk; iw wpa_supplicant: WiFi
PKGS="alpine-base busybox-extras dropbear dropbear-scp e2fsprogs e2fsprogs-extra nano htop evtest i2c-tools curl gdb musl-utils"
PKGS="$PKGS libdrm expat zstd-libs zlib iw wpa_supplicant"
TOOLS="tbstate peek poke swipe wmt_loader stp_uart_launcher bbdeb"
for t in $TOOLS; do [ -x "$BIN/$t" ] || { echo "missing $BIN/$t (run mainline/scripts/build.sh)"; exit 1; }; done
mkdir -p "$OUT/tools" && for t in $TOOLS; do cp "$BIN/$t" "$OUT/tools/"; done
if [ -f "$MESA" ]; then cp "$MESA" "$OUT/mesa-opt.tar.gz"; else echo "note: no $MESA, image without /opt/mesa"; rm -f "$OUT/mesa-opt.tar.gz"; fi
cp "$KEY" "$OUT/authorized_keys"

docker run --rm -v "$HERE/overlay:/overlay:ro" -v "$OUT:/out" alpine:$ALPINE sh -euc "
  apk add --no-cache e2fsprogs >/dev/null
  cd /tmp; R=/tmp/r; mkdir -p \$R
  F=alpine-minirootfs-$V-aarch64.tar.gz; U=https://dl-cdn.alpinelinux.org/alpine/v$ALPINE/releases/aarch64
  wget -q \$U/\$F \$U/\$F.sha256
  sha256sum -c \$F.sha256
  tar xzf \$F -C \$R
  cp -a /overlay/. \$R/ && chown -R 0:0 \$R/etc \$R/usr/local
  apk --root \$R --arch aarch64 --no-scripts --no-cache add $PKGS
  for p in $PKGS; do apk --root \$R info -e \$p >/dev/null || { echo \"package \$p not installed\"; exit 1; }; done
  for t in $TOOLS; do install -m 755 /out/tools/\$t \$R/usr/local/sbin/; done
  mkdir -p \$R/usr/local/bin && mv \$R/usr/local/sbin/bbdeb \$R/usr/local/bin/ && ln -sf bbdeb \$R/usr/local/bin/devmem
  [ -f /out/mesa-opt.tar.gz ] && mkdir -p \$R/opt && tar -xzf /out/mesa-opt.tar.gz -C \$R/opt --no-same-owner
  [ -x \$R/etc/init.d/ntpd ] && [ -x \$R/etc/init.d/hwclock ] || { echo 'ntpd/hwclock init scripts missing'; exit 1; }
  # what the skipped install scripts and setup-alpine would do
  for a in telnetd telnet ftpd ftpget ftpput httpd inetd tftp tftpd udhcpd dnsd fakeidentd; do ln -sf /bin/busybox-extras \$R/usr/sbin/\$a; done
  for s in devfs dmesg mdev; do ln -sf /etc/init.d/\$s \$R/etc/runlevels/sysinit/; done
  # hwclock: the MT6328 RTC (patches/0012); the kernel also reads it at boot. ntpd (busybox, pool.ntp.org) corrects
  # it once WiFi is up and the kernel writes NTP time back (RTC_SYSTOHC); hwclock writes it at shutdown too.
  for s in hostname bootmisc sysctl syslog networking urandom hwclock; do ln -sf /etc/init.d/\$s \$R/etc/runlevels/boot/; done
  for s in dropbear local wifi ntpd pocketjs; do ln -sf /etc/init.d/\$s \$R/etc/runlevels/default/; done
  for s in killprocs savecache; do ln -sf /etc/init.d/\$s \$R/etc/runlevels/shutdown/; done
  mkdir -p \$R/root/.ssh \$R/mnt/cache; chmod 700 \$R/root/.ssh
  install -m 600 /out/authorized_keys \$R/root/.ssh/authorized_keys
  sed -i 's|^root:[^:]*:|root:*:|' \$R/etc/shadow          # no password logins; ssh key or USB telnet only
  echo 'DROPBEAR_OPTS=\"-s -p 172.16.42.1:22\"' > \$R/etc/conf.d/dropbear
  echo 'TB-7304X mainline (Alpine $V). Safety net: /etc/local.d/tb-autoreboot.start' > \$R/etc/motd
  rm -f /out/rootfs.img
  truncate -s $SIZE /out/rootfs.img
  mkfs.ext4 -q -L tbroot -d \$R /out/rootfs.img
  cd /out && sha256sum rootfs.img > rootfs.img.sha256 && cat rootfs.img.sha256
  du -sh \$R
"
rm -rf "$OUT/authorized_keys" "$OUT/tools" "$OUT/mesa-opt.tar.gz"
ls -la "$OUT"
