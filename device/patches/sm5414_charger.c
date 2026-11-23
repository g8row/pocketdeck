// SPDX-License-Identifier: GPL-2.0
/*
 * Silicon Mitus SM5414 switching charger (Lenovo TB-7304X), plus the battery it charges.
 *
 * Register map from the MediaTek BSP driver (sm5414.h / charging_hw_sm5414.c, see
 * docs/mainline/research-power.md §1). The chip has no host watchdog and no battery NTC input; LK programs it and
 * enables charging on every boot. This driver:
 *  - programs CV, charge current, input current limit and top-off current from the monitored battery / DT,
 *    and puts them back if they ever change under it (checked on every poll);
 *  - stops charging (CTRL.CHGEN, verified on the device: the system then runs from the battery) outside the
 *    battery's operating temperature range, read from the "battery-thermal" thermal zone (PMIC BATON NTC), with
 *    3 C of hysteresis, and on request (charge_behaviour = inhibit-charge);
 *  - polls STATUS and the read-to-clear interrupt registers every 10 s (no IRQ wiring yet), logs faults;
 *  - registers "sm5414-charger" (online/status/health, writable CV/CC/input limit/charge_behaviour) and "battery"
 *    (voltage, current from the PMIC fuel gauge, temperature, capacity from the OCV table corrected by I x R_int).
 */
#include <linux/bitfield.h>
#include <linux/delay.h>
#include <linux/i2c.h>
#include <linux/iio/consumer.h>
#include <linux/module.h>
#include <linux/mutex.h>
#include <linux/power_supply.h>
#include <linux/property.h>
#include <linux/regmap.h>
#include <linux/thermal.h>
#include <linux/workqueue.h>

#define SM5414_INT1		0x00
#define SM5414_INT2		0x01
#define SM5414_INT3		0x02
#define SM5414_STATUS		0x06
#define  SM5414_ST_VBUSOVP	BIT(7)
#define  SM5414_ST_VBUSUVLO	BIT(6)
#define  SM5414_ST_TOPOFF	BIT(5)
#define  SM5414_ST_THEMSHDN	BIT(2)
#define  SM5414_ST_BATDET	BIT(1)
#define SM5414_CTRL		0x07
#define  SM5414_CTRL_CHGEN	BIT(1)
#define SM5414_VBUSCTRL		0x08	/* VBUSLIMIT[5:0]: 100 mA + 50 mA * n */
#define  SM5414_VBUSLIMIT	GENMASK(5, 0)
#define SM5414_CHGCTRL2		0x0a	/* FASTCHG[5:0]: 100 mA + 50 mA * n */
#define  SM5414_FASTCHG		GENMASK(5, 0)
#define SM5414_CHGCTRL3		0x0b	/* BATREG[7:4]: 4.100 V + 25 mV * n; WEAKBAT[3:0] */
#define  SM5414_BATREG		GENMASK(7, 4)
#define SM5414_CHGCTRL4		0x0c	/* TOPOFF[6:3]: 100 mA + 50 mA * n; DISLIMIT[2:0] */
#define  SM5414_TOPOFF		GENMASK(6, 3)
#define SM5414_ID		0x0e

/* INT1/INT2 bits worth a log line */
#define SM5414_INT1_VBUSOVP	BIT(7)
#define SM5414_INT1_BATOVP	BIT(2)
#define SM5414_INT1_THEMSHDN	BIT(1)
#define SM5414_INT1_THEMREG	BIT(0)
#define SM5414_INT2_FASTTMROFF	BIT(7)
#define SM5414_INT2_NOBAT	BIT(6)
#define SM5414_INT2_PRETMROFF	BIT(3)

/* Hard limits, whatever DT or userspace asks for: the stock maxima (CV 4.35 V, 1.05 A AC). */
#define SM5414_CV_MIN_UV	4100000
#define SM5414_CV_MAX_UV	4350000
#define SM5414_CC_MIN_UA	100000
#define SM5414_CC_MAX_UA	1000000
#define SM5414_ILIM_MIN_UA	100000
#define SM5414_ILIM_MAX_UA	2000000

