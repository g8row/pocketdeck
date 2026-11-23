#!/bin/sh
# Idempotently fix, in the kernel tree in $1, the MT6328 long-press reset bits in mtk-pmic-keys. The fork gives
# MT6328 the MT6323/MT6397 layout of TOP_RST_MISC (PWRKEY_RST bit 6, HOMEKEY_RST bit 5, RST_DU bits 9:8), so probe
# clears bits 9:8 and turns OFF the power-key long-press reset that the preloader enabled. MT6328 (vendor
# upmu_hw.h, MT6735 3.18) has the MT6331 layout: HOMEKEY_RST_EN bit 8, PWRKEY_RST_EN bit 9, PWRKEY_RST_TD bits 13:12.
set -e
F=$1/drivers/input/keyboard/mtk-pmic-keys.c
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
i = s.index('static const struct mtk_pmic_regs mt6328_regs = {')
j = s.index('};', i)
blk = s[i:j]
if 'MT6331_PWRKEY_RST' in blk:
    sys.exit(0)
new = (blk.replace('MTK_PMIC_PWRKEY_RST)', 'MTK_PMIC_MT6331_PWRKEY_RST)')
          .replace('MTK_PMIC_HOMEKEY_RST)', 'MTK_PMIC_MT6331_HOMEKEY_RST)')
          .replace('.rst_lprst_mask = MTK_PMIC_RST_DU_MASK,', '.rst_lprst_mask = MTK_PMIC_MT6331_RST_DU_MASK,'))
assert new.count('MT6331') == 3, new
open(p, 'w').write(s[:i] + new + s[j:])
print('   applied 0010 mt6328 pmic-keys reset bits')
PY
