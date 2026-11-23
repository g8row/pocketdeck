// SPDX-License-Identifier: GPL-2.0-only
/*
 * Tell MediaTek LK where to boot next, like the stock kernel's `reboot bootloader` / `reboot recovery`.
 *
 * LK reads the PMIC RTC spare register RTC_PDN1 at boot (MT6328: RTC at PMIC offset 0x4000, reached through the
 * PMIC wrapper's regmap):
 *   bit 13       Fast Boot  -> LK fastboot ("Set_RTC_Fastboot_Mode" in lk.bin)
 *   bits 4-5 = 1 recovery   -> the recovery partition (MTK calls it "factory reset" but only LK acts on it here)
 * RTC registers only latch after RTC_WRTGR is written and RTC_BBPU.CBUSY clears.
 *
 * The bits are written as soon as userspace asks, so any reboot afterwards (including sysrq 'b', which skips
 * the reboot notifiers) uses them:
 *   echo bootloader > /sys/devices/platform/rtc-boot-mode/next_boot     (or recovery / normal)
 * `reboot <arg>` through the syscall works too (reboot notifier).
 *
 * Power off, as the stock kernel's mt_power_off() (mtk_rtc_common.c / rtc/mt6328/mtk_rtc_hal.c, MT6735 3.18):
 *   1. RTC_BBPU = KEY | AUTO with BBPU (bit 2) clear: the PMIC drops PWRBB and switches off. Without a charger
 *      the tablet is now off.
 *   2. With a charger (MT6328 CHR_CON0.RGS_CHRDET) the PMIC stays on. Stock then resets through TOPRGU with the
 *      WDT_MODE "auto restart" bit (bypass power key) clear and no RTC boot flag, and LK treats that like being
 *      powered on by the charger: kernel_power_off_charging_detection -> power-off charging (KPOC). We do the
 *      same, and also fall back to it if step 1 did not cut power for any other reason.
 * This runs ahead of PSCI SYSTEM_OFF (legacy pm_power_off, default priority), which the stock ATF does not
 * implement: without this handler `poweroff` stops the CPUs and the tablet stays on with no way out but the
 * PMIC long-press reset.
 *
 * Deadman: the power-off handler only runs after every driver's shutdown, so a stuck driver would hang the
 * tablet before it. A reboot notifier that runs after the watchdog core has stopped the watchdog (priority -128
 * vs 0) arms TOPRGU for 31 s and an hrtimer for 25 s. The hrtimer covers hangs that sleep (the watchdog core's
 * ping worker could keep the hardware timer alive); the hardware timer covers hangs with interrupts off. Either
 * one ends in a TOPRGU reset: a normal reboot for restart, the power-off-charging reset for halt / power off.
 */
#define pr_fmt(fmt) "rtc-boot-mode: " fmt

#include <linux/delay.h>
#include <linux/hrtimer.h>
#include <linux/module.h>
#include <linux/io.h>
#include <linux/of.h>
#include <linux/of_address.h>
#include <linux/of_platform.h>
#include <linux/platform_device.h>
#include <linux/reboot.h>
#include <linux/regmap.h>

#define RTC_BASE		0x4000
#define RTC_BBPU		(RTC_BASE + 0x00)
#define  RTC_BBPU_AUTO		BIT(3)
#define  RTC_BBPU_CBUSY		BIT(6)
#define  RTC_BBPU_KEY		(0x43 << 8)
#define RTC_PDN1		(RTC_BASE + 0x2c)
#define  PDN1_RECOVERY_MASK	(3 << 4)
#define  PDN1_RECOVERY		(1 << 4)
#define  PDN1_FAST_BOOT		BIT(13)
#define RTC_WRTGR		(RTC_BASE + 0x3c)
#define PMIC_CHR_CON0		0x0f48
#define  CHR_CON0_CHRDET	BIT(5)

/* TOPRGU (mediatek,mt6735-wdt), mapped without claiming it: the watchdog driver owns it until power-off */
#define WDT_MODE		0x00
#define  WDT_MODE_EN		BIT(0)
#define  WDT_MODE_EXRST_EN	BIT(2)
#define  WDT_MODE_IRQ_EN	BIT(3)
#define  WDT_MODE_AUTO_RESTART	BIT(4)	/* stock: "bypass power key" reboot */
#define  WDT_MODE_DUAL_EN	BIT(6)
#define  WDT_MODE_KEY		0x22000000
#define WDT_LENGTH		0x04
#define  WDT_LENGTH_KEY		0x8
#define  WDT_LENGTH_TIMEOUT(s)	(((s) << 6) << 5)	/* 1 unit = 512 ticks of 32 kHz = 1/64 s, 11 bits */
#define WDT_RST			0x08
#define  WDT_RST_RELOAD		0x1971
#define WDT_SWRST		0x14
#define  WDT_SWRST_KEY		0x1209

