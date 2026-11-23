FROM debian:trixie
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential bc bison flex libssl-dev libelf-dev device-tree-compiler git python3 \
    mkbootimg busybox-static cpio xz-utils lz4 gzip kmod ca-certificates file u-boot-tools \
    android-sdk-libsparse-utils rsync && rm -rf /var/lib/apt/lists/*
# x86_64 hosts: cross toolchain + an arm64 busybox for the initramfs (unpacked, not installed)
RUN if [ "$(dpkg --print-architecture)" != arm64 ]; then \
      dpkg --add-architecture arm64 && apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu libc6-dev-arm64-cross && \
      cd /tmp && apt-get download busybox-static:arm64 e2fsck-static:arm64 && \
      for d in busybox-static_*_arm64.deb e2fsck-static_*_arm64.deb; do dpkg-deb -x $d /opt/arm64; done && \
      rm -rf /tmp/*.deb /var/lib/apt/lists/*; fi
# arm64 hosts: e2fsck-static natively (stage 1 checks the ext4 roots before mounting them)
RUN if [ "$(dpkg --print-architecture)" = arm64 ]; then apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends e2fsck-static && \
      rm -rf /var/lib/apt/lists/*; fi
ENV BUSYBOX_ARM64=/opt/arm64/usr/bin/busybox
