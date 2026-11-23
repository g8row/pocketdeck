#!/bin/sh
# Idempotently add drivers/soc/mediatek/mtk-lk-fb.c + the TB-7304X DTS to the kernel tree in $1.
set -e
K=$1; M=$(dirname "$0")/..
cp "$M/patches/mtk-lk-fb.c" "$K/drivers/soc/mediatek/mtk-lk-fb.c"
grep -q MTK_LK_FB "$K/drivers/soc/mediatek/Makefile" || \
	echo 'obj-$(CONFIG_MTK_LK_FB) += mtk-lk-fb.o' >> "$K/drivers/soc/mediatek/Makefile"
if ! grep -q MTK_LK_FB "$K/drivers/soc/mediatek/Kconfig"; then
	sed -i 's/^endmenu$/config MTK_LK_FB\n\tbool "simple-framebuffer for the display left on by MediaTek LK"\n\tdepends on OF \&\& (ARCH_MEDIATEK || COMPILE_TEST)\n\thelp\n\t  Reads \/chosen atag,videolfb and the OVL0 registers and registers a\n\t  simple-framebuffer device for simpledrm. Bring-up aid only.\n\nendmenu/' "$K/drivers/soc/mediatek/Kconfig"
fi
cp "$M/dts/mt6737m-lenovo-tb7304x.dts" "$K/arch/arm64/boot/dts/mediatek/"
grep -q tb7304x "$K/arch/arm64/boot/dts/mediatek/Makefile" || \
	sed -i '/mt6735p-doogee-x5pro.dtb/a dtb-$(CONFIG_ARCH_MEDIATEK) += mt6737m-lenovo-tb7304x.dtb' "$K/arch/arm64/boot/dts/mediatek/Makefile"
# RTC boot-mode flags for LK (`next_boot` = bootloader / recovery / normal), see mtk-rtc-boot-mode.c
cp "$M/patches/mtk-rtc-boot-mode.c" "$K/drivers/soc/mediatek/mtk-rtc-boot-mode.c"
grep -q mtk-rtc-boot-mode "$K/drivers/soc/mediatek/Makefile" || \
	echo 'obj-$(CONFIG_ARCH_MEDIATEK) += mtk-rtc-boot-mode.o' >> "$K/drivers/soc/mediatek/Makefile"