#define SM5414_POLL		(10 * HZ)
#define SM5414_TEMP_HYST	3000	/* milli-C */

struct sm5414 {
	struct device *dev;
	struct regmap *regmap;
	struct power_supply *charger;
	struct power_supply *battery;
	struct power_supply_battery_info *info;
	struct iio_channel *vbat;
	struct iio_channel *ibat;
	struct thermal_zone_device *tz;
	struct delayed_work work;
	struct mutex lock;

	/* targets (uV / uA) */
	int cv, cc, ilim, topoff;
	int temp_min, temp_max;	/* milli-C, charging allowed inside */
	bool inhibit;		/* charge_behaviour */
	bool temp_block;	/* outside the temperature range */
	int temp;		/* milli-C, last read; INT_MIN if unknown */
	int ibat_ua;		/* uA, last poll; INT_MIN if unknown */
	u8 status;		/* STATUS register, last read */
	int last_psy_status, last_health, last_cap;
	bool last_online;
};

static int sm5414_cv_to_reg(int uv)
{
	return (clamp(uv, SM5414_CV_MIN_UV, SM5414_CV_MAX_UV) - 4100000) / 25000;
}

static int sm5414_ma50_to_reg(int ua, int min, int max, int fmax)
{
	return min_t(int, (clamp(ua, min, max) - 100000) / 50000, fmax);
}

/* (Re)program the targets; with `check` only fix what differs (and say so). */
static void sm5414_apply(struct sm5414 *sm, bool check)
{
	const struct {
		u8 reg, mask;
		int val;
		const char *name;
	} f[] = {
		{ SM5414_CHGCTRL3, SM5414_BATREG, sm5414_cv_to_reg(sm->cv), "CV" },
		{ SM5414_CHGCTRL2, SM5414_FASTCHG,
		  sm5414_ma50_to_reg(sm->cc, SM5414_CC_MIN_UA, SM5414_CC_MAX_UA, 0x3f), "charge current" },
		{ SM5414_VBUSCTRL, SM5414_VBUSLIMIT,
		  sm5414_ma50_to_reg(sm->ilim, SM5414_ILIM_MIN_UA, SM5414_ILIM_MAX_UA, 0x3f), "input limit" },
		{ SM5414_CHGCTRL4, SM5414_TOPOFF,
		  sm5414_ma50_to_reg(sm->topoff, 100000, 850000, 0xf), "top-off current" },
	};
	unsigned int v;
	int i;

	for (i = 0; i < ARRAY_SIZE(f); i++) {
		u8 want = field_prep(f[i].mask, f[i].val);

		if (regmap_read(sm->regmap, f[i].reg, &v))
			continue;
		if ((v & f[i].mask) == want)
			continue;
		if (check)
			dev_warn(sm->dev, "%s register changed under us (%#x), restoring\n", f[i].name, v);
		regmap_update_bits(sm->regmap, f[i].reg, f[i].mask, want);
	}
}

static bool sm5414_online(struct sm5414 *sm)
{
	return !(sm->status & (SM5414_ST_VBUSUVLO | SM5414_ST_VBUSOVP));
}

static bool sm5414_charging_allowed(struct sm5414 *sm)
{
	return !sm->inhibit && !sm->temp_block;
}

static int sm5414_psy_status(struct sm5414 *sm)
{
	if (!sm5414_online(sm))
		return POWER_SUPPLY_STATUS_DISCHARGING;
	if (!sm5414_charging_allowed(sm))
		return POWER_SUPPLY_STATUS_NOT_CHARGING;
	/*
	 * STATUS.TOPOFF is set for the whole CV phase (seen with 440 mA still flowing), so full also needs the
	 * current below the top-off threshold.
	 */
	if ((sm->status & SM5414_ST_TOPOFF) && (sm->ibat_ua == INT_MIN || sm->ibat_ua < sm->topoff))
		return POWER_SUPPLY_STATUS_FULL;
	return POWER_SUPPLY_STATUS_CHARGING;
}