#define DEADMAN_SW_S		25
#define DEADMAN_HW_S		31	/* the 11-bit length field tops out just under 32 s */

struct rtc_boot_mode {
	struct regmap *map;
	void __iomem *wdt;
	struct notifier_block nb;
	struct notifier_block deadman_nb;
	struct hrtimer deadman;
	bool deadman_reboot;
};

static int write_trigger(struct regmap *map)
{
	unsigned int v;
	int i, ret;

	ret = regmap_write(map, RTC_WRTGR, 1);
	if (ret)
		return ret;
	for (i = 0; i < 1000; i++) {
		ret = regmap_read(map, RTC_BBPU, &v);
		if (ret)
			return ret;
		if (!(v & RTC_BBPU_CBUSY))
			return 0;
		udelay(10);
	}
	return -ETIMEDOUT;
}

static int set_mode(struct rtc_boot_mode *bm, const char *mode)
{
	unsigned int pdn1;
	int ret;

	ret = regmap_read(bm->map, RTC_PDN1, &pdn1);
	if (ret)
		return ret;
	pdn1 &= ~(PDN1_FAST_BOOT | PDN1_RECOVERY_MASK);
	if (sysfs_streq(mode, "bootloader") || sysfs_streq(mode, "fastboot"))
		pdn1 |= PDN1_FAST_BOOT;
	else if (sysfs_streq(mode, "recovery"))
		pdn1 |= PDN1_RECOVERY;
	else if (!sysfs_streq(mode, "normal") && !sysfs_streq(mode, "android") && *mode)
		return -EINVAL;
	ret = regmap_write(bm->map, RTC_PDN1, pdn1);
	if (!ret)
		ret = write_trigger(bm->map);
	pr_info("next boot: %s (PDN1=%#06x)%s\n", *mode ? mode : "normal", pdn1, ret ? " FAILED" : "");
	return ret;
}

static ssize_t next_boot_show(struct device *dev, struct device_attribute *attr, char *buf)
{
	struct rtc_boot_mode *bm = dev_get_drvdata(dev);
	unsigned int pdn1;
	int ret = regmap_read(bm->map, RTC_PDN1, &pdn1);

	if (ret)
		return ret;
	return sysfs_emit(buf, "%s\n", pdn1 & PDN1_FAST_BOOT ? "bootloader" :
			  (pdn1 & PDN1_RECOVERY_MASK) == PDN1_RECOVERY ? "recovery" : "normal");
}

static ssize_t next_boot_store(struct device *dev, struct device_attribute *attr,
			       const char *buf, size_t count)
{
	int ret = set_mode(dev_get_drvdata(dev), buf);

	return ret ? ret : count;
}
static DEVICE_ATTR_RW(next_boot);

static int reboot_cb(struct notifier_block *nb, unsigned long action, void *cmd)
{
	struct rtc_boot_mode *bm = container_of(nb, struct rtc_boot_mode, nb);

	if (action == SYS_RESTART && cmd)
		set_mode(bm, cmd);
	return NOTIFY_DONE;
}

/*
 * Stock wdt_arch_reset(): reboot = true sets AUTO_RESTART ("bypass power key", a normal reboot); false is the
 * reset that LK does not see as a reboot, so it runs its charger checks (power-off charging, or off).
 */
static void wdt_reset(struct rtc_boot_mode *bm, bool reboot)
{
	u32 mode;

	if (!bm->wdt)
		return;
	mode = readl(bm->wdt + WDT_MODE) & 0xffff;
	mode &= ~(WDT_MODE_AUTO_RESTART | WDT_MODE_IRQ_EN | WDT_MODE_EN | WDT_MODE_DUAL_EN);
	if (reboot)
		mode |= WDT_MODE_AUTO_RESTART;
	writel(mode | WDT_MODE_KEY | WDT_MODE_EXRST_EN, bm->wdt + WDT_MODE);
	udelay(100);
	writel(WDT_SWRST_KEY, bm->wdt + WDT_SWRST);
	mdelay(1000);
}

static enum hrtimer_restart deadman_fire(struct hrtimer *t)
{
	struct rtc_boot_mode *bm = container_of(t, struct rtc_boot_mode, deadman);

	pr_emerg("%s stuck for %d s, forcing a reset\n", bm->deadman_reboot ? "restart" : "power off",
		 DEADMAN_SW_S);
	wdt_reset(bm, bm->deadman_reboot);	/* MMIO only: no regmap (mutex) in hardirq context */
	return HRTIMER_NORESTART;
}

