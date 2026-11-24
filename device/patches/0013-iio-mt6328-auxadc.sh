#!/bin/sh
# Idempotently add drivers/iio/adc/mt6328-auxadc.c (MT6328 PMIC AUXADC, CONFIG_MT6328_AUXADC) to the kernel tree in $1.
# The MFD cell that instantiates it is patches/0014.
set -e
K=$1; M=$(dirname "$0")/..
cp "$M/patches/mt6328-auxadc.c" "$K/drivers/iio/adc/mt6328-auxadc.c"
grep -q MT6328_AUXADC "$K/drivers/iio/adc/Makefile" || \
	echo 'obj-$(CONFIG_MT6328_AUXADC) += mt6328-auxadc.o' >> "$K/drivers/iio/adc/Makefile"
if ! grep -q 'config MT6328_AUXADC' "$K/drivers/iio/adc/Kconfig"; then
	sed -i 's/^config MEDIATEK_MT6359_AUXADC$/config MT6328_AUXADC\n\ttristate "MediaTek MT6328 PMIC AUXADC"\n\tdepends on MFD_MT6397\n\thelp\n\t  Battery, charger input and NTC voltages of the MT6328 PMIC (TB-7304X).\n\nconfig MEDIATEK_MT6359_AUXADC/' "$K/drivers/iio/adc/Kconfig"
fi
grep -q 'config MT6328_AUXADC' "$K/drivers/iio/adc/Kconfig"