static int sm5414_health(struct sm5414 *sm)
{
	if (sm->status & SM5414_ST_THEMSHDN)
		return POWER_SUPPLY_HEALTH_OVERHEAT;
	if (sm->status & SM5414_ST_VBUSOVP)
		return POWER_SUPPLY_HEALTH_OVERVOLTAGE;
	if (sm->temp != INT_MIN && sm->temp_block)
		return sm->temp >= sm->temp_max ? POWER_SUPPLY_HEALTH_OVERHEAT : POWER_SUPPLY_HEALTH_COLD;
	return POWER_SUPPLY_HEALTH_GOOD;
}

static int sm5414_read_temp(struct sm5414 *sm)
{
	int t;

	if (IS_ERR_OR_NULL(sm->tz)) {
		sm->tz = thermal_zone_get_zone_by_name("battery-thermal");
		if (IS_ERR(sm->tz))
			return INT_MIN;
	}
	if (thermal_zone_get_temp(sm->tz, &t))
		return INT_MIN;
	return t;
}

static int sm5414_vbat(struct sm5414 *sm, int *uv)
{
	return iio_read_channel_processed_scale(sm->vbat, uv, 1000);
}

static int sm5414_ibat(struct sm5414 *sm, int *ua)
{
	if (!sm->ibat)
		return -ENODEV;
	return iio_read_channel_processed_scale(sm->ibat, ua, 1000);
}

static int sm5414_capacity(struct sm5414 *sm)
{
	int uv, ua = 0, ocv, i, sum = 0, n = 0;

	if (!sm->info || sm->info->ocv_table_size[0] <= 0)
		return -ENODATA;
	/* a few samples: the ADC reads are single conversions */
	for (i = 0; i < 4; i++) {
		if (sm5414_vbat(sm, &uv))
			continue;
		sum += uv;
		n++;
	}
	if (!n)
		return -EIO;
	ocv = sum / n;
	/* terminal voltage = OCV + I * R_int (I > 0 charging) */
	if (!sm5414_ibat(sm, &ua) && sm->info->factory_internal_resistance_uohm > 0)
		ocv -= (int)div_s64((s64)ua * sm->info->factory_internal_resistance_uohm, 1000000);
	return power_supply_batinfo_ocv2cap(sm->info, ocv, sm->temp == INT_MIN ? 25 : sm->temp / 1000);
}

static void sm5414_set_chgen(struct sm5414 *sm)
{
	regmap_update_bits(sm->regmap, SM5414_CTRL, SM5414_CTRL_CHGEN,
			   sm5414_charging_allowed(sm) ? SM5414_CTRL_CHGEN : 0);
}

static void sm5414_update(struct sm5414 *sm, bool check)
{
	unsigned int st, i1 = 0, i2 = 0, i3 = 0;
	bool block, changed;
	int t, cap;

	mutex_lock(&sm->lock);
	regmap_read(sm->regmap, SM5414_INT1, &i1);
	regmap_read(sm->regmap, SM5414_INT2, &i2);
	regmap_read(sm->regmap, SM5414_INT3, &i3);
	if (i1 & SM5414_INT1_VBUSOVP)
		dev_warn(sm->dev, "VBUS over-voltage\n");
	if (i1 & SM5414_INT1_BATOVP)
		dev_warn(sm->dev, "battery over-voltage\n");
	if (i1 & SM5414_INT1_THEMSHDN)
		dev_warn(sm->dev, "thermal shutdown\n");
	if (i2 & SM5414_INT2_FASTTMROFF)
		dev_warn(sm->dev, "fast-charge safety timer expired\n");
	if (i2 & SM5414_INT2_PRETMROFF)
		dev_warn(sm->dev, "pre-charge safety timer expired\n");
	if (i2 & SM5414_INT2_NOBAT)
		dev_warn(sm->dev, "no battery\n");
	if (!regmap_read(sm->regmap, SM5414_STATUS, &st))
		sm->status = st;

	/* temperature gate with hysteresis; an unreadable temperature keeps the previous decision */
	t = sm5414_read_temp(sm);
	sm->temp = t;
	if (t != INT_MIN) {
		block = sm->temp_block;
		if (!block && (t >= sm->temp_max || t < sm->temp_min))
			block = true;
		else if (block && t <= sm->temp_max - SM5414_TEMP_HYST && t >= sm->temp_min + SM5414_TEMP_HYST)
			block = false;
		if (block != sm->temp_block)
			dev_info(sm->dev, "battery at %d.%d C: charging %s\n", t / 1000, abs(t % 1000) / 100,
				 block ? "stopped" : "resumed");
		sm->temp_block = block;
	}
	sm5414_apply(sm, check);
	sm5414_set_chgen(sm);
	if (sm5414_ibat(sm, &sm->ibat_ua))
		sm->ibat_ua = INT_MIN;

	cap = sm5414_capacity(sm);
	changed = sm5414_online(sm) != sm->last_online || sm5414_psy_status(sm) != sm->last_psy_status ||
		  sm5414_health(sm) != sm->last_health || cap != sm->last_cap;
	sm->last_online = sm5414_online(sm);
	sm->last_psy_status = sm5414_psy_status(sm);
	sm->last_health = sm5414_health(sm);
	sm->last_cap = cap;
	mutex_unlock(&sm->lock);

	if (changed) {
		power_supply_changed(sm->charger);
		power_supply_changed(sm->battery);
	}
}

