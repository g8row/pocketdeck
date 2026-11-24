#!/bin/sh
# Idempotently add, to the kernel tree in $1:
#  - the "D2" (MT6735M/MT6737M) display mutex table: an extra OVL1 slot shifts every module after OVL0 by one
#    bit (measured on the TB-7304X with LK's pipeline running: MUTEX0_MOD = 0x2F940), compatible
#    "mediatek,mt6735m-disp-mutex" (falls back to mt6735 in mediatek-drm's component table)
#  - the NT51021B (TB-7304X GX) DSI panel driver, CONFIG_DRM_PANEL_NOVATEK_NT51021B
set -e
K=$1; M=$(dirname "$0")/..

python3 - "$K/drivers/soc/mediatek/mtk-mutex.c" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
if 'mt6735m_mutex_mod' not in s:
    table = '''
/* MT6735M/MT6737M ("D2" MMSYS): OVL1 slot after OVL0 shifts the later modules by one */
static const u8 mt6735m_mutex_mod[DDP_COMPONENT_ID_MAX] = {
	[DDP_COMPONENT_OVL0] = 6,
	[DDP_COMPONENT_RDMA0] = 8,
	[DDP_COMPONENT_RDMA1] = 9,
	[DDP_COMPONENT_WDMA0] = 10,
	[DDP_COMPONENT_CCORR] = 11,
	[DDP_COMPONENT_COLOR0] = 12,
	[DDP_COMPONENT_AAL0] = 13,
	[DDP_COMPONENT_GAMMA] = 14,
	[DDP_COMPONENT_DITHER0] = 15,
	[DDP_COMPONENT_PWM0] = 17,
};
'''
    anchor = 'static const u8 mt6735_mutex_mod[DDP_COMPONENT_ID_MAX] = {'
    assert anchor in s
    s = s.replace(anchor, table.lstrip('\n') + '\n' + anchor, 1)
    data = '''static const struct mtk_mutex_data mt6735m_mutex_driver_data = {
	.mutex_mod = mt6735m_mutex_mod,
	.mutex_sof = mt6735_mutex_sof,
	.mutex_mod_reg = MT2701_MUTEX0_MOD0,
	.mutex_sof_reg = MT2701_MUTEX0_SOF0,
};

'''
    anchor = 'static const struct mtk_mutex_data mt6795_mutex_driver_data = {'
    assert anchor in s
    s = s.replace(anchor, data + anchor, 1)
    anchor = '\t{ .compatible = "mediatek,mt6735-disp-mutex", .data = &mt6735_mutex_driver_data },'
    assert anchor in s
    s = s.replace(anchor, anchor + '\n\t{ .compatible = "mediatek,mt6735m-disp-mutex", .data = &mt6735m_mutex_driver_data },', 1)
    open(p, 'w').write(s)
PY

P=$K/drivers/gpu/drm/panel
cp "$M/patches/panel-novatek-nt51021b.c" "$P/panel-novatek-nt51021b.c"
grep -q NT51021B "$P/Makefile" || \
	echo 'obj-$(CONFIG_DRM_PANEL_NOVATEK_NT51021B) += panel-novatek-nt51021b.o' >> "$P/Makefile"
if ! grep -q NT51021B "$P/Kconfig"; then
	python3 - "$P/Kconfig" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
entry = '''config DRM_PANEL_NOVATEK_NT51021B
	tristate "Novatek NT51021B 600x1024 DSI panel (Lenovo TB-7304X)"
	depends on OF
	depends on DRM_MIPI_DSI
	depends on BACKLIGHT_CLASS_DEVICE
	help
	  Say Y here to support the NT51021B-based 600x1024 video-mode
	  panel of the Lenovo Tab 7 Essential (TB-7304X).

'''
anchor = 'config DRM_PANEL_NOVATEK_NT35510'
assert anchor in s
s = s.replace(anchor, entry + anchor, 1)
open(p, 'w').write(s)
PY
fi
grep -q mt6735m_mutex_mod "$K/drivers/soc/mediatek/mtk-mutex.c"
grep -q NT51021B "$P/Kconfig"
