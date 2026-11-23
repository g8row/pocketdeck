#!/bin/bash
# Build U-Boot for the TB-7304X and package it as an LK-bootable Android boot image for `recovery`.
# Runs inside the tb7304-build container:
#   docker run --rm -v "$M":/m -v tb7304-ubuild:/uout tb7304-build bash /m/u-boot/build-uboot.sh
# Source: /m/src/u-boot (mt6735-mainline u-boot, pinned below). Output: /m/out/u-boot-tb7304x.img
set -euo pipefail
M=/m; U=$M/src/u-boot; O=/uout; OUT=$M/out
PIN=3d74bf168618b78567c31b3f4ec96430f3b565c8
[ "$(uname -m)" = aarch64 ] || export CROSS_COMPILE=aarch64-linux-gnu-

git config --global --add safe.directory $U
[ "$(git -C $U rev-parse HEAD)" = $PIN ] || { echo "u-boot is not at $PIN"; exit 1; }
cp $M/u-boot/tb7304x_defconfig $U/configs/
# tb patches to the pinned tree, applied once (a reverse check means already applied)
for p in $M/u-boot/0*.patch; do
	git -C $U apply -R --check "$p" 2>/dev/null || git -C $U apply "$p"
done
cp $M/u-boot/mt6737m-lenovo-tb7304x.dts $U/arch/arm/dts/
cp $M/u-boot/tb7304x_debug.c $U/board/mediatek/mt6735/
cp $M/u-boot/tb7304x_entry.S $U/board/mediatek/mt6735/
cp $M/u-boot/tb7304x_android.c $U/board/mediatek/mt6735/
cp $M/u-boot/tb7304x_tbstate.c $M/u-boot/tbstate.h $U/board/mediatek/mt6735/
grep -q tb7304x_entry $U/board/mediatek/mt6735/Makefile || echo 'obj-y += tb7304x_entry.o' >> $U/board/mediatek/mt6735/Makefile
grep -q tb7304x_debug $U/board/mediatek/mt6735/Makefile || echo 'obj-y += tb7304x_debug.o' >> $U/board/mediatek/mt6735/Makefile
grep -q tb7304x_android $U/board/mediatek/mt6735/Makefile || echo 'obj-y += tb7304x_android.o' >> $U/board/mediatek/mt6735/Makefile
grep -q tb7304x_tbstate $U/board/mediatek/mt6735/Makefile || echo 'obj-y += tb7304x_tbstate.o' >> $U/board/mediatek/mt6735/Makefile
grep -q mt6737m-lenovo-tb7304x.dtb $U/arch/arm/dts/Makefile ||
	sed -i 's/\tmt6737t-samsung-grandpplte.dtb \\/\tmt6737t-samsung-grandpplte.dtb \\\n\tmt6737m-lenovo-tb7304x.dtb \\/' $U/arch/arm/dts/Makefile
grep -q mt6737m-lenovo-tb7304x.dtb $U/arch/arm/dts/Makefile

make -C $U O=$O tb7304x_defconfig >/dev/null
# every "tb:" choice must survive Kconfig (a silently dropped symbol would change behaviour)
for s in CMD_CACHE=y BOOTDELAY=-2 VIDEO_SIMPLE=y BOARD_EARLY_INIT_F=y BOARD_EARLY_INIT_R=y MISC_INIT_R=y LAST_STAGE_INIT=y TEXT_BASE=0x40080000 SYS_MEM_TOP_HIDE=0x01000000 FASTBOOT_BUF_ADDR=0x50000000 WDT_MTK=y \
         WATCHDOG_AUTOSTART=y ANDROID_BOOT_IMAGE=y CMD_BOOTI=y SYS_WHITE_ON_BLACK=y HUSH_PARSER=y MMC_MTK=y; do
	grep -q "^CONFIG_$s\$" $O/.config || { echo "CONFIG_$s missing from .config"; exit 1; }; done
for s in VIDEO_LOGO FASTBOOT_FLASH CMD_GPT EXT4_WRITE FAT_WRITE USB_FUNCTION_MASS_STORAGE CMD_USB_MASS_STORAGE; do
	grep -q "^CONFIG_$s=y" $O/.config && { echo "CONFIG_$s must be off"; exit 1; }; done
make -C $U O=$O -j$(nproc) > $O/build.log 2>&1 || { grep -v "pattern recipe" $O/build.log | tail -30; exit 1; }
grep -E "warning:" $O/build.log | grep -v -e "pattern recipe" -e "^/m/src/u-boot/tools/" || true
[ -f $O/u-boot.bin ] || { echo "no u-boot.bin"; exit 1; }