static void sm5414_work(struct work_struct *work)
{
	struct sm5414 *sm = container_of(to_delayed_work(work), struct sm5414, work);

	sm5414_update(sm, true);
	schedule_delayed_work(&sm->work, SM5414_POLL);
}

/* ---- charger supply ---- */

static const enum power_supply_property sm5414_charger_props[] = {
	POWER_SUPPLY_PROP_ONLINE,
	POWER_SUPPLY_PROP_STATUS,
	POWER_SUPPLY_PROP_HEALTH,
	POWER_SUPPLY_PROP_CHARGE_BEHAVIOUR,
	POWER_SUPPLY_PROP_CONSTANT_CHARGE_CURRENT,
	POWER_SUPPLY_PROP_CONSTANT_CHARGE_CURRENT_MAX,
	POWER_SUPPLY_PROP_CONSTANT_CHARGE_VOLTAGE,
	POWER_SUPPLY_PROP_CONSTANT_CHARGE_VOLTAGE_MAX,
	POWER_SUPPLY_PROP_INPUT_CURRENT_LIMIT,
	POWER_SUPPLY_PROP_CHARGE_TERM_CURRENT,
};

static int sm5414_charger_get(struct power_supply *psy, enum power_supply_property psp,
			      union power_supply_propval *val)
{
	struct sm5414 *sm = power_supply_get_drvdata(psy);
	unsigned int v;
	int ret = 0;

	mutex_lock(&sm->lock);
	switch (psp) {
	case POWER_SUPPLY_PROP_ONLINE:
		val->intval = sm5414_online(sm);
		break;
	case POWER_SUPPLY_PROP_STATUS:
		val->intval = sm5414_psy_status(sm);
		break;
	case POWER_SUPPLY_PROP_HEALTH:
		val->intval = sm5414_health(sm);
		break;
	case POWER_SUPPLY_PROP_CHARGE_BEHAVIOUR:
		val->intval = sm->inhibit ? POWER_SUPPLY_CHARGE_BEHAVIOUR_INHIBIT_CHARGE :
					    POWER_SUPPLY_CHARGE_BEHAVIOUR_AUTO;
		break;
	/* the register values, i.e. what the chip actually does */
	case POWER_SUPPLY_PROP_CONSTANT_CHARGE_CURRENT:
		ret = regmap_read(sm->regmap, SM5414_CHGCTRL2, &v);
		val->intval = 100000 + 50000 * FIELD_GET(SM5414_FASTCHG, v);
		break;
	case POWER_SUPPLY_PROP_CONSTANT_CHARGE_CURRENT_MAX:
		val->intval = SM5414_CC_MAX_UA;
		break;
	case POWER_SUPPLY_PROP_CONSTANT_CHARGE_VOLTAGE:
		ret = regmap_read(sm->regmap, SM5414_CHGCTRL3, &v);
		val->intval = 4100000 + 25000 * FIELD_GET(SM5414_BATREG, v);
		break;
	case POWER_SUPPLY_PROP_CONSTANT_CHARGE_VOLTAGE_MAX:
		val->intval = SM5414_CV_MAX_UV;
		break;
	case POWER_SUPPLY_PROP_INPUT_CURRENT_LIMIT:
		ret = regmap_read(sm->regmap, SM5414_VBUSCTRL, &v);
		val->intval = 100000 + 50000 * FIELD_GET(SM5414_VBUSLIMIT, v);
		break;
	case POWER_SUPPLY_PROP_CHARGE_TERM_CURRENT:
		ret = regmap_read(sm->regmap, SM5414_CHGCTRL4, &v);
		val->intval = 100000 + 50000 * FIELD_GET(SM5414_TOPOFF, v);
		break;
	default:
		ret = -EINVAL;
	}
	mutex_unlock(&sm->lock);
	return ret;
}

