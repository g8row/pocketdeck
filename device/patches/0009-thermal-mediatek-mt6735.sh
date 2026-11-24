#!/bin/sh
# Idempotently add MT6735 ("D2" MT6735M/MT6737M) support to drivers/thermal/mediatek/auxadc_thermal.c in $1.
# Same thermal controller IP as MT8173 (AUXADC channel 11, MTK_THERMAL_V1, the same efuse calibration fields when
# the nvmem cell starts at efuse 0x19c: on the TB-7304X VTS1/2/3 = 160/164/156, DEGC 53, calibrated).
# Banks, from the downstream mtk_tc_D2.c: bank0 CPU = TS_MCU3, bank1 SoC+GPU = TS_MCU1, bank2 LTE = TS_MCU2 (+ ABB,
# left out: its calibration word is unverified). Sensor mux values as MT8173 (TS_MCU1..3 = 0..2).
set -e
F=$1/drivers/thermal/mediatek/auxadc_thermal.c
grep -q mt6735_thermal_data "$F" && exit 0
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
a = 'static const struct mtk_thermal_data mt8173_thermal_data = {'
assert s.count(a) == 1
data = '''/*
 * MT6735 (D2: MT6735M/MT6737M): three banks with one sensor each, CPU / SoC+GPU / LTE. Sensor numbering, mux
 * values and calibration fields as MT8173.
 */
static const int mt6735_bank_data[3][1] = {
	{ MT8173_TS3 },	/* CPU, TS_MCU3 */
	{ MT8173_TS1 },	/* SoC + GPU, TS_MCU1 */
	{ MT8173_TS2 },	/* LTE, TS_MCU2 */
};

static const struct mtk_thermal_data mt6735_thermal_data = {
	.auxadc_channel = MT8173_TEMP_AUXADC_CHANNEL,
	.num_banks = 3,
	.num_sensors = MT8173_NUM_SENSORS,
	.vts_index = mt8173_vts_index,
	.cali_val = MT8173_CALIBRATION,
	.num_controller = MT8173_NUM_CONTROLLER,
	.controller_offset = mt8173_tc_offset,
	.need_switch_bank = true,
	.bank_data = {
		{ .num_sensors = 1, .sensors = mt6735_bank_data[0], },
		{ .num_sensors = 1, .sensors = mt6735_bank_data[1], },
		{ .num_sensors = 1, .sensors = mt6735_bank_data[2], },
	},
	.msr = mt8173_msr,
	.adcpnp = mt8173_adcpnp,
	.sensor_mux_values = mt8173_mux_values,
	.version = MTK_THERMAL_V1,
};

'''
s = s.replace(a, data + a)
a = '''	{
		.compatible = "mediatek,mt8173-thermal",
		.data = (void *)&mt8173_thermal_data,
	},'''
assert s.count(a) == 1
s = s.replace(a, a + '''
	{
		.compatible = "mediatek,mt6735-thermal",
		.data = (void *)&mt6735_thermal_data,
	},''')
open(p, 'w').write(s)
PY
grep -q '"mediatek,mt6735-thermal"' "$F"
echo "   applied 0009 mt6735 thermal"
