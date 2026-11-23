#!/bin/sh
# Idempotently give the MT6735 apmixedsys PLLs an fmax, in the kernel tree in $1. Without one, .fmax is 0 and
# mtk_pll_calc_values() clamps every requested rate to 0 Hz: the first cpufreq change wrote ARMPLL_CON1 =
# 0x84000000 (pcw 0, postdiv /16) and the CPU fell to a fraction of its clock while cpufreq reported 988 MHz.
# 2000 MHz like MT8590; it clamps the output rate (our highest OPP is 988 MHz, VCO 1976 MHz at /2).
set -e
F=$1/drivers/clk/mediatek/clk-mt6735-apmixedsys.c
grep -q MT6735_PLL_FMAX "$F" && exit 0
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
a = '#define CON0_RST_BAR\t\tBIT(24)\n'
b = '\t\t.parent_name = "clk26m",\t\t\t\t\\\n'
assert a in s and s.count(b) == 1
s = s.replace(a, a + '#define MT6735_PLL_FMAX\t\t(2000UL * MHZ)\n')
s = s.replace(b, b + '\t\t.fmax = MT6735_PLL_FMAX,\t\t\t\t\\\n')
open(p, 'w').write(s)
PY
grep -q '\.fmax = MT6735_PLL_FMAX' "$F"
echo "   applied 0006 mt6735 pll fmax"