static int sm5414_charger_set(struct power_supply *psy, enum power_supply_property psp,
			      const union power_supply_propval *val)
{
	struct sm5414 *sm = power_supply_get_drvdata(psy);

	mutex_lock(&sm->lock);
	switch (psp) {
	case POWER_SUPPLY_PROP_CHARGE_BEHAVIOUR:
		if (val->intval != POWER_SUPPLY_CHARGE_BEHAVIOUR_AUTO &&
		    val->intval != POWER_SUPPLY_CHARGE_BEHAVIOUR_INHIBIT_CHARGE) {
			mutex_unlock(&sm->lock);
			return -EINVAL;
		}
		sm->inhibit = val->intval == POWER_SUPPLY_CHARGE_BEHAVIOUR_INHIBIT_CHARGE;
		break;
	case POWER_SUPPLY_PROP_CONSTANT_CHARGE_CURRENT:
		sm->cc = clamp(val->intval, SM5414_CC_MIN_UA, SM5414_CC_MAX_UA);
		break;
	case POWER_SUPPLY_PROP_CONSTANT_CHARGE_VOLTAGE:
		sm->cv = clamp(val->intval, SM5414_CV_MIN_UV, SM5414_CV_MAX_UV);
		break;
	case POWER_SUPPLY_PROP_INPUT_CURRENT_LIMIT:
		sm->ilim = clamp(val->intval, SM5414_ILIM_MIN_UA, SM5414_ILIM_MAX_UA);
		break;
	default:
		mutex_unlock(&sm->lock);
		return -EINVAL;
	}
	mutex_unlock(&sm->lock);
	sm5414_update(sm, false);
	return 0;
}

static int sm5414_charger_writeable(struct power_supply *psy, enum power_supply_property psp)
{
	return psp == POWER_SUPPLY_PROP_CHARGE_BEHAVIOUR || psp == POWER_SUPPLY_PROP_CONSTANT_CHARGE_CURRENT ||
	       psp == POWER_SUPPLY_PROP_CONSTANT_CHARGE_VOLTAGE || psp == POWER_SUPPLY_PROP_INPUT_CURRENT_LIMIT;
}

static const struct power_supply_desc sm5414_charger_desc = {
	.name = "sm5414-charger",
	.type = POWER_SUPPLY_TYPE_USB,
	.properties = sm5414_charger_props,
	.num_properties = ARRAY_SIZE(sm5414_charger_props),
	.get_property = sm5414_charger_get,
	.set_property = sm5414_charger_set,
	.property_is_writeable = sm5414_charger_writeable,
	.charge_behaviours = BIT(POWER_SUPPLY_CHARGE_BEHAVIOUR_AUTO) |
			     BIT(POWER_SUPPLY_CHARGE_BEHAVIOUR_INHIBIT_CHARGE),
};

/* ---- battery supply ---- */

