// SPDX-License-Identifier: GPL-2.0
/*
 * MediaTek MT6328 PMIC AUXADC (TB-7304X). Register sequence and channel scaling from the MT6735 BSP
 * (drivers/misc/mediatek/power/mt6735/pmic_auxadc.c, PMIC_IMM_GetOneChannelValue):
 *   enable AUXADC_CK_AON, RG_VBUF_EN, RG_CLKSQ_EN_AUX_AP_MODE; write BIT(ch) to AUXADC_RQST0_SET;
 *   poll bit 15 (ready) of the channel's output register; the value is in the low 15 or 12 bits.
 * Full scale 1800 mV. CH0 (BATSNS) has a /3 divider inside the PMIC; CH0/CH7 are 15-bit, the others 12-bit.
 * Channels (BSP names): 0 BATSNS (battery), 1 ISENSE, 2 VCDT (charger input, external divider on the board),
 * 3 BATON (battery NTC), 4 PMIC temperature, 5 ACCDET, 7 TSX. Only the AP request path is used; the modem side
 * (RQST1) is not touched.
 *
 * Also the battery current from the PMIC fuel gauge (FGADC, current mode over the sense resistor R_FG in the battery
 * path), as IIO current channel 0 (array index 7). BSP battery_meter_hal.c: clocks on, FG on in current mode with
 * auto-calibration at 32 kHz, then per read: SW_READ_PRE, wait LATCHDATA_ST, read FG_CURRENT_OUT (signed 16-bit,
 * positive = charging), SW_CLEAR, wait for LATCHDATA_ST to drop. 158.122 uA per LSB at R_FG = 20 mOhm; the board's
 * R_FG comes from "mediatek,fg-sense-resistor-micro-ohms" (stock r_fg_value = 10 mOhm).
 */
#include <linux/delay.h>
#include <linux/iio/iio.h>
#include <linux/mfd/mt6397/core.h>
#include <linux/module.h>
#include <linux/mod_devicetable.h>
#include <linux/math64.h>
#include <linux/mutex.h>
#include <linux/platform_device.h>
#include <linux/property.h>
#include <linux/regmap.h>

#define MT6328_TOP_CLKSQ		0x028a
#define MT6328_CLKSQ_EN_AUX_AP		BIT(8)
#define MT6328_AUXADC_RQST0_SET		0x0e8a
#define MT6328_AUXADC_CON0		0x0e94
#define MT6328_AUXADC_CK_AON		BIT(15)
#define MT6328_AUXADC_CON12		0x0eb0
#define MT6328_AUXADC_VBUF_EN		BIT(7)
#define MT6328_AUXADC_RDY		BIT(15)
#define MT6328_AUXADC_FULL_MV		1800

#define MT6328_TOP_CKPDN_CON2_CLR	0x024c
#define MT6328_FGADC_ANA_CK_PDN		BIT(2)
#define MT6328_FGADC_DIG_CK_PDN		BIT(3)
#define MT6328_FGADC_CON0		0x0ca4
#define MT6328_FG_ON_CFG		0x0029	/* low byte: FG_ON, current mode, auto-calibration, 32 kHz */
#define MT6328_FG_RESET			0x7100	/* high byte: SW_CR, OFFSET/TIME/CHARGE reset */
#define MT6328_FG_SW_READ_PRE		0x0200
#define MT6328_FG_LATCHDATA_ST		BIT(10)
#define MT6328_FG_SW_CLEAR		0x0800
#define MT6328_FGADC_CON7		0x0cb2	/* FG_CURRENT_OUT */
#define MT6328_FGADC_CON11		0x0cba	/* FG_OSR[3:0] */
#define MT6328_FG_UNIT_NA_20MOHM	158122ULL
#define MT6328_FG_CHAN			7	/* index in mt6328_auxadc_channels */

struct mt6328_auxadc {
	struct regmap *regmap;
	struct mutex lock;
	u32 fg_rsense_uohm;
};

struct mt6328_auxadc_ch {
	u16 out_reg;	/* AP result register: ready bit 15, value below */
	u8 bits;	/* 15 or 12 */
	u8 div;		/* internal divider */
};

