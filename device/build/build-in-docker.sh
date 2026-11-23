#!/bin/bash
# Runs inside the tb7304-build container (debian trixie arm64, native gcc).
#   /m      = lenovo-tab/mainline (bind mount)
#   /kout   = kernel build dir (docker volume tb7304-kbuild)
#   /stock  = lenovo-tab/backup/partitions (read-only)
set -euo pipefail
M=/m; K=$M/src/linux; O=/kout; OUT=$M/out; mkdir -p $OUT /build
JOBS=$(nproc)
# Native on an arm64 host (Mac), cross on x86_64 (taos): CROSS/BUSYBOX come from the Dockerfile.
if [ "$(uname -m)" != aarch64 ]; then export CROSS_COMPILE=aarch64-linux-gnu-; fi
CC=${CROSS_COMPILE:-}gcc; STRIP=${CROSS_COMPILE:-}strip; BUSYBOX=${BUSYBOX:-${BUSYBOX_ARM64:-/bin/busybox}}; [ -x "$BUSYBOX" ] || BUSYBOX=/bin/busybox
CMDLINE_BASE="bootopt=64S3,32N2,64N2"
MKB="mkbootimg --base 0x40000000 --kernel_offset 0x00080000 --ramdisk_offset 0x04000000 \
 --second_offset 0x00f00000 --tags_offset 0x0e000000 --pagesize 2048 --header_version 0 \
 --os_version 7.0.0 --os_patch_level 2018-07 --board 1535456354"