static const enum power_supply_property sm5414_battery_props[] = {
	POWER_SUPPLY_PROP_STATUS,
	POWER_SUPPLY_PROP_HEALTH,
	POWER_SUPPLY_PROP_PRESENT,
	POWER_SUPPLY_PROP_TECHNOLOGY,
	POWER_SUPPLY_PROP_VOLTAGE_NOW,
	POWER_SUPPLY_PROP_CURRENT_NOW,
	POWER_SUPPLY_PROP_CAPACITY,
	POWER_SUPPLY_PROP_TEMP,
	POWER_SUPPLY_PROP_VOLTAGE_MAX_DESIGN,
	POWER_SUPPLY_PROP_VOLTAGE_MIN_DESIGN,
	POWER_SUPPLY_PROP_CHARGE_FULL_DESIGN,
};

static int sm5414_battery_get(struct power_supply *psy, enum power_supply_property psp,
			      union power_supply_propval *val)
{
	struct sm5414 *sm = power_supply_get_drvdata(psy);
	struct power_supply_battery_info *info = sm->info;
	int ret = 0;

	switch (psp) {
	case POWER_SUPPLY_PROP_STATUS:
		val->intval = sm5414_psy_status(sm);
		return 0;
	case POWER_SUPPLY_PROP_HEALTH:
		val->intval = sm5414_health(sm);
		return 0;
	case POWER_SUPPLY_PROP_PRESENT:
		val->intval = !!(sm->status & SM5414_ST_BATDET);
		return 0;
	case POWER_SUPPLY_PROP_TECHNOLOGY:
		val->intval = POWER_SUPPLY_TECHNOLOGY_LIPO;
		return 0;
	case POWER_SUPPLY_PROP_VOLTAGE_NOW:
		return sm5414_vbat(sm, &val->intval);
	case POWER_SUPPLY_PROP_CURRENT_NOW:
		return sm5414_ibat(sm, &val->intval);
	case POWER_SUPPLY_PROP_CAPACITY:
		ret = sm5414_capacity(sm);
		if (ret < 0)
			return ret;
		val->intval = ret;
		return 0;
	case POWER_SUPPLY_PROP_TEMP:
		ret = sm5414_read_temp(sm);
		if (ret == INT_MIN)
			return -ENODATA;
		val->intval = ret / 100;	/* tenths of a degree */
		return 0;
	case POWER_SUPPLY_PROP_VOLTAGE_MAX_DESIGN:
		if (!info || info->voltage_max_design_uv < 0)
			return -ENODATA;
		val->intval = info->voltage_max_design_uv;
		return 0;
	case POWER_SUPPLY_PROP_VOLTAGE_MIN_DESIGN:
		if (!info || info->voltage_min_design_uv < 0)
			return -ENODATA;
		val->intval = info->voltage_min_design_uv;
		return 0;
	case POWER_SUPPLY_PROP_CHARGE_FULL_DESIGN:
		if (!info || info->charge_full_design_uah < 0)
			return -ENODATA;
		val->intval = info->charge_full_design_uah;
		return 0;
	default:
		return -EINVAL;
	}
}

static const struct power_supply_desc sm5414_battery_desc = {
	.name = "battery",
	.type = POWER_SUPPLY_TYPE_BATTERY,
	.properties = sm5414_battery_props,
	.num_properties = ARRAY_SIZE(sm5414_battery_props),
	.get_property = sm5414_battery_get,
};

static const struct regmap_config sm5414_regmap = {
	.reg_bits = 8,
	.val_bits = 8,
	.max_register = SM5414_ID,
};

static void sm5414_cancel(void *data)
{
	struct sm5414 *sm = data;

	cancel_delayed_work_sync(&sm->work);
}