static const struct mt6328_auxadc_ch mt6328_ch[] = {
	[0] = { 0x0e2e, 15, 3 },	/* BATSNS  (AUXADC_ADC23, by AP) */
	[1] = { 0x0e32, 15, 3 },	/* ISENSE  (AUXADC_ADC25, by AP) */
	[2] = { 0x0e04, 12, 1 },	/* VCDT    (AUXADC_ADC2) */
	[3] = { 0x0e06, 12, 1 },	/* BATON   (AUXADC_ADC3) */
	[4] = { 0x0e08, 12, 1 },	/* CH4: PMIC temperature (AUXADC_ADC4) */
	[5] = { 0x0e0a, 12, 1 },	/* ACCDET  (AUXADC_ADC5) */
	[7] = { 0x0e24, 15, 1 },	/* TSX     (AUXADC_ADC18, by AP) */
};

#define MT6328_CHAN(_ch, _name) {					\
	.type = IIO_VOLTAGE,						\
	.indexed = 1,							\
	.channel = (_ch),						\
	.datasheet_name = (_name),					\
	.info_mask_separate = BIT(IIO_CHAN_INFO_RAW) | BIT(IIO_CHAN_INFO_SCALE), \
}

static const struct iio_chan_spec mt6328_auxadc_channels[] = {
	MT6328_CHAN(0, "batsns"),
	MT6328_CHAN(1, "isense"),
	MT6328_CHAN(2, "vcdt"),
	MT6328_CHAN(3, "baton"),
	MT6328_CHAN(4, "pmic_temp"),
	MT6328_CHAN(5, "accdet"),
	MT6328_CHAN(7, "tsx"),
	[MT6328_FG_CHAN] = {
		.type = IIO_CURRENT,
		.indexed = 1,
		.channel = 0,
		.datasheet_name = "fg_current",
		.info_mask_separate = BIT(IIO_CHAN_INFO_RAW) | BIT(IIO_CHAN_INFO_SCALE),
	},
};

static int mt6328_fg_init(struct mt6328_auxadc *adc)
{
	int ret;

	ret = regmap_write(adc->regmap, MT6328_TOP_CKPDN_CON2_CLR, MT6328_FGADC_ANA_CK_PDN | MT6328_FGADC_DIG_CK_PDN);
	if (!ret)
		ret = regmap_update_bits(adc->regmap, MT6328_FGADC_CON0, 0x00ff, MT6328_FG_ON_CFG & ~1);
	if (!ret)
		ret = regmap_update_bits(adc->regmap, MT6328_FGADC_CON0, 0x00ff, MT6328_FG_ON_CFG);
	if (!ret)
		ret = regmap_update_bits(adc->regmap, MT6328_FGADC_CON0, 0xff00, MT6328_FG_RESET);
	if (!ret)
		ret = regmap_update_bits(adc->regmap, MT6328_FGADC_CON11, 0x000f, 8);
	return ret;
}

/* One latched FG_CURRENT_OUT sample (signed, positive = charging). */
static int mt6328_fg_read(struct mt6328_auxadc *adc, int *val)
{
	unsigned int v, out;
	int ret, ret2;

	mutex_lock(&adc->lock);
	ret = regmap_update_bits(adc->regmap, MT6328_FGADC_CON0, 0xff00, MT6328_FG_SW_READ_PRE);
	if (!ret)
		ret = regmap_read_poll_timeout(adc->regmap, MT6328_FGADC_CON0, v, v & MT6328_FG_LATCHDATA_ST, 100, 20000);
	if (!ret)
		ret = regmap_read(adc->regmap, MT6328_FGADC_CON7, &out);
	ret2 = regmap_update_bits(adc->regmap, MT6328_FGADC_CON0, 0xff00, MT6328_FG_SW_CLEAR);
	if (!ret2)
		ret2 = regmap_read_poll_timeout(adc->regmap, MT6328_FGADC_CON0, v, !(v & MT6328_FG_LATCHDATA_ST), 100,
						20000);
	regmap_update_bits(adc->regmap, MT6328_FGADC_CON0, 0xff00, 0);
	mutex_unlock(&adc->lock);
	if (ret || ret2)
		return ret ? ret : ret2;
	*val = (s16)out;
	return 0;
}

static int mt6328_auxadc_enable(struct mt6328_auxadc *adc)
{
	int ret;

	ret = regmap_set_bits(adc->regmap, MT6328_AUXADC_CON0, MT6328_AUXADC_CK_AON);
	if (!ret)
		ret = regmap_set_bits(adc->regmap, MT6328_AUXADC_CON12, MT6328_AUXADC_VBUF_EN);
	if (!ret)
		ret = regmap_set_bits(adc->regmap, MT6328_TOP_CLKSQ, MT6328_CLKSQ_EN_AUX_AP);
	return ret;
}