# Debian's mkbootimg writes second_addr=0 when there is no second stage; stock has 0x40f00000. Match stock.
fixhdr() { python3 -c "
import sys,struct
f=open(sys.argv[1],'r+b'); f.seek(28); f.write(struct.pack('<I',0x40f00000)); f.close()" "$1"; }

echo "== 0. sanity: rebuild stock boot.img from its parts with our mkbootimg parameters"
python3 - <<'PY'
import struct
b=open('/stock/boot.bin','rb').read(); ps=2048
ks,rs=struct.unpack_from('<I',b,8)[0],struct.unpack_from('<I',b,16)[0]
pg=lambda n:(n+ps-1)//ps*ps
open('/build/stock-kernel','wb').write(b[ps:ps+ks])
open('/build/stock-ramdisk','wb').write(b[ps+pg(ks):ps+pg(ks)+rs])
PY
$MKB --kernel /build/stock-kernel --ramdisk /build/stock-ramdisk --cmdline "$CMDLINE_BASE" -o /build/stock-repack.img
fixhdr /build/stock-repack.img
n=$(stat -c%s /build/stock-repack.img)
if cmp -s /build/stock-repack.img <(head -c $n /stock/boot.bin); then echo "   stock repack: IDENTICAL to boot.bin (first $n bytes)"; else
  echo "   stock repack differs:"; cmp /build/stock-repack.img <(head -c $n /stock/boot.bin) | head -3 || true; fi

echo "== 1. initramfs"
R=/build/rootfs; rm -rf $R; mkdir -p $R/bin $R/www $R/dev
cp $BUSYBOX $R/bin/busybox
$CC -static -O2 -Wall -o $R/bin/lkpaint $M/initramfs/lkpaint.c
$STRIP $R/bin/lkpaint
# boot record tool (format shared with U-Boot: u-boot/tbstate.h). Also copied to out/ for Android (adb push).
$CC -static -O2 -Wall -Wextra -I $M/u-boot -o $R/bin/tbstate $M/initramfs/tbstate.c
$STRIP $R/bin/tbstate; cp $R/bin/tbstate $OUT/tbstate
# boot menu (plan-dualboot.md §5). Font: Terminus 16x32 from the kernel tree, converted here (GPL, not committed)
python3 - $M/src/linux/lib/fonts/font_ter16x32.c /build/font.h <<'PY'
import re, sys
t = open(sys.argv[1]).read(); i = t.index("FONTDATAMAX, 0 }, {"); j = t.index("} };", i)
b = re.findall(r"0x[0-9a-fA-F]{2}", t[i:j]); assert len(b) == 16384, len(b)
open(sys.argv[2], "w").write("static const unsigned char font_ter16x32[16384] = {" + ",".join(b) + "};\n")
PY
$CC -static -O2 -Wall -Wextra -I /build -o $R/bin/bootmenu $M/initramfs/bootmenu.c
$STRIP $R/bin/bootmenu
# static e2fsck for the ext4 roots (tbroot_a/b, tbdata): /opt/arm64 on x86_64 hosts, the native package on arm64
E2FSCK=$(ls /opt/arm64/sbin/e2fsck.static /opt/arm64/usr/sbin/e2fsck.static /sbin/e2fsck.static /usr/sbin/e2fsck.static 2>/dev/null | head -n1 || true)
[ -n "$E2FSCK" ] || { echo "no e2fsck.static: rebuild the tb7304-build image (scripts/Dockerfile)"; exit 1; }
file -L "$E2FSCK" | grep -q "ARM aarch64.*statically linked" || { echo "$E2FSCK is not a static aarch64 binary"; exit 1; }
cp "$E2FSCK" $R/bin/e2fsck; $STRIP $R/bin/e2fsck 2>/dev/null || true
cp $M/initramfs/init $R/init; chmod 755 $R/init
mknod -m 600 $R/dev/console c 5 1; mknod -m 666 $R/dev/null c 1 3
(cd $R && find . | sort | cpio -o -H newc --owner=0:0 2>/dev/null) > /build/initramfs.cpio
gzip -9 -n -c /build/initramfs.cpio > $OUT/initramfs.cpio.gz
ls -la $OUT/initramfs.cpio.gz

echo "== 2. kernel"
for p in $M/patches/0*.sh; do sh "$p" $K; done
for p in $M/patches/0*.patch; do   # idempotent: skip patches that are already applied
  patch -d $K -p1 -R -f -s --dry-run < "$p" >/dev/null 2>&1 && continue
  patch -d $K -p1 -N -s < "$p" && echo "   applied $(basename $p)"; done
cp $M/src/pmaports/device/*/linux-postmarketos-mediatek-mt6735/config-postmarketos-mediatek-mt6735.aarch64 $O/.config
cat $M/patches/config-tb7304x.fragment >> $O/.config
make -C $K O=$O ARCH=arm64 olddefconfig >/dev/null
for opt in TOUCHSCREEN_GOODIX KEYBOARD_MT6779 MODULES MTK_COMBO MTK_COMBO_WIFI MTK_BTIF DRM_MEDIATEK DRM_PANEL_NOVATEK_NT51021B MTK_MMSYS PHY_MTK_MIPI_DSI MTK_LK_FB DRM_SIMPLEDRM FB_DEVICE STRICT_DEVMEM INITRAMFS_SOURCE USB_MUSB_GADGET USB_CONFIGFS_ECM PSTORE_RAM; do
  grep -E "^(# )?CONFIG_${opt}[= ]" $O/.config || echo "   CONFIG_$opt missing"; done
# The full log goes to out/kernel-build.log. A failed build must stop here: before, the errors were only filtered
# out of the output and the previous Image was packaged as if nothing had happened.
if ! make -C $K O=$O ARCH=arm64 -j$JOBS KBUILD_BUILD_USER=tb7304 KBUILD_BUILD_HOST=mainline Image.gz \
	mediatek/mt6737m-lenovo-tb7304x.dtb > $OUT/kernel-build.log 2>&1; then
  grep -E "error|Error [0-9]" $OUT/kernel-build.log | head -40
  echo "== kernel build FAILED (out/kernel-build.log)"; exit 1
fi
grep -E "Kernel: |warning: " $OUT/kernel-build.log | grep -v "drivers/misc/mediatek/" | tail -20 || true
echo "   $(grep -c "drivers/misc/mediatek/.*warning: " $OUT/kernel-build.log || true) warnings in the vendor WiFi driver (drivers/misc/mediatek, see the log)"
cp $O/.config $OUT/kernel.config
cp $O/arch/arm64/boot/dts/mediatek/mt6737m-lenovo-tb7304x.dtb $OUT/
python3 - <<PY
import struct,gzip
img=gzip.open('$O/arch/arm64/boot/Image.gz').read()
tofs,isz=struct.unpack_from('<QQ',img,8)
print('   Image %d bytes, header text_offset=0x%x image_size=0x%x -> ends at 0x%x (ATF reserved starts 0x43000000)'%(len(img),tofs,isz,0x40080000+isz))
assert 0x40080000+isz < 0x43000000, 'kernel would overlap ATF reserved memory'
assert len(img) <= 0x1c00000, 'LK gunzip limit is 0x1c00000 (28 MiB) of decompressed Image (lk.bin @0x41e1f5c8)'
print('   LK gunzip limit 0x1c00000: %d bytes headroom'%(0x1c00000-len(img)))
PY

echo "== 2b. WiFi userspace (wcn-tools: wmt_loader, stp_uart_launcher; static)"
make -s -C $M/wcn-tools -B CC=${CROSS_COMPILE:-}gcc
${STRIP} -o $OUT/wmt_loader $M/wcn-tools/wmt_loader
${STRIP} -o $OUT/stp_uart_launcher $M/wcn-tools/stp_uart_launcher
rm -f $M/wcn-tools/wmt_loader $M/wcn-tools/stp_uart_launcher
ls -la $OUT/wmt_loader $OUT/stp_uart_launcher

echo "== 2c. stage-2 tools (peek, poke, swipe; bbdeb = the static busybox, for devmem)"
for t in peek poke swipe; do
  $CC -static -O2 -Wall -Wextra -o $OUT/$t $M/rootfs/tools/$t.c && $STRIP $OUT/$t
done
cp $BUSYBOX $OUT/bbdeb
ls -la $OUT/peek $OUT/poke $OUT/swipe $OUT/bbdeb $OUT/tbstate

echo "== 3. boot images"
cat $O/arch/arm64/boot/Image.gz $OUT/mt6737m-lenovo-tb7304x.dtb > /build/Image.gz-dtb
# LK keeps only ~99 chars of the image cmdline (the rest is cut off: "...regulator_ignore_unused maxc" on the first boot).
# All 4 cores come up at boot through enable-method "mediatek,mt6735-smp" (patches/smp_mt6735.c).
# Add maxcpus=1 here to fall back to a single core.
CL="$CMDLINE_BASE clk_ignore_unused pd_ignore_unused regulator_ignore_unused"
[ ${#CL} -le 99 ] || { echo "cmdline is ${#CL} chars, LK truncates after 99"; exit 1; }
$MKB --kernel /build/Image.gz-dtb --ramdisk $OUT/initramfs.cpio.gz --cmdline "$CL" -o $OUT/boot-mainline.img
# lkfb.ovl=0: same, but the shim does not touch display registers (only atag,videolfb)
$MKB --kernel /build/Image.gz-dtb --ramdisk $OUT/initramfs.cpio.gz --cmdline "$CL lkfb.ovl=0" -o $OUT/boot-mainline-noovl.img
# control: untouched stock 3.18 kernel+DTB, our initramfs
$MKB --kernel /build/stock-kernel --ramdisk $OUT/initramfs.cpio.gz --cmdline "$CMDLINE_BASE panic=10 tb.autoreboot=300" -o $OUT/boot-stock-kernel-initramfs.img
for i in $OUT/boot-*.img; do fixhdr $i; done
cd $OUT && sha256sum boot-*.img initramfs.cpio.gz mt6737m-lenovo-tb7304x.dtb > SHA256SUMS && ls -la boot-*.img && cat SHA256SUMS