static int deadman_cb(struct notifier_block *nb, unsigned long action, void *cmd)
{
	struct rtc_boot_mode *bm = container_of(nb, struct rtc_boot_mode, deadman_nb);
	u32 mode;

	if (action != SYS_RESTART && action != SYS_HALT && action != SYS_POWER_OFF)
		return NOTIFY_DONE;
	bm->deadman_reboot = action == SYS_RESTART;
	if (bm->wdt) {
		writel(WDT_LENGTH_TIMEOUT(DEADMAN_HW_S) | WDT_LENGTH_KEY, bm->wdt + WDT_LENGTH);
		writel(WDT_RST_RELOAD, bm->wdt + WDT_RST);
		mode = readl(bm->wdt + WDT_MODE) & 0xffff;
		mode &= ~(WDT_MODE_AUTO_RESTART | WDT_MODE_IRQ_EN | WDT_MODE_DUAL_EN);
		if (bm->deadman_reboot)
			mode |= WDT_MODE_AUTO_RESTART;
		writel(mode | WDT_MODE_KEY | WDT_MODE_EXRST_EN | WDT_MODE_EN, bm->wdt + WDT_MODE);
	}
	hrtimer_start(&bm->deadman, ktime_set(DEADMAN_SW_S, 0), HRTIMER_MODE_REL);
	pr_info("deadman armed: %d s timer, %d s TOPRGU\n", DEADMAN_SW_S, bm->wdt ? DEADMAN_HW_S : 0);
	return NOTIFY_DONE;
}

static int power_off_cb(struct sys_off_data *data)
{
	struct rtc_boot_mode *bm = data->cb_data;
	unsigned int chr = 0;
	int ret;

	regmap_read(bm->map, PMIC_CHR_CON0, &chr);
	pr_emerg("power off, charger %s\n", chr & CHR_CON0_CHRDET ? "present" : "absent");
	ret = regmap_write(bm->map, RTC_BBPU, RTC_BBPU_KEY | RTC_BBPU_AUTO);
	if (!ret)
		ret = write_trigger(bm->map);
	if (ret)
		pr_emerg("RTC_BBPU write failed: %d\n", ret);
	mdelay(1000);	/* without a charger the PMIC cuts power in here */

	pr_emerg("still powered, resetting for LK's power-off charging\n");
	wdt_reset(bm, false);
	pr_emerg("TOPRGU reset failed\n");
	return NOTIFY_DONE;
}

static int rtc_boot_mode_probe(struct platform_device *pdev)
{
	struct device *dev = &pdev->dev;
	struct device_node *np;
	struct platform_device *pwrap;
	struct rtc_boot_mode *bm;
	int ret;

	np = of_parse_phandle(dev->of_node, "mediatek,pwrap", 0);
	if (!np)
		return dev_err_probe(dev, -EINVAL, "no mediatek,pwrap phandle\n");
	pwrap = of_find_device_by_node(np);
	of_node_put(np);
	if (!pwrap)
		return -EPROBE_DEFER;

	bm = devm_kzalloc(dev, sizeof(*bm), GFP_KERNEL);
	if (!bm)
		return -ENOMEM;
	bm->map = dev_get_regmap(&pwrap->dev, NULL);
	put_device(&pwrap->dev);
	if (!bm->map)
		return -EPROBE_DEFER;
	platform_set_drvdata(pdev, bm);

	np = of_parse_phandle(dev->of_node, "mediatek,toprgu", 0);
	if (np) {
		bm->wdt = of_iomap(np, 0);
		of_node_put(np);
	}
	if (!bm->wdt)
		dev_warn(dev, "no mediatek,toprgu: power off cannot fall back to a reset\n");
	ret = devm_register_sys_off_handler(dev, SYS_OFF_MODE_POWER_OFF, SYS_OFF_PRIO_HIGH, power_off_cb, bm);
	if (ret)
		return dev_err_probe(dev, ret, "power-off handler\n");
	hrtimer_setup(&bm->deadman, deadman_fire, CLOCK_MONOTONIC, HRTIMER_MODE_REL);
	bm->deadman_nb.notifier_call = deadman_cb;
	bm->deadman_nb.priority = -128;	/* after watchdog_reboot_notifier (0), which stops the watchdog */
	ret = devm_register_reboot_notifier(dev, &bm->deadman_nb);
	if (ret)
		return ret;

	ret = device_create_file(dev, &dev_attr_next_boot);
	if (ret)
		return ret;
	bm->nb.notifier_call = reboot_cb;
	bm->nb.priority = 192;
	return devm_register_reboot_notifier(dev, &bm->nb);
}

static const struct of_device_id rtc_boot_mode_of_match[] = {
	{ .compatible = "lenovo,tb7304x-rtc-boot-mode" },
	{ }
};

static struct platform_driver rtc_boot_mode_driver = {
	.probe = rtc_boot_mode_probe,
	.driver = {
		.name = "mtk-rtc-boot-mode",
		.of_match_table = rtc_boot_mode_of_match,
	},
};
builtin_platform_driver(rtc_boot_mode_driver);
