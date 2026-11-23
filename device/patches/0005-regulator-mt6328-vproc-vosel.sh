#!/bin/sh
# Idempotently fix, in the kernel tree in $1, the MT6328 VPROC voltage-select register: the table has
# MT6328_VPA_CON11 (0x666, the VPA buck's) where every other buck uses its own CON11. Measured on the TB-7304X with
# LK's 793 MHz setup: VPROC_CON11 (0x48a) = VPROC_CON12 (0x48c) = 0x58 = 1.15 V (stock OPP: 793 MHz @ 1.15 V),
# while the driver reported 0.6 V. Without this, cpufreq would program VPA instead of the CPU rail.
set -e
F=$1/drivers/regulator/mt6328-regulator.c
grep -q 'MT6328_VPROC_CON9, MT6328_VPROC_CON11, 0x7f' "$F" && exit 0
sed -i 's/MT6328_VPROC_CON9, MT6328_VPA_CON11, 0x7f,/MT6328_VPROC_CON9, MT6328_VPROC_CON11, 0x7f,/' "$F"
grep -q 'MT6328_VPROC_CON9, MT6328_VPROC_CON11, 0x7f' "$F"
echo "   applied 0005 mt6328 vproc vosel"
