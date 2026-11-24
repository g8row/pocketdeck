#!/bin/sh
# Idempotently teach the MediaTek PLL driver (kernel tree in $1) to change a running PLL's post-divider without
# overshooting, and use it for the MT6735 ARMPLL (the CPU runs straight from it; there is no CPU clock mux here).
#
# mtk_pll_set_rate_regs() writes pcw and postdiv together. When the post-divider shrinks (output going up, e.g.
# 988 MHz = VCO 1976 / 2 -> 1092 MHz = VCO 1092 / 1) the output is VCO_old / postdiv_new = 1976 MHz until the VCO
# relocks. With PLL_POSTDIV_SAFE the change is split in two writes so the output never exceeds the target:
#   postdiv shrinks: new pcw at the old divider first (546 MHz), then the new divider (1092 MHz)
#   postdiv grows:   new divider at the old pcw first (546 MHz), then the new pcw (988 MHz)
set -e
K=$1
grep -q PLL_POSTDIV_SAFE "$K/drivers/clk/mediatek/clk-pll.h" && exit 0
python3 - "$K" <<'PY'
import sys
K = sys.argv[1]
h = K + '/drivers/clk/mediatek/clk-pll.h'
s = open(h).read()
a = '#define PLL_PARENT_EN\tBIT(2)\n'
assert a in s, 'PLL_PARENT_EN'
s = s.replace(a, a + '/* change pcw and postdiv in two steps so the output never overshoots (CPU PLLs) */\n#define PLL_POSTDIV_SAFE\tBIT(3)\n')
open(h, 'w').write(s)

c = K + '/drivers/clk/mediatek/clk-pll.c'
s = open(c).read()
a = 'static void mtk_pll_set_rate_regs(struct mtk_clk_pll *pll, u32 pcw,\n\t\tint postdiv)\n{'
assert s.count(a) == 1, 'set_rate_regs'
s = s.replace(a, 'static void __mtk_pll_set_rate_regs(struct mtk_clk_pll *pll, u32 pcw,\n\t\tint postdiv)\n{')
a = '/*\n * mtk_pll_calc_values'
assert s.count(a) == 1, 'calc_values comment'
wrapper = '''static void mtk_pll_set_rate_regs(struct mtk_clk_pll *pll, u32 pcw,
		int postdiv)
{
	if (pll->data->flags & PLL_POSTDIV_SAFE) {
		int cur_pd = 1 << ((readl(pll->pd_addr) >> pll->data->pd_shift) & POSTDIV_MASK);
		u32 cur_pcw = (readl(pll->pcw_addr) >> pll->data->pcw_shift) &
			      GENMASK(pll->data->pcwbits - 1, 0);

		if (postdiv < cur_pd)		/* output up: move the VCO first */
			__mtk_pll_set_rate_regs(pll, pcw, cur_pd);
		else if (postdiv > cur_pd)	/* output down: divide first */
			__mtk_pll_set_rate_regs(pll, cur_pcw, postdiv);
	}
	__mtk_pll_set_rate_regs(pll, pcw, postdiv);
}

'''
s = s.replace(a, wrapper + a)
open(c, 'w').write(s)

m = K + '/drivers/clk/mediatek/clk-mt6735-apmixedsys.c'
s = open(m).read()
a = 'ARMPLL_CON1, 21, PLL_AO),'
assert s.count(a) == 1, 'armpll entry'
s = s.replace(a, 'ARMPLL_CON1, 21, PLL_AO | PLL_POSTDIV_SAFE),')
open(m, 'w').write(s)
PY
echo "   applied 0007 safe postdiv (ARMPLL)"