# u-boot.bin already carries its own control DT (OF_SEPARATE). LK scans the stored (gzipped) blob backwards for a
# DTB magic, patches that DTB (memory map, /chosen atags, bootargs with androidboot.*) and passes it in x0. Append
# the STOCK Android DTB: U-Boot keeps LK's patched copy and hands it to the Android kernel (tb7304x_android.c).
DTB=$M/stock/stock.dtb
[ "$(head -c4 $DTB | od -An -tx1 | tr -d ' ')" = d00dfeed ] || { echo "$DTB is not a DTB"; exit 1; }
gzip -9 -n -c $O/u-boot.bin > /tmp/u-boot.bin.gz
# LK's bldr_load_dtb reads the DTB it hands over from the LAST 512 KiB of the kernel area in the partition; a
# smaller kernel area underflows that read and LK boots with a stale DTB left in RAM (docs/mainline/
# research-lk-bootflow.md §1). Zero-pad between the gzip stream and the DTB (LK's inflate stops at the stream end).
python3 - /tmp/u-boot.bin.gz $DTB <<'PY'
import os, sys
gz, dtb = sys.argv[1], os.path.getsize(sys.argv[2])
n = os.path.getsize(gz); pad = max(0, 0x80000 - n - dtb); pad += -(n + pad) % 4
open(gz, 'ab').write(b'\0' * pad); print('kernel area: gzip %#x + pad %#x + dtb %#x' % (n, pad, dtb))
PY
cat /tmp/u-boot.bin.gz $DTB > /tmp/u-boot.bin.gz-dtb
# ramdisk = the boot script (boot.cmd), loaded by LK to 0x44000000 and sourced by CONFIG_BOOTCOMMAND
RD=/tmp/empty; : > $RD
[ -f $M/u-boot/boot.cmd ] && { mkimage -A arm64 -T script -C none -n tb_boot -d $M/u-boot/boot.cmd /tmp/boot.scr >/dev/null; RD=/tmp/boot.scr; }
mkbootimg --base 0x40000000 --kernel_offset 0x00080000 --ramdisk_offset 0x04000000 \
	--second_offset 0x00f00000 --tags_offset 0x0e000000 --pagesize 2048 --header_version 0 \
	--os_version 7.0.0 --os_patch_level 2018-07 --board 1535456354 \
	--kernel /tmp/u-boot.bin.gz-dtb --ramdisk $RD --cmdline "bootopt=64S3,32N2,64N2" \
	-o $OUT/u-boot-tb7304x.img
# Debian's mkbootimg writes second_addr=0; stock has 0x40f00000 (same fix as build-in-docker.sh)
python3 -c "
import struct,sys
f=open(sys.argv[1],'r+b'); f.seek(28); f.write(struct.pack('<I',0x40f00000)); f.close()" $OUT/u-boot-tb7304x.img
# gate: the image must fit `boot` (16 MiB). Up to 2026-11-17 the boot record lived in its last MiB, so stay below
# 15 MiB as well: an older Linux/Android tbstate tool would still write there.
[ $(stat -c %s $OUT/u-boot-tb7304x.img) -lt $((30720 * 512)) ] || { echo "image reaches the old tbstate area"; exit 1; }
# gate: the offline model of LK's checks must pass, or the image is not written out
python3 -I $M/scripts/analysis/lk_image_check.py $OUT/u-boot-tb7304x.img || { mv $OUT/u-boot-tb7304x.img $OUT/u-boot-tb7304x.img.REJECTED; exit 1; }
ls -la $O/u-boot.bin $OUT/u-boot-tb7304x.img
(cd $OUT && sha256sum u-boot-tb7304x.img)

# Linux boot image for `fastboot boot` through U-Boot. U-Boot's bootm takes the DTB from the Android image's
# "second" area (it ignores a DTB appended to the gzip kernel, which is how LK finds it), and passes the image
# cmdline as-is (LK prepends console=tty0 and truncates at 99 chars; neither applies here).
# Through U-Boot, Linux gets memory 0x40000000-0x7f000000 (CONFIG_SYS_MEM_TOP_HIDE keeps LK's framebuffers out).
if [ -f $OUT/boot-mainline.img ]; then
	python3 - $OUT/boot-mainline.img /tmp/ub <<'PY'
import struct, sys, zlib, os
d = open(sys.argv[1], 'rb').read(); o = sys.argv[2]; os.makedirs(o, exist_ok=True)
ks, ka, rs, ra, ss, sa, ta, ps = struct.unpack('<8I', d[8:40])
k = d[ps:ps + ks]; r0 = ps + (ks + ps - 1) // ps * ps; r = d[r0:r0 + rs]
z = zlib.decompressobj(16 + zlib.MAX_WBITS); z.decompress(k); dtb = z.unused_data
assert dtb[:4] == b'\xd0\x0d\xfe\xed', 'no DTB appended to the kernel'
open(o + '/kernel', 'wb').write(k); open(o + '/ramdisk', 'wb').write(r)
open(o + '/dtb', 'wb').write(dtb[:struct.unpack('>I', dtb[4:8])[0]])
print('boot-mainline.img: kernel %d, ramdisk %d, dtb %d' % (ks, rs, os.path.getsize(o + '/dtb')))
PY
	# kernel at 0x40200000: 2 MiB aligned (text_offset 0), unlike LK's 0x40080000 ("Kernel image misaligned")
	mkbootimg --base 0x40000000 --kernel_offset 0x00200000 --ramdisk_offset 0x04000000 \
		--second_offset 0x00f00000 --tags_offset 0x0e000000 --pagesize 2048 --header_version 0 \
		--kernel /tmp/ub/kernel --ramdisk /tmp/ub/ramdisk --second /tmp/ub/dtb \
		--cmdline "console=tty0 clk_ignore_unused pd_ignore_unused regulator_ignore_unused" \
		-o $OUT/boot-mainline-uboot.img
	ls -la $OUT/boot-mainline-uboot.img
fi
