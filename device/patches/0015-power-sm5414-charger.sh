#!/bin/sh
# Idempotently add drivers/power/supply/sm5414_charger.c (Silicon Mitus SM5414 charger + the battery it charges,
# CONFIG_CHARGER_SM5414) to the kernel tree in $1. docs/mainline/research-power.md §1.
set -e
K=$1; M=$(dirname "$0")/..
cp "$M/patches/sm5414_charger.c" "$K/drivers/power/supply/sm5414_charger.c"
grep -q CHARGER_SM5414 "$K/drivers/power/supply/Makefile" || \
	echo 'obj-$(CONFIG_CHARGER_SM5414) += sm5414_charger.o' >> "$K/drivers/power/supply/Makefile"
if ! grep -q 'config CHARGER_SM5414' "$K/drivers/power/supply/Kconfig"; then
	sed -i 's/^config CHARGER_SMB347$/config CHARGER_SM5414\n\ttristate "Silicon Mitus SM5414 charger"\n\tdepends on I2C \&\& IIO \&\& THERMAL\n\tselect REGMAP_I2C\n\thelp\n\t  SM5414 switching charger (Lenovo TB-7304X) and its battery.\n\nconfig CHARGER_SMB347/' "$K/drivers/power/supply/Kconfig"
fi
grep -q 'config CHARGER_SM5414' "$K/drivers/power/supply/Kconfig"
