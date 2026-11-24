#!/bin/sh
# Idempotently add arch/arm64/kernel/smp_mt6735.c (enable-method "mediatek,mt6735-smp") to the kernel tree in $1.
set -e
K=$1; M=$(dirname "$0")/..
cp "$M/patches/smp_mt6735.c" "$K/arch/arm64/kernel/smp_mt6735.c"
grep -q smp_mt6735 "$K/arch/arm64/kernel/Makefile" || \
	echo 'obj-$(CONFIG_ARCH_MEDIATEK) += smp_mt6735.o' >> "$K/arch/arm64/kernel/Makefile"
C=$K/arch/arm64/kernel/cpu_ops.c
if ! grep -q mt6735_smp_ops "$C"; then
	sed -i 's/^extern const struct cpu_operations cpu_psci_ops;$/&\n#ifdef CONFIG_ARCH_MEDIATEK\nextern const struct cpu_operations mt6735_smp_ops;\n#endif/' "$C"
	# first occurrence only: the DT table
	sed -i '0,/^\t&cpu_psci_ops,$/s//\t\&cpu_psci_ops,\n#ifdef CONFIG_ARCH_MEDIATEK\n\t\&mt6735_smp_ops,\n#endif/' "$C"
fi
grep -q mt6735_smp_ops "$C"
