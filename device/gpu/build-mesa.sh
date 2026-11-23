#!/bin/sh
# Cross-build a minimal Mesa (Panfrost only, no LLVM: EGL + GLES2 + GBM) and kmscube for the TB-7304X's Alpine,
# from an x86_64 Docker host with no arm64 emulation. Zig is the aarch64-musl C/C++ compiler; Alpine's aarch64
# libdrm/expat/zlib packages, unpacked with apk --root, are the sysroot. Output: out/mesa-opt.tar.gz (-> /opt/mesa).
#   sh mainline/gpu/build-mesa.sh <zig-tarball> [out-dir]
# Mesa 24.3: later Panfrost needs mesa_clc (LLVM + SPIR-V) on the build host for its precompiled shaders.
# Executables must be PIE: zig links non-PIE executables without working copy relocations against musl's data
# (optind, environ), so getopt loops forever and getenv() crashes.
# No shader disk cache: it keys on the driver's ELF build-id, which the zig link does not emit (Panfrost crashed in
# panfrost_disk_cache_init -> _mesa_sha1_format on a NULL note).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ZIGTAR=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
OUT=$(mkdir -p "${2:-$HERE/out}" && cd "${2:-$HERE/out}" && pwd)
MESA=24.3.4
docker run --rm --platform linux/amd64 -v "$HERE:/gpu:ro" -v "$OUT:/out" -v "$ZIGTAR:/zig.tar.xz:ro" alpine:3.24 sh -euc "
  apk add --no-cache meson ninja python3 py3-mako py3-packaging py3-yaml bison flex pkgconf xz git wget alpine-keys binutils-aarch64 >/dev/null
  mkdir -p /opt && tar -C /opt -xJf /zig.tar.xz && ZIG=\$(ls -d /opt/zig-*/zig)
  # aarch64 sysroot from Alpine's own packages
  S=/sysroot; mkdir -p \$S/etc/apk; mkdir -p \$S/etc/apk/keys; cp /usr/share/apk/keys/aarch64/* \$S/etc/apk/keys/; cp /etc/apk/repositories \$S/etc/apk/
  apk --root \$S --arch aarch64 --initdb --no-scripts --no-cache add musl-dev libdrm-dev expat-dev zlib-dev zstd-dev >/dev/null
  # zig cc/c++ for aarch64 musl. Joins \"-Wl,--version-script\" \"<file>\" (how Mesa passes it) into one argument:
  # zig takes a bare .sym path for an input file.
  for t in cc c++; do cat > /usr/local/bin/za-\$t <<WRAP
#!/bin/sh
n=0; for a in \"\\\$@\"; do
  if [ \\\$n = 1 ]; then set -- \"\\\$@\" \"-Wl,--version-script=\\\$a\"; n=0
  elif [ \"\\\$a\" = -Wl,--version-script ]; then n=1
  else set -- \"\\\$@\" \"\\\$a\"; fi
  shift
done
exec \$ZIG \$t -target aarch64-linux-musl -isystem /sysroot/usr/include -L/sysroot/usr/lib \"\\\$@\"
WRAP
  chmod +x /usr/local/bin/za-\$t; done
  printf '#!/bin/sh\nexec %s ar \"\$@\"\n' \$ZIG > /usr/local/bin/za-ar; chmod +x /usr/local/bin/za-ar
  cat > /cross.ini <<INI
[binaries]
c = 'za-cc'
cpp = 'za-c++'
ar = 'za-ar'
strip = 'true'
nm = 'aarch64-alpine-linux-musl-nm'
pkg-config = 'pkg-config'
[properties]
sys_root = '/sysroot'
pkg_config_libdir = '/sysroot/usr/lib/pkgconfig:/sysroot/usr/share/pkgconfig'
[host_machine]
system = 'linux'
cpu_family = 'aarch64'
cpu = 'cortex-a53'
endian = 'little'
INI
  export PKG_CONFIG_SYSROOT_DIR=/sysroot PKG_CONFIG_LIBDIR=/sysroot/usr/lib/pkgconfig:/sysroot/usr/share/pkgconfig
  cd /tmp && wget -q https://archive.mesa3d.org/mesa-$MESA.tar.xz && tar xJf mesa-$MESA.tar.xz && cd mesa-$MESA
  meson setup b --cross-file /cross.ini --prefix=/opt/mesa --buildtype=release -Db_ndebug=true \
    -Dplatforms= -Dgallium-drivers=panfrost -Dvulkan-drivers= -Dllvm=disabled -Dglx=disabled -Degl=enabled \
    -Dgbm=enabled -Dgles1=disabled -Dgles2=enabled -Dopengl=true -Dshared-glapi=enabled -Dvalgrind=disabled \
    -Dlibunwind=disabled -Dzstd=enabled -Dxmlconfig=disabled -Dshader-cache=disabled -Dbuild-tests=false -Dtools= \
    -Dgallium-va=disabled -Dgallium-vdpau=disabled -Dgallium-xa=disabled -Dgallium-nine=false -Dgallium-opencl=disabled \
    -Dgallium-rusticl=false -Dvideo-codecs= > /out/mesa-meson.log 2>&1 || { tail -40 /out/mesa-meson.log; exit 1; }
  ninja -C b > /out/mesa-ninja.log 2>&1 || { grep -m5 -B2 -A8 'error' /out/mesa-ninja.log; exit 1; }
  DESTDIR=/stage ninja -C b install > /dev/null
  # kmscube: smallest real EGL/GBM/KMS test
  git clone -q https://gitlab.freedesktop.org/mesa/kmscube.git /tmp/kmscube && cd /tmp/kmscube
  PKG_CONFIG_PATH=/stage/opt/mesa/lib/pkgconfig PKG_CONFIG_SYSROOT_DIR= PKG_CONFIG_LIBDIR=/stage/opt/mesa/lib/pkgconfig:/sysroot/usr/lib/pkgconfig \
    meson setup b --cross-file /cross.ini --prefix=/opt/mesa --buildtype=release -Db_pie=true -Dgstreamer=disabled \
      -Dc_args=\"-I/stage/opt/mesa/include\" -Dc_link_args=\"-L/stage/opt/mesa/lib -Wl,-rpath,/opt/mesa/lib\" > /out/kmscube-meson.log 2>&1 || { tail -30 /out/kmscube-meson.log; exit 1; }
  ninja -C b kmscube > /out/kmscube-ninja.log 2>&1 || { tail -30 /out/kmscube-ninja.log; exit 1; }
  install -m755 b/kmscube /stage/opt/mesa/bin/kmscube 2>/dev/null || { mkdir -p /stage/opt/mesa/bin; install -m755 b/kmscube /stage/opt/mesa/bin/; }
  cd /stage/opt && tar czf /out/mesa-opt-debug.tar.gz mesa && rm -rf mesa/include mesa/lib/pkgconfig
  find mesa -type f \\( -name '*.so*' -o -path '*/bin/*' \\) -exec aarch64-alpine-linux-musl-strip --strip-unneeded {} +
  find mesa -type f | head -40 && du -sh mesa && tar czf /out/mesa-opt.tar.gz mesa
"
ls -la "$OUT"