static int mt6328_auxadc_read(struct mt6328_auxadc *adc, int ch, int *val)
{
	const struct mt6328_auxadc_ch *c = &mt6328_ch[ch];
	unsigned int v;
	int ret;

	mutex_lock(&adc->lock);
	ret = mt6328_auxadc_enable(adc);
	if (!ret)
		ret = regmap_write(adc->regmap, MT6328_AUXADC_RQST0_SET, BIT(ch));
	if (!ret) {
		udelay(50);
		/* the BSP polls 1-2 ms at a time, up to 15 times */
		ret = regmap_read_poll_timeout(adc->regmap, c->out_reg, v, v & MT6328_AUXADC_RDY, 1000, 30000);
	}
	mutex_unlock(&adc->lock);
	if (ret)
		return ret;
	*val = v & GENMASK(c->bits - 1, 0);
	return 0;
}

static int mt6328_auxadc_read_raw(struct iio_dev *indio_dev, struct iio_chan_spec const *chan,
				  int *val, int *val2, long mask)
{
	struct mt6328_auxadc *adc = iio_priv(indio_dev);
	const struct mt6328_auxadc_ch *c = &mt6328_ch[chan->channel];
	int ret;

	if (chan->type == IIO_CURRENT) {
		switch (mask) {
		case IIO_CHAN_INFO_RAW:
			ret = mt6328_fg_read(adc, val);
			return ret ? ret : IIO_VAL_INT;
		case IIO_CHAN_INFO_SCALE:
			/* mA per LSB */
			*val = 0;
			*val2 = div_u64(MT6328_FG_UNIT_NA_20MOHM * 1000 * 20000, adc->fg_rsense_uohm);
			return IIO_VAL_INT_PLUS_NANO;
		default:
			return -EINVAL;
		}
	}

	switch (mask) {
	case IIO_CHAN_INFO_RAW:
		ret = mt6328_auxadc_read(adc, chan->channel, val);
		return ret ? ret : IIO_VAL_INT;
	case IIO_CHAN_INFO_SCALE:
		/* mV per LSB = div * 1800 / 2^bits */
		*val = c->div * MT6328_AUXADC_FULL_MV;
		*val2 = c->bits;
		return IIO_VAL_FRACTIONAL_LOG2;
	default:
		return -EINVAL;
	}
}

static const struct iio_info mt6328_auxadc_info = {
	.read_raw = mt6328_auxadc_read_raw,
};

static int mt6328_auxadc_probe(struct platform_device *pdev)
{
	struct mt6397_chip *chip = dev_get_drvdata(pdev->dev.parent);
	struct iio_dev *indio_dev;
	struct mt6328_auxadc *adc;
	int ret;

	if (!chip || !chip->regmap)
		return dev_err_probe(&pdev->dev, -ENODEV, "no PMIC regmap\n");

	indio_dev = devm_iio_device_alloc(&pdev->dev, sizeof(*adc));
	if (!indio_dev)
		return -ENOMEM;
	adc = iio_priv(indio_dev);
	adc->regmap = chip->regmap;
	ret = devm_mutex_init(&pdev->dev, &adc->lock);
	if (ret)
		return ret;
	adc->fg_rsense_uohm = 20000;
	device_property_read_u32(&pdev->dev, "mediatek,fg-sense-resistor-micro-ohms", &adc->fg_rsense_uohm);
	if (adc->fg_rsense_uohm < 1000)
		return dev_err_probe(&pdev->dev, -EINVAL, "implausible FG sense resistor\n");
	ret = mt6328_fg_init(adc);
	if (ret)
		dev_warn(&pdev->dev, "fuel gauge init failed: %d\n", ret);

	indio_dev->name = "mt6328-auxadc";
	indio_dev->info = &mt6328_auxadc_info;
	indio_dev->modes = INDIO_DIRECT_MODE;
	indio_dev->channels = mt6328_auxadc_channels;
	indio_dev->num_channels = ARRAY_SIZE(mt6328_auxadc_channels);

	return devm_iio_device_register(&pdev->dev, indio_dev);
}

static const struct of_device_id mt6328_auxadc_of_match[] = {
	{ .compatible = "mediatek,mt6328-auxadc" },
	{ }
};
MODULE_DEVICE_TABLE(of, mt6328_auxadc_of_match);

static struct platform_driver mt6328_auxadc_driver = {
	.driver = {
		.name = "mt6328-auxadc",
		.of_match_table = mt6328_auxadc_of_match,
	},
	.probe = mt6328_auxadc_probe,
};
module_platform_driver(mt6328_auxadc_driver);

MODULE_DESCRIPTION("MediaTek MT6328 PMIC AUXADC");
MODULE_LICENSE("GPL");