static int sm5414_probe(struct i2c_client *client)
{
	struct device *dev = &client->dev;
	struct power_supply_config cfg = {};
	struct power_supply_battery_info *info;
	struct sm5414 *sm;
	unsigned int id;
	int ret;

	sm = devm_kzalloc(dev, sizeof(*sm), GFP_KERNEL);
	if (!sm)
		return -ENOMEM;
	sm->dev = dev;
	sm->temp = INT_MIN;
	sm->ibat_ua = INT_MIN;
	sm->last_cap = INT_MIN;
	ret = devm_mutex_init(dev, &sm->lock);
	if (ret)
		return ret;
	INIT_DELAYED_WORK(&sm->work, sm5414_work);

	sm->regmap = devm_regmap_init_i2c(client, &sm5414_regmap);
	if (IS_ERR(sm->regmap))
		return PTR_ERR(sm->regmap);
	ret = regmap_read(sm->regmap, SM5414_ID, &id);
	if (ret)
		return dev_err_probe(dev, ret, "not answering\n");
	if (!id)
		return dev_err_probe(dev, -ENODEV, "ID register reads 0\n");

	sm->vbat = devm_iio_channel_get(dev, "vbat");
	if (IS_ERR(sm->vbat))
		return dev_err_probe(dev, PTR_ERR(sm->vbat), "no vbat channel\n");
	sm->ibat = devm_iio_channel_get(dev, "ibat");
	if (IS_ERR(sm->ibat)) {
		if (PTR_ERR(sm->ibat) == -EPROBE_DEFER)
			return -EPROBE_DEFER;
		sm->ibat = NULL;
	}

	cfg.drv_data = sm;
	cfg.fwnode = dev_fwnode(dev);
	sm->charger = devm_power_supply_register(dev, &sm5414_charger_desc, &cfg);
	if (IS_ERR(sm->charger))
		return dev_err_probe(dev, PTR_ERR(sm->charger), "registering the charger\n");

	/* Defaults: the TB-7304X desk policy (research-power.md); the monitored battery overrides them. */
	sm->cv = 4100000;
	sm->cc = 500000;
	sm->ilim = 1000000;
	sm->topoff = 150000;
	sm->temp_min = 0;
	sm->temp_max = 45000;
	ret = power_supply_get_battery_info(sm->charger, &info);
	if (ret) {
		dev_warn(dev, "no monitored-battery (%d): defaults, no capacity\n", ret);
	} else {
		sm->info = info;
		if (info->constant_charge_voltage_max_uv > 0)
			sm->cv = info->constant_charge_voltage_max_uv;
		if (info->constant_charge_current_max_ua > 0)
			sm->cc = info->constant_charge_current_max_ua;
		if (info->charge_term_current_ua > 0)
			sm->topoff = info->charge_term_current_ua;
		if (info->temp_min != INT_MIN && info->temp_max != INT_MAX) {
			sm->temp_min = info->temp_min * 1000;
			sm->temp_max = info->temp_max * 1000;
		}
	}
	device_property_read_u32(dev, "input-current-limit-microamp", &sm->ilim);

	cfg.fwnode = NULL;
	sm->battery = devm_power_supply_register(dev, &sm5414_battery_desc, &cfg);
	if (IS_ERR(sm->battery))
		return dev_err_probe(dev, PTR_ERR(sm->battery), "registering the battery\n");

	ret = devm_add_action_or_reset(dev, sm5414_cancel, sm);
	if (ret)
		return ret;
	sm5414_update(sm, false);
	dev_info(dev, "ID %#x: CV %d mV, charge %d mA, input %d mA, top-off %d mA, charging %d..%d C%s\n", id,
		 clamp(sm->cv, SM5414_CV_MIN_UV, SM5414_CV_MAX_UV) / 1000,
		 clamp(sm->cc, SM5414_CC_MIN_UA, SM5414_CC_MAX_UA) / 1000,
		 clamp(sm->ilim, SM5414_ILIM_MIN_UA, SM5414_ILIM_MAX_UA) / 1000, sm->topoff / 1000,
		 sm->temp_min / 1000, sm->temp_max / 1000, sm->ibat ? "" : ", no current channel");
	schedule_delayed_work(&sm->work, SM5414_POLL);
	return 0;
}

static const struct of_device_id sm5414_of_match[] = {
	{ .compatible = "siliconmitus,sm5414" },
	{ }
};
MODULE_DEVICE_TABLE(of, sm5414_of_match);

static struct i2c_driver sm5414_driver = {
	.driver = {
		.name = "sm5414-charger",
		.of_match_table = sm5414_of_match,
	},
	.probe = sm5414_probe,
};
module_i2c_driver(sm5414_driver);

MODULE_DESCRIPTION("Silicon Mitus SM5414 charger");
MODULE_LICENSE("GPL");
