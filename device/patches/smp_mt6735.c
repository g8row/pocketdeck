// SPDX-License-Identifier: GPL-2.0-only
/*
 * MT6735/MT6737 secondary CPU bring-up, the mainline equivalent of the stock kernel's
 * enable-method = "mt-boot".
 *
 * The stock ATF implements PSCI CPU_ON only as "record the entry point": it never powers
 * the core's MTCMOS domain. The stock 3.18 kernel (disassembled, see README) therefore does
 * PSCI CPU_ON first and then powers the core up itself through the SPM. Doing it the other
 * way round would let the core enter ATF's warm boot while ATF still thinks it is OFF.
 *
 * Register sequence recovered from the stock kernel (spm_mtcmos_ctrl_cpuN in
 * drivers/misc/mediatek/base/power/mt6735/mt_spm_mtcmos.c). Not verified against source.
 */
#define pr_fmt(fmt) "mt6735-smp: " fmt

#include <linux/delay.h>
#include <linux/io.h>
#include <linux/iopoll.h>
#include <linux/spinlock.h>
#include <asm/cpu_ops.h>

extern const struct cpu_operations cpu_psci_ops;

#define SPM_BASE		0x10006000
#define SPM_POWERON_CONFIG_SET	0x000
#define  SPM_PROJECT_KEY	0x0b160001
#define SPM_PWR_STATUS		0x60c
#define SPM_PWR_STATUS_2ND	0x610
#define SPM_SLEEP_TIMER_STA	0x720	/* per-core "in WFI" bits */

/* CPUn_PWR_CON bits */
#define PWR_RST_B		BIT(0)
#define PWR_ISO			BIT(1)
#define PWR_ON			BIT(2)
#define PWR_ON_2ND		BIT(3)
#define PWR_CLK_DIS		BIT(4)
#define SRAM_CKISO		BIT(5)
#define SRAM_ISOINT_B		BIT(6)
/* CPUn_L1_PDN bits */
#define L1_PDN			BIT(0)
#define L1_PDN_ACK		BIT(8)

static const struct {
	u16 pwr_con, l1_pdn;
	u8 sta_bit, wfi_bit;
} mt6735_cpu[] = {
	{ 0x200, 0x25c, 13, 16 },
	{ 0x218, 0x264, 12, 17 },
	{ 0x21c, 0x26c, 11, 18 },
	{ 0x220, 0x274, 10, 19 },
};

static void __iomem *spm;
static DEFINE_SPINLOCK(spm_lock);

static void spm_rmw(u32 off, u32 clr, u32 set)
{
	writel((readl(spm + off) & ~clr) | set, spm + off);
	dsb(sy);
}

static int mt6735_spm_cpu_on(unsigned int cpu)
{
	u32 pc = mt6735_cpu[cpu].pwr_con, l1 = mt6735_cpu[cpu].l1_pdn;
	u32 sta = BIT(mt6735_cpu[cpu].sta_bit), v;
	unsigned long flags;
	int ret;

	spin_lock_irqsave(&spm_lock, flags);
	pr_info("cpu%u: PWR_CON=%#x STATUS=%#x/%#x before power-on\n", cpu,
		readl(spm + pc), readl(spm + SPM_PWR_STATUS), readl(spm + SPM_PWR_STATUS_2ND));

	writel(SPM_PROJECT_KEY, spm + SPM_POWERON_CONFIG_SET);
	spm_rmw(pc, 0, PWR_ON);
	udelay(1);
	spm_rmw(pc, 0, PWR_ON_2ND);

	ret = readl_poll_timeout_atomic(spm + SPM_PWR_STATUS, v, v & sta, 1, 1000);
	if (!ret)
		ret = readl_poll_timeout_atomic(spm + SPM_PWR_STATUS_2ND, v, v & sta, 1, 1000);
	if (ret) {
		pr_err("cpu%u: power status did not come up\n", cpu);
		goto out;
	}

	spm_rmw(pc, PWR_ISO, 0);
	spm_rmw(l1, L1_PDN, 0);
	ret = readl_poll_timeout_atomic(spm + l1, v, !(v & L1_PDN_ACK), 1, 1000);
	if (ret) {
		pr_err("cpu%u: L1 power-down ack did not clear\n", cpu);
		goto out;
	}
	udelay(1);

	spm_rmw(pc, 0, SRAM_ISOINT_B);
	spm_rmw(pc, SRAM_CKISO, 0);
	spm_rmw(pc, PWR_CLK_DIS, 0);
	spm_rmw(pc, 0, PWR_RST_B);	/* release the core */
out:
	spin_unlock_irqrestore(&spm_lock, flags);
	return ret;
}

