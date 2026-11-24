#!/bin/sh
# Idempotently make PLL_POSTDIV_SAFE PLLs (kernel tree in $1, on top of patches/0007) check that a pcw write took.
# On the MT6735 ARMPLL, poking CON1 from userspace showed writes being dropped now and then (the register keeps
# the old pcw; it looked timing-dependent, perhaps while the PLL relocks), so cpufreq could believe 1196 MHz while
# the CPU still ran at 1144. Re-write up to 5 times, 20 us apart, until the pcw field reads back; warn if not.
set -e
F=$1/drivers/clk/mediatek/clk-pll.c
grep -q mtk_pll_pcw_took "$F" && exit 0
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
a = '''	__mtk_pll_set_rate_regs(pll, pcw, postdiv);
}
'''
assert s.count(a) == 1, 'wrapper tail (0007 missing?)'
b = '''	__mtk_pll_set_rate_regs(pll, pcw, postdiv);
	if (pll->data->flags & PLL_POSTDIV_SAFE) {
		int i;

		for (i = 0; i < 5 && !mtk_pll_pcw_took(pll, pcw); i++) {
			udelay(20);
			__mtk_pll_set_rate_regs(pll, pcw, postdiv);
		}
		if (!mtk_pll_pcw_took(pll, pcw))
			pr_warn_ratelimited("%s: pcw %#x not taken (reads %#x)\\n", clk_hw_get_name(&pll->hw), pcw,
					    (readl(pll->pcw_addr) >> pll->data->pcw_shift) &
					    GENMASK(pll->data->pcwbits - 1, 0));
	}
}
'''
s = s.replace(a, b)
a = 'static void mtk_pll_set_rate_regs(struct mtk_clk_pll *pll, u32 pcw,\n\t\tint postdiv)\n{\n\tif (pll->data->flags & PLL_POSTDIV_SAFE) {'
assert s.count(a) == 1, 'wrapper head'
helper = '''static bool mtk_pll_pcw_took(struct mtk_clk_pll *pll, u32 pcw)
{
	return ((readl(pll->pcw_addr) >> pll->data->pcw_shift) &
		GENMASK(pll->data->pcwbits - 1, 0)) == pcw;
}

'''
s = s.replace(a, helper + a)
open(p, 'w').write(s)
PY
grep -q mtk_pll_pcw_took "$F"
echo "   applied 0008 pll pcw verify"