static int __init mt6735_cpu_init(unsigned int cpu)
{
	if (cpu >= ARRAY_SIZE(mt6735_cpu))
		return -ENODEV;
	return cpu_psci_ops.cpu_init(cpu);
}

static int __init mt6735_cpu_prepare(unsigned int cpu)
{
	if (!spm) {
		spm = ioremap(SPM_BASE, 0x1000);
		if (!spm)
			return -ENOMEM;
	}
	return cpu_psci_ops.cpu_prepare(cpu);
}

static int mt6735_cpu_boot(unsigned int cpu)
{
	int ret = cpu_psci_ops.cpu_boot(cpu);	/* PSCI CPU_ON: ATF records the entry point */

	if (ret) {
		pr_err("cpu%u: PSCI CPU_ON failed: %d\n", cpu, ret);
		return ret;
	}
	return mt6735_spm_cpu_on(cpu);		/* then power the core up via SPM */
}

#ifdef CONFIG_HOTPLUG_CPU
static void mt6735_spm_cpu_off(unsigned int cpu)
{
	u32 pc = mt6735_cpu[cpu].pwr_con, l1 = mt6735_cpu[cpu].l1_pdn;
	u32 sta = BIT(mt6735_cpu[cpu].sta_bit), v;
	unsigned long flags;

	if (readl_poll_timeout(spm + SPM_SLEEP_TIMER_STA, v,
			       v & BIT(mt6735_cpu[cpu].wfi_bit), 10, 100000)) {
		pr_err("cpu%u: not in WFI, leaving it powered\n", cpu);
		return;
	}

	spin_lock_irqsave(&spm_lock, flags);
	writel(SPM_PROJECT_KEY, spm + SPM_POWERON_CONFIG_SET);
	spm_rmw(pc, 0, PWR_ISO);
	spm_rmw(pc, 0, SRAM_CKISO);
	spm_rmw(pc, SRAM_ISOINT_B, 0);
	spm_rmw(l1, 0, L1_PDN);
	if (readl_poll_timeout_atomic(spm + l1, v, v & L1_PDN_ACK, 1, 1000))
		pr_warn("cpu%u: L1 power-down ack timeout\n", cpu);
	spm_rmw(pc, PWR_RST_B, 0);
	spm_rmw(pc, 0, PWR_CLK_DIS);
	spm_rmw(pc, PWR_ON | PWR_ON_2ND, 0);
	if (readl_poll_timeout_atomic(spm + SPM_PWR_STATUS, v, !(v & sta), 1, 1000) ||
	    readl_poll_timeout_atomic(spm + SPM_PWR_STATUS_2ND, v, !(v & sta), 1, 1000))
		pr_warn("cpu%u: power status did not clear\n", cpu);
	spin_unlock_irqrestore(&spm_lock, flags);
}

static bool mt6735_cpu_can_disable(unsigned int cpu)
{
	return cpu_psci_ops.cpu_can_disable(cpu);
}

static int mt6735_cpu_disable(unsigned int cpu)
{
	return cpu_psci_ops.cpu_disable(cpu);
}

static void mt6735_cpu_die(unsigned int cpu)
{
	cpu_psci_ops.cpu_die(cpu);
}

static int mt6735_cpu_kill(unsigned int cpu)
{
	int ret = cpu_psci_ops.cpu_kill(cpu);

	if (!ret)
		mt6735_spm_cpu_off(cpu);
	return ret;
}
#endif

const struct cpu_operations mt6735_smp_ops = {
	.name		= "mediatek,mt6735-smp",
	.cpu_init	= mt6735_cpu_init,
	.cpu_prepare	= mt6735_cpu_prepare,
	.cpu_boot	= mt6735_cpu_boot,
#ifdef CONFIG_HOTPLUG_CPU
	.cpu_can_disable = mt6735_cpu_can_disable,
	.cpu_disable	= mt6735_cpu_disable,
	.cpu_die	= mt6735_cpu_die,
	.cpu_kill	= mt6735_cpu_kill,
#endif
};
